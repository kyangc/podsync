import { describe, expect, it } from "vitest";
import type { FeedTomlRow, PublicFeedRow } from "../src/db";
import worker from "../src/index";
import { sha256Hex } from "../src/tokens";
import { fakeD1, fakeEpisodeKey, type FakeEpisodeRow, type FakeTombstoneChangeRow } from "./fake-d1";

const nasToken = "secret";

function adminRequest(path: string, body: unknown, init: RequestInit = {}): Request {
  const { headers, ...rest } = init;
  return new Request(`https://podcast.example.com${path}`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": "present",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    ...rest,
  });
}

function nasConfigRequest(): Request {
  return new Request("https://podcast.example.com/api/nas/config.toml", {
    headers: { authorization: `Bearer ${nasToken}` },
  });
}

function feedRow(overrides: Partial<FeedTomlRow> = {}): FeedTomlRow {
  return {
    feed_id: "feed",
    provider: "youtube",
    url: "https://www.youtube.com/channel/channel",
    title_override: null,
    description_override: null,
    enabled: 1,
    include_in_opml: 1,
    private_feed: 1,
    update_period: "1h",
    page_size: 25,
    keep_last: 25,
    cookie_profile: null,
    feed_token_hash: "hash",
    ...overrides,
  };
}

function publicFeed(overrides: Partial<PublicFeedRow> = {}): PublicFeedRow {
  return {
    feed_id: "feed",
    provider: "youtube",
    url: "https://www.youtube.com/channel/channel",
    title_override: null,
    description_override: null,
    page_size: 25,
    title: "Feed",
    description: "Description",
    link: "https://www.youtube.com/channel/channel",
    ...overrides,
  };
}

function episode(status: FakeEpisodeRow["status"], overrides: Partial<FakeEpisodeRow> = {}): FakeEpisodeRow {
  return {
    feed_id: "feed",
    provider: "youtube",
    source_episode_id: "episode",
    local_episode_id: "episode",
    source_url: "https://www.youtube.com/watch?v=episode",
    thumbnail: null,
    title: "Episode",
    description: "Description",
    published_at: "2026-07-06T12:00:00Z",
    duration: 123,
    status,
    r2_key: "audio/feed/episode.mp3",
    size: 456,
    mime_type: "audio/mpeg",
    asset_token: "token",
    deleted_at: null,
    purge_after: null,
    updated_at: "2026-07-06 00:00:00",
    ...overrides,
  };
}

class FakeR2Bucket {
  existingKeys = new Set<string>();
  failKeys = new Set<string>();
  headKeys: string[] = [];

  async head(key: string): Promise<unknown | null> {
    this.headKeys.push(key);
    if (this.failKeys.has(key)) throw new Error("head failed");
    return this.existingKeys.has(key) ? { key } : null;
  }
}

