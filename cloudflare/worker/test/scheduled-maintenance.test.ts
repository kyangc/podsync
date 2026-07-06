import { describe, expect, it } from "vitest";
import worker, { runScheduledMaintenance } from "../src/index";
import type { Env } from "../src/env";
import { fakeD1, fakeEpisodeKey, fakeEventKey, type FakeEpisodeRow, type FakeEventRow, type FakeSyncRunRow, type FakeTombstoneChangeRow } from "./fake-d1";

function episode(overrides: Partial<FakeEpisodeRow> = {}): FakeEpisodeRow {
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
    status: "delete_pending",
    r2_key: "audio/feed/episode.mp3",
    size: 456,
    mime_type: "audio/mpeg",
    asset_token: "token",
    deleted_at: "2026-06-29 00:00:00",
    purge_after: "2026-07-06 00:00:00",
    updated_at: "2026-07-06 00:00:00",
    ...overrides,
  };
}

function eventRow(overrides: Partial<FakeEventRow> = {}): FakeEventRow {
  return {
    run_id: "run",
    sequence: 1,
    event_time: "2026-07-06T12:00:00Z",
    level: "info",
    type: "sync_run_started",
    feed_id: null,
    local_episode_id: null,
    message: null,
    error_code: null,
    error_detail: null,
    ...overrides,
  };
}

function syncRun(overrides: Partial<FakeSyncRunRow> = {}): FakeSyncRunRow {
  return {
    id: "run",
    started_at: "2026-07-06T12:00:00Z",
    finished_at: "2026-07-06T12:05:00Z",
    status: "success",
    feeds_updated: 1,
    episodes_downloaded: 1,
    episodes_uploaded: 1,
    errors_count: 0,
    ...overrides,
  };
}

class FakeR2Bucket {
  deletedKeys: string[] = [];
  failKeys = new Set<string>();

  async delete(key: string): Promise<void> {
    if (this.failKeys.has(key)) throw new Error("delete failed");
    this.deletedKeys.push(key);
  }
}

