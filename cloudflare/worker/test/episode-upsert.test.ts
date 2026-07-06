import { describe, expect, it } from "vitest";
import type { FakeEpisodeRow } from "./fake-d1";
import worker from "../src/index";
import { fakeD1, fakeEpisodeKey } from "./fake-d1";

const token = "secret-token";

function upsertRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request("https://podcast.example.com/api/nas/episodes/upsert", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function upsertBody(overrides: Record<string, unknown> = {}) {
  return {
    feed_id: "feed",
    provider: "youtube",
    source_episode_id: "video",
    local_episode_id: "video",
    source_url: "https://www.youtube.com/watch?v=video",
    thumbnail: "https://img.example.com/video.jpg",
    title: "Episode",
    description: "Description",
    published_at: "2026-07-06T12:00:00Z",
    duration: 123,
    r2_key: "audio/feed/video-token.mp3",
    size: 456,
    mime_type: "audio/mpeg",
    asset_token: "token",
    ...overrides,
  };
}

function env(options: Parameters<typeof fakeD1>[0] = {}) {
  return {
    DB: fakeD1({
      feedsByID: new Map([["feed", { feed_id: "feed", provider: "youtube" }]]),
      ...options,
    }),
    NAS_TOKEN: token,
  };
}

function fakeEpisode(status: FakeEpisodeRow["status"]): FakeEpisodeRow {
  return {
    feed_id: "feed",
    provider: "youtube",
    source_episode_id: "old",
    local_episode_id: "video",
    source_url: null,
    thumbnail: null,
    title: null,
    description: null,
    published_at: null,
    duration: null,
    status,
    r2_key: "audio/feed/old.mp3",
    size: 1,
    mime_type: "audio/mpeg",
    asset_token: "old",
  };
}

describe("episode upsert NAS API", () => {
  it("requires NAS auth for episode upsert", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/episodes/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(upsertBody()),
      }),
      {
        DB: fakeD1(),
      },
    );

    expect(response.status).toBe(401);
  });

  it("requires POST for episode upsert", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/episodes/upsert", {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
      env(),
    );

    expect(response.status).toBe(405);
  });

  it("validates episode upsert body", async () => {
    const response = await worker.fetch(upsertRequest(upsertBody({ r2_key: "" })), env());

    expect(response.status).toBe(400);
  });

  it("rejects invalid r2_key before writing episode state", async () => {
    const episodesByKey = new Map<string, FakeEpisodeRow>();
    const response = await worker.fetch(upsertRequest(upsertBody({ r2_key: "../bad.mp3" })), env({ episodesByKey }));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("r2_key");
    expect(episodesByKey.size).toBe(0);
  });

  it("rejects oversized episode upsert body", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/episodes/upsert", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "x".repeat(65 * 1024),
      }),
      env(),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("too large");
  });

  it("rejects wrong content type", async () => {
    const response = await worker.fetch(
      upsertRequest(upsertBody(), {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
        },
      }),
      env(),
    );

    expect(response.status).toBe(400);
  });

  it("rejects unparsable published_at", async () => {
    const response = await worker.fetch(upsertRequest(upsertBody({ published_at: "not-a-date" })), env());

    expect(response.status).toBe(400);
  });

  it("inserts a new visible episode", async () => {
    const episodesByKey = new Map<string, FakeEpisodeRow>();
    const response = await worker.fetch(upsertRequest(upsertBody()), env({ episodesByKey }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "visible" });
    const episode = episodesByKey.get(fakeEpisodeKey("feed", "video"));
    expect(episode?.status).toBe("visible");
    expect(episode?.r2_key).toBe("audio/feed/video-token.mp3");
    expect(episode?.size).toBe(456);
  });

  it("updates a visible episode idempotently", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "video"), fakeEpisode("visible")]]);

    const response = await worker.fetch(upsertRequest(upsertBody({ title: "Updated" })), env({ episodesByKey }));

    expect(response.status).toBe(200);
    const episode = episodesByKey.get(fakeEpisodeKey("feed", "video"));
    expect(episode?.status).toBe("visible");
    expect(episode?.title).toBe("Updated");
  });

  it("updates pending to visible", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "video"), fakeEpisode("pending")]]);

    const response = await worker.fetch(upsertRequest(upsertBody()), env({ episodesByKey }));

    expect(response.status).toBe(200);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "video"))?.status).toBe("visible");
  });

  it("keeps hidden/delete_pending/purged episodes protected", async () => {
    for (const status of ["hidden", "delete_pending", "purged"] as const) {
      const episodesByKey = new Map([[fakeEpisodeKey("feed", "video"), fakeEpisode(status)]]);

      const response = await worker.fetch(upsertRequest(upsertBody()), env({ episodesByKey }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status });
      expect(episodesByKey.get(fakeEpisodeKey("feed", "video"))?.status).toBe(status);
    }
  });

  it("uses CASE status protection during update", async () => {
    const sqlLog: string[] = [];

    const response = await worker.fetch(upsertRequest(upsertBody()), env({ sqlLog }));

    expect(response.status).toBe(200);
    expect(sqlLog.join("\n")).toContain("ON CONFLICT(feed_id, local_episode_id) DO UPDATE");
    expect(sqlLog.join("\n")).toContain("CASE");
  });

  it("does not trust a stale pre-update status read", async () => {
    const episodesByKey = new Map([[fakeEpisodeKey("feed", "video"), fakeEpisode("pending")]]);

    const response = await worker.fetch(
      upsertRequest(upsertBody()),
      env({
        episodesByKey,
        beforeEpisodeUpsert(key) {
          const episode = episodesByKey.get(key);
          if (episode) episode.status = "hidden";
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(episodesByKey.get(fakeEpisodeKey("feed", "video"))?.status).toBe("hidden");
  });

  it("rejects provider mismatch", async () => {
    const response = await worker.fetch(upsertRequest(upsertBody({ provider: "bilibili" })), env());

    expect(response.status).toBe(400);
  });

  it("returns 404 for missing feed", async () => {
    const response = await worker.fetch(upsertRequest(upsertBody()), env({ feedsByID: new Map() }));

    expect(response.status).toBe(404);
  });
});