describe("admin actions", () => {
  it("requires Cloudflare Access for feed status changes", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feed_id: "feed", enabled: false }),
      }),
      { DB: fakeD1() },
    );

    expect(response.status).toBe(403);
  });

  it("requires POST for feed status changes", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/status", {
        method: "GET",
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      { DB: fakeD1() },
    );

    expect(response.status).toBe(405);
  });

  it("validates feed status request body", async () => {
    const response = await worker.fetch(adminRequest("/api/admin/feeds/status", { feed_id: "feed" }), { DB: fakeD1() });

    expect(response.status).toBe(400);
  });

  it("rejects feed status wrong content type without mutating D1", async () => {
    const feeds = [feedRow()];
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/status", { feed_id: "feed", enabled: false }, { headers: { "content-type": "text/plain" } }),
      { DB: fakeD1({ tomlFeeds: feeds }) },
    );

    expect(response.status).toBe(400);
    expect(feeds[0]!.enabled).toBe(1);
  });

  it("rejects feed status invalid json without mutating D1", async () => {
    const feeds = [feedRow()];
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/status", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": "present",
          "content-type": "application/json",
        },
        body: "{",
      }),
      { DB: fakeD1({ tomlFeeds: feeds }) },
    );

    expect(response.status).toBe(400);
    expect(feeds[0]!.enabled).toBe(1);
  });

  it("rejects feed status oversized body without mutating D1", async () => {
    const feeds = [feedRow()];
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/status", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": "present",
          "content-type": "application/json",
        },
        body: "x".repeat(65 * 1024),
      }),
      { DB: fakeD1({ tomlFeeds: feeds }) },
    );

    expect(response.status).toBe(400);
    expect(feeds[0]!.enabled).toBe(1);
  });

  it("updates feed enabled and include_in_opml flags", async () => {
    const feeds = [feedRow()];
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/status", { feed_id: "feed", enabled: false, include_in_opml: false }),
      { DB: fakeD1({ tomlFeeds: feeds }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ enabled: false, include_in_opml: false });
    expect(feeds[0]!.enabled).toBe(0);
    expect(feeds[0]!.include_in_opml).toBe(0);
  });

  it("returns 404 for missing feed status changes", async () => {
    const response = await worker.fetch(adminRequest("/api/admin/feeds/status", { feed_id: "missing", enabled: false }), {
      DB: fakeD1({ tomlFeeds: [feedRow()] }),
    });

    expect(response.status).toBe(404);
  });

  it("disabled feeds are omitted from NAS config TOML", async () => {
    const feeds = [feedRow()];
    const env = { DB: fakeD1({ tomlFeeds: feeds }), NAS_TOKEN: nasToken };

    const disable = await worker.fetch(adminRequest("/api/admin/feeds/status", { feed_id: "feed", enabled: false }), env);
    expect(disable.status).toBe(200);
    const config = await worker.fetch(nasConfigRequest(), env);

    expect(config.status).toBe(200);
    await expect(config.text()).resolves.not.toContain('[feeds."feed"]');
  });

  it("disabled feeds still serve public RSS", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const feeds = [feedRow({ feed_token_hash: tokenHash })];
    const env = {
      DB: fakeD1({
        tomlFeeds: feeds,
        publicFeedsByHash: new Map([[tokenHash, publicFeed()]]),
      }),
      NAS_TOKEN: nasToken,
    };

    const disable = await worker.fetch(adminRequest("/api/admin/feeds/status", { feed_id: "feed", enabled: false }), env);
    expect(disable.status).toBe(200);
    const response = await worker.fetch(new Request("https://podcast.example.com/f/feed-secret.xml"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/rss+xml");
  });

  it("requires Cloudflare Access for episode status changes", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/episodes/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feed_id: "feed", local_episode_id: "episode", action: "hide" }),
      }),
      { DB: fakeD1() },
    );

    expect(response.status).toBe(403);
  });

  it("requires POST for episode status changes", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/episodes/status", {
        method: "GET",
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      { DB: fakeD1() },
    );

    expect(response.status).toBe(405);
  });

  it("validates episode status request body", async () => {
    const response = await worker.fetch(adminRequest("/api/admin/episodes/status", { feed_id: "feed", action: "hide" }), { DB: fakeD1() });

    expect(response.status).toBe(400);
  });

  it("hides visible episodes and writes one tombstone", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("visible")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "hide" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "hidden", changed: true });
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("hidden");
    expect(tombstoneChanges).toHaveLength(1);
    expect(tombstoneChanges[0]).toMatchObject({ status: "hidden", action: "hide" });
  });

  it("does not duplicate tombstones for repeated hide", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("hidden")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [{ sequence: 10, feed_id: "feed", local_episode_id: "episode", status: "hidden", action: "hide", created_at: "2026-07-06 00:00:00" }];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "hide" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "hidden", changed: false });
    expect(tombstoneChanges).toHaveLength(1);
  });

  it("does not duplicate tombstones for repeated delete", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("delete_pending")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [{ sequence: 10, feed_id: "feed", local_episode_id: "episode", status: "delete_pending", action: "delete", created_at: "2026-07-06 00:00:00" }];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "delete" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "delete_pending", changed: false });
    expect(tombstoneChanges).toHaveLength(1);
  });

  it("deletes hidden episodes and sets purge fields", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("hidden")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "delete" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(200);
    const got = episodesByKey.get(fakeEpisodeKey("feed", "episode"));
    expect(got?.status).toBe("delete_pending");
    expect(got?.deleted_at).not.toBeNull();
    expect(got?.purge_after).not.toBeNull();
    expect(tombstoneChanges[0]).toMatchObject({ status: "delete_pending", action: "delete" });
  });

  it("restores delete_pending episodes and clears purge fields", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode("delete_pending", { deleted_at: "2026-07-06 00:00:00", purge_after: "2026-07-13 00:00:00" })],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const bucket = new FakeR2Bucket();
    bucket.existingKeys.add("audio/feed/episode.mp3");
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }), MEDIA_BUCKET: bucket as unknown as R2Bucket },
    );

    expect(response.status).toBe(200);
    expect(bucket.headKeys).toEqual(["audio/feed/episode.mp3"]);
    const got = episodesByKey.get(fakeEpisodeKey("feed", "episode"));
    expect(got?.status).toBe("visible");
    expect(got?.deleted_at).toBeNull();
    expect(got?.purge_after).toBeNull();
    expect(tombstoneChanges[0]).toMatchObject({ status: "visible", action: "restore" });
  });

  it("restores delete_pending episodes without bucket when r2 key is null or empty", async () => {
    for (const r2Key of [null, ""]) {
      const episodesByKey = new Map([
        [fakeEpisodeKey("feed", "episode"), episode("delete_pending", {
          r2_key: r2Key,
          deleted_at: "2026-07-06 00:00:00",
          purge_after: "2026-07-13 00:00:00",
        })],
      ]);
      const tombstoneChanges: FakeTombstoneChangeRow[] = [];
      const response = await worker.fetch(
        adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
        { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
      );

      expect(response.status, String(r2Key)).toBe(200);
      expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("visible");
      expect(tombstoneChanges).toHaveLength(1);
      expect(tombstoneChanges[0]).toMatchObject({ status: "visible", action: "restore" });
    }
  });

  it("rejects delete_pending restore when the media object is missing", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode("delete_pending", { deleted_at: "2026-07-06 00:00:00", purge_after: "2026-07-13 00:00:00" })],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const bucket = new FakeR2Bucket();
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }), MEDIA_BUCKET: bucket as unknown as R2Bucket },
    );

    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toBe("media object not found");
    expect(bucket.headKeys).toEqual(["audio/feed/episode.mp3"]);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))).toMatchObject({
      status: "delete_pending",
      deleted_at: "2026-07-06 00:00:00",
      purge_after: "2026-07-13 00:00:00",
    });
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("rejects delete_pending restore when media bucket is unavailable", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode("delete_pending", { deleted_at: "2026-07-06 00:00:00", purge_after: "2026-07-13 00:00:00" })],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("media bucket unavailable");
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))).toMatchObject({
      status: "delete_pending",
      deleted_at: "2026-07-06 00:00:00",
      purge_after: "2026-07-13 00:00:00",
    });
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("rejects delete_pending restore when media head fails", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode("delete_pending", { deleted_at: "2026-07-06 00:00:00", purge_after: "2026-07-13 00:00:00" })],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const bucket = new FakeR2Bucket();
    bucket.failKeys.add("audio/feed/episode.mp3");
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }), MEDIA_BUCKET: bucket as unknown as R2Bucket },
    );

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe("media object check failed");
    expect(bucket.headKeys).toEqual(["audio/feed/episode.mp3"]);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))).toMatchObject({
      status: "delete_pending",
      deleted_at: "2026-07-06 00:00:00",
      purge_after: "2026-07-13 00:00:00",
    });
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("restores hidden episodes without media bucket", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode("hidden")],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(200);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("visible");
    expect(tombstoneChanges[0]).toMatchObject({ status: "visible", action: "restore" });
  });

  it("does not head media for hidden or already visible restore", async () => {
    for (const status of ["hidden", "visible"] as const) {
      const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode(status)]]);
      const tombstoneChanges: FakeTombstoneChangeRow[] = [];
      const bucket = new FakeR2Bucket();
      bucket.existingKeys.add("audio/feed/episode.mp3");
      const response = await worker.fetch(
        adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
        { DB: fakeD1({ episodesByKey, tombstoneChanges }), MEDIA_BUCKET: bucket as unknown as R2Bucket },
      );

      expect(response.status, status).toBe(200);
      expect(bucket.headKeys).toEqual([]);
    }
  });

  it("does not duplicate tombstones for repeated restore", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("visible")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [{ sequence: 10, feed_id: "feed", local_episode_id: "episode", status: "visible", action: "restore", created_at: "2026-07-06 00:00:00" }];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "visible", changed: false });
    expect(tombstoneChanges).toHaveLength(1);
  });

  it("rejects restoring purged episodes", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("purged")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(409);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("purged");
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("returns 404 for missing episodes", async () => {
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "missing", action: "hide" }),
      { DB: fakeD1({ episodesByKey: new Map() }) },
    );

    expect(response.status).toBe(404);
  });

  it("does not write tombstone when conditional status update loses a race", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("visible")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "hide" }),
      {
        DB: fakeD1({
          episodesByKey,
          tombstoneChanges,
          beforeEpisodeStatusUpdate(_key, row) {
            if (row) row.status = "delete_pending";
          },
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("delete_pending");
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("does not restore when hidden episode becomes delete_pending before update", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("hidden")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      {
        DB: fakeD1({
          episodesByKey,
          tombstoneChanges,
          beforeEpisodeStatusUpdate(_key, row) {
            if (row) row.status = "delete_pending";
          },
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("delete_pending");
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("does not restore when delete_pending r2 key changes after head succeeds", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("delete_pending")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const bucket = new FakeR2Bucket();
    bucket.existingKeys.add("audio/feed/episode.mp3");
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      {
        DB: fakeD1({
          episodesByKey,
          tombstoneChanges,
          beforeEpisodeStatusUpdate(_key, row) {
            if (row) row.r2_key = "audio/feed/changed.mp3";
          },
        }),
        MEDIA_BUCKET: bucket as unknown as R2Bucket,
      },
    );

    expect(response.status).toBe(409);
    expect(bucket.headKeys).toEqual(["audio/feed/episode.mp3"]);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))).toMatchObject({
      status: "delete_pending",
      r2_key: "audio/feed/changed.mp3",
    });
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("rolls back episode status when tombstone insert fails", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "episode"), episode("visible")]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "hide" }),
      { DB: fakeD1({ episodesByKey, tombstoneChanges, failTombstoneInsert: true }) },
    );

    expect(response.status).toBe(500);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("visible");
    expect(tombstoneChanges).toHaveLength(0);
  });
});