describe("scheduled maintenance", () => {
  it("deletes old events and completed sync runs", async () => {
    const eventsByKey = new Map([
      [fakeEventKey("old-event", 1), eventRow({ run_id: "old-event", event_time: "2026-06-05T12:00:00Z" })],
      [fakeEventKey("new-event", 1), eventRow({ run_id: "new-event", event_time: "2026-06-20T12:00:00Z" })],
    ]);
    const syncRunsByID = new Map([
      ["old-complete", syncRun({ id: "old-complete", started_at: "2025-12-01T12:00:00Z", finished_at: "2025-12-01T12:05:00Z" })],
      ["new-complete", syncRun({ id: "new-complete", started_at: "2026-06-01T12:00:00Z", finished_at: "2026-06-01T12:05:00Z" })],
      ["old-running", syncRun({ id: "old-running", started_at: "2025-12-01T12:00:00Z", finished_at: null, status: "running" })],
    ]);

    const result = await runScheduledMaintenance(
      { DB: fakeD1({ eventsByKey, syncRunsByID }) },
      new Date("2026-07-06T12:00:00Z"),
    );

    expect(result.old_events_deleted).toBe(1);
    expect(result.old_sync_runs_deleted).toBe(1);
    expect(eventsByKey.has(fakeEventKey("old-event", 1))).toBe(false);
    expect(eventsByKey.has(fakeEventKey("new-event", 1))).toBe(true);
    expect(syncRunsByID.has("old-complete")).toBe(false);
    expect(syncRunsByID.has("new-complete")).toBe(true);
    expect(syncRunsByID.has("old-running")).toBe(true);
  });

  it("purges due R2 objects and writes a purge tombstone", async () => {
    const bucket = new FakeR2Bucket();
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode()],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];

    const result = await runScheduledMaintenance(
      { DB: fakeD1({ episodesByKey, tombstoneChanges }), MEDIA_BUCKET: bucket as unknown as R2Bucket },
      new Date("2026-07-06T12:00:00Z"),
    );

    const got = episodesByKey.get(fakeEpisodeKey("feed", "episode"));
    expect(bucket.deletedKeys).toEqual(["audio/feed/episode.mp3"]);
    expect(got?.status).toBe("purged");
    expect(got?.purge_after).toBeNull();
    expect(tombstoneChanges).toHaveLength(1);
    expect(tombstoneChanges[0]).toMatchObject({ feed_id: "feed", local_episode_id: "episode", status: "purged", action: "purge" });
    expect(result.episodes_purged).toBe(1);
    expect(result.purge_errors).toBe(0);
  });

  it("keeps processing later candidates after an R2 delete failure", async () => {
    const bucket = new FakeR2Bucket();
    bucket.failKeys.add("audio/feed/fail.mp3");
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "fail"), episode({ local_episode_id: "fail", source_episode_id: "fail", r2_key: "audio/feed/fail.mp3" })],
      [fakeEpisodeKey("feed", "ok"), episode({ local_episode_id: "ok", source_episode_id: "ok", r2_key: "audio/feed/ok.mp3" })],
    ]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];

    const result = await runScheduledMaintenance(
      { DB: fakeD1({ episodesByKey, tombstoneChanges }), MEDIA_BUCKET: bucket as unknown as R2Bucket },
      new Date("2026-07-06T12:00:00Z"),
    );

    expect(episodesByKey.get(fakeEpisodeKey("feed", "fail"))?.status).toBe("delete_pending");
    expect(episodesByKey.get(fakeEpisodeKey("feed", "ok"))?.status).toBe("purged");
    expect(bucket.deletedKeys).toEqual(["audio/feed/ok.mp3"]);
    expect(tombstoneChanges).toHaveLength(1);
    expect(tombstoneChanges[0]).toMatchObject({ local_episode_id: "ok", status: "purged", action: "purge" });
    expect(result.episodes_purged).toBe(1);
    expect(result.purge_errors).toBe(1);
  });

  it("does not write a tombstone when the D1 purge update races", async () => {
    const bucket = new FakeR2Bucket();
    const key = fakeEpisodeKey("feed", "episode");
    const episodesByKey = new Map([[key, episode()]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];

    const result = await runScheduledMaintenance(
      {
        DB: fakeD1({ episodesByKey, tombstoneChanges, failPurgeUpdateKeys: new Set([key]) }),
        MEDIA_BUCKET: bucket as unknown as R2Bucket,
      },
      new Date("2026-07-06T12:00:00Z"),
    );

    expect(bucket.deletedKeys).toEqual(["audio/feed/episode.mp3"]);
    expect(episodesByKey.get(key)?.status).toBe("delete_pending");
    expect(tombstoneChanges).toHaveLength(0);
    expect(result.episodes_purged).toBe(0);
    expect(result.purge_errors).toBe(1);
  });

  it("skips media candidates when the R2 binding is missing", async () => {
    const key = fakeEpisodeKey("feed", "episode");
    const episodesByKey = new Map([[key, episode()]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];

    const result = await runScheduledMaintenance(
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
      new Date("2026-07-06T12:00:00Z"),
    );

    expect(episodesByKey.get(key)?.status).toBe("delete_pending");
    expect(tombstoneChanges).toHaveLength(0);
    expect(result.episodes_purged).toBe(0);
    expect(result.purge_errors).toBe(1);
  });

  it("purges due rows without an R2 key without requiring a bucket", async () => {
    const key = fakeEpisodeKey("feed", "episode");
    const episodesByKey = new Map([[key, episode({ r2_key: null })]]);
    const tombstoneChanges: FakeTombstoneChangeRow[] = [];

    const result = await runScheduledMaintenance(
      { DB: fakeD1({ episodesByKey, tombstoneChanges }) },
      new Date("2026-07-06T12:00:00Z"),
    );

    expect(episodesByKey.get(key)?.status).toBe("purged");
    expect(tombstoneChanges).toHaveLength(1);
    expect(tombstoneChanges[0]).toMatchObject({ status: "purged", action: "purge" });
    expect(result.episodes_purged).toBe(1);
    expect(result.purge_errors).toBe(0);
  });

  it("registers scheduled maintenance through waitUntil", async () => {
    const bucket = new FakeR2Bucket();
    const key = fakeEpisodeKey("feed", "episode");
    const episodesByKey = new Map([[key, episode()]]);
    const promises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        promises.push(promise);
      },
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    await worker.scheduled({} as ScheduledController, {
      DB: fakeD1({ episodesByKey }),
      MEDIA_BUCKET: bucket as unknown as R2Bucket,
    } satisfies Env, ctx);
    await Promise.all(promises);

    expect(promises).toHaveLength(1);
    expect(episodesByKey.get(key)?.status).toBe("purged");
    expect(bucket.deletedKeys).toEqual(["audio/feed/episode.mp3"]);
  });
});
