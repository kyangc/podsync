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

function feedRow(overrides: Partial<FeedTomlRow & { public_path: string | null; deleted_at: string | null }> = {}): FeedTomlRow & { public_path?: string | null; deleted_at?: string | null } {
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
    public_path: "/f/feed-secret.xml",
    deleted_at: null,
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
    private_feed: 1,
    page_size: 25,
    title: "Feed",
    description: "Description",
    image_url: null,
    link: "https://www.youtube.com/channel/channel",
    author: null,
    category: null,
    language: null,
    explicit: null,
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

  it("returns 404 for deleted feed status changes", async () => {
    const response = await worker.fetch(adminRequest("/api/admin/feeds/status", { feed_id: "feed", enabled: true }), {
      DB: fakeD1({ tomlFeeds: [feedRow({ enabled: 0, include_in_opml: 0, deleted_at: "2026-07-06 00:00:00" })] }),
    });

    expect(response.status).toBe(404);
  });

  it("does not enable a feed deleted after feed status precheck", async () => {
    const feeds = [feedRow({ enabled: 0, include_in_opml: 0 })];
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/status", { feed_id: "feed", enabled: true }),
      {
        DB: fakeD1({
          tomlFeeds: feeds,
          beforeFeedStatusUpdate(_feedID, options) {
            const feed = options.tomlFeeds?.[0];
            if (feed) {
              feed.deleted_at = "2026-07-06 00:00:00";
              feed.enabled = 0;
            }
          },
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(feeds[0]).toMatchObject({ enabled: 0, deleted_at: "2026-07-06 00:00:00" });
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

  it("requires Cloudflare Access and POST for feed deletion", async () => {
    const noAccess = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feed_id: "feed" }),
      }),
      { DB: fakeD1() },
    );
    expect(noAccess.status).toBe(403);

    const wrongMethod = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/delete", {
        method: "GET",
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      { DB: fakeD1() },
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("validates feed deletion requests and missing feeds", async () => {
    const invalid = await worker.fetch(adminRequest("/api/admin/feeds/delete", { feed_id: "" }), { DB: fakeD1() });
    expect(invalid.status).toBe(400);

    const missing = await worker.fetch(adminRequest("/api/admin/feeds/delete", { feed_id: "missing" }), {
      DB: fakeD1({ tomlFeeds: [feedRow()] }),
    });
    expect(missing.status).toBe(404);
  });

  it("soft deletes a feed, tombstones active episodes, and omits it from NAS config", async () => {
    const feeds = [feedRow()];
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "pending"), episode("pending", { local_episode_id: "pending" })],
      [fakeEpisodeKey("feed", "visible"), episode("visible", { local_episode_id: "visible" })],
      [fakeEpisodeKey("feed", "hidden"), episode("hidden", { local_episode_id: "hidden" })],
      [fakeEpisodeKey("feed", "delete"), episode("delete_pending", { local_episode_id: "delete" })],
      [fakeEpisodeKey("feed", "purged"), episode("purged", { local_episode_id: "purged" })],
      [fakeEpisodeKey("other", "visible"), episode("visible", { feed_id: "other", local_episode_id: "visible" })],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const env = { DB: fakeD1({ tomlFeeds: feeds, episodesByKey, tombstoneChanges }), NAS_TOKEN: nasToken };

    const response = await worker.fetch(adminRequest("/api/admin/feeds/delete", { feed_id: "feed" }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, deleted: true, episodes_marked: 3 });
    expect(feeds[0]).toMatchObject({
      enabled: 0,
      include_in_opml: 0,
      public_path: null,
    });
    expect(feeds[0]!.deleted_at).not.toBeNull();
    expect(episodesByKey.get(fakeEpisodeKey("feed", "pending"))?.status).toBe("delete_pending");
    expect(episodesByKey.get(fakeEpisodeKey("feed", "visible"))?.status).toBe("delete_pending");
    expect(episodesByKey.get(fakeEpisodeKey("feed", "hidden"))?.status).toBe("delete_pending");
    expect(episodesByKey.get(fakeEpisodeKey("feed", "delete"))?.status).toBe("delete_pending");
    expect(episodesByKey.get(fakeEpisodeKey("feed", "purged"))?.status).toBe("purged");
    expect(episodesByKey.get(fakeEpisodeKey("other", "visible"))?.status).toBe("visible");
    expect(tombstoneChanges.map((change) => change.local_episode_id).sort()).toEqual(["hidden", "pending", "visible"]);
    expect(tombstoneChanges.every((change) => change.status === "delete_pending" && change.action === "delete")).toBe(true);

    const config = await worker.fetch(nasConfigRequest(), env);
    expect(config.status).toBe(200);
    await expect(config.text()).resolves.not.toContain('[feeds."feed"]');
  });

  it("treats already deleted feed deletion as idempotent", async () => {
    const feeds = [feedRow({ enabled: 0, include_in_opml: 0, public_path: null, deleted_at: "2026-07-06 00:00:00" })];
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "visible"), episode("visible", { local_episode_id: "visible" })]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/delete", { feed_id: "feed" }),
      { DB: fakeD1({ tomlFeeds: feeds, episodesByKey, tombstoneChanges }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ deleted: false, episodes_marked: 0 });
    expect(episodesByKey.get(fakeEpisodeKey("feed", "visible"))?.status).toBe("visible");
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("rolls back feed deletion when tombstone insert fails", async () => {
    const feeds = [feedRow()];
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "visible"), episode("visible", { local_episode_id: "visible" })]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/delete", { feed_id: "feed" }),
      { DB: fakeD1({ tomlFeeds: feeds, episodesByKey, tombstoneChanges, failTombstoneInsert: true }) },
    );

    expect(response.status).toBe(500);
    expect(feeds[0]).toMatchObject({ enabled: 1, include_in_opml: 1, public_path: "/f/feed-secret.xml", deleted_at: null });
    expect(episodesByKey.get(fakeEpisodeKey("feed", "visible"))?.status).toBe("visible");
    expect(tombstoneChanges).toHaveLength(0);
  });

  it("rolls back feed deletion when batch change assertions fail", async () => {
    const feeds = [feedRow()];
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "visible"), episode("visible", { local_episode_id: "visible" })]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/delete", { feed_id: "feed" }),
      {
        DB: fakeD1({
          tomlFeeds: feeds,
          episodesByKey,
          tombstoneChanges,
          beforeFeedDeleteTombstoneInsert(stagedEpisodes) {
            const row = stagedEpisodes?.get(fakeEpisodeKey("feed", "visible"));
            if (row) row.status = "purged";
          },
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(feeds[0]).toMatchObject({ enabled: 1, include_in_opml: 1, public_path: "/f/feed-secret.xml", deleted_at: null });
    expect(episodesByKey.get(fakeEpisodeKey("feed", "visible"))?.status).toBe("visible");
    expect(tombstoneChanges).toHaveLength(0);
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

  it("rejects episode status changes for deleted feeds and keeps cursor-zero tombstones", async () => {
    const feeds = [feedRow({ deleted_at: "2026-07-06 00:00:00", enabled: 0, include_in_opml: 0, public_path: null })];
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode("delete_pending", { deleted_at: "2026-07-06 00:00:00", purge_after: "2026-07-13 00:00:00" })],
    ]);
    const env = { DB: fakeD1({ tomlFeeds: feeds, episodesByKey }), NAS_TOKEN: nasToken };

    const restore = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      env,
    );

    expect(restore.status).toBe(404);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("delete_pending");

    const tombstones = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/tombstones", {
        headers: { authorization: `Bearer ${nasToken}` },
      }),
      env,
    );
    const body = await tombstones.json() as { changes: Array<{ feed_id: string; local_episode_id: string; status: string; action: string }> };
    expect(body.changes).toContainEqual(expect.objectContaining({
      feed_id: "feed",
      local_episode_id: "episode",
      status: "delete_pending",
      action: "delete",
    }));
  });

  it("does not restore an episode when the feed is deleted after the precheck", async () => {
    const feeds = [feedRow()];
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode("delete_pending", { deleted_at: "2026-07-06 00:00:00", purge_after: "2026-07-13 00:00:00" })],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];
    const bucket = new FakeR2Bucket();
    bucket.existingKeys.add("audio/feed/episode.mp3");
    const response = await worker.fetch(
      adminRequest("/api/admin/episodes/status", { feed_id: "feed", local_episode_id: "episode", action: "restore" }),
      {
        DB: fakeD1({
          tomlFeeds: feeds,
          episodesByKey,
          tombstoneChanges,
          beforeEpisodeStatusUpdate(_key, _row, options) {
            const feed = options.tomlFeeds?.[0];
            if (feed) feed.deleted_at = "2026-07-06 00:00:00";
          },
        }),
        MEDIA_BUCKET: bucket as unknown as R2Bucket,
      },
    );

    expect(response.status).toBe(409);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "episode"))?.status).toBe("delete_pending");
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
