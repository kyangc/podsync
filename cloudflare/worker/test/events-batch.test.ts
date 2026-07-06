import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { fakeD1, fakeEventKey, type FakeEventRow, type FakeSyncRunRow } from "./fake-d1";

const token = "secret-token";

function batchRequest(body: unknown, init: RequestInit = {}): Request {
  const { headers, ...rest } = init;
  return new Request("https://podcast.example.com/api/nas/events/batch", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    ...rest,
  });
}

function batchBody(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      id: "run-1",
      started_at: "2026-07-06T12:00:00Z",
      finished_at: "2026-07-06T12:05:00Z",
      status: "success",
      feeds_updated: 1,
      episodes_downloaded: 2,
      episodes_uploaded: 2,
      errors_count: 0,
    },
    events: [
      {
        sequence: 1,
        event_time: "2026-07-06T12:00:01Z",
        level: "info",
        type: "sync_run_started",
        message: "started",
      },
    ],
    ...overrides,
  };
}

describe("NAS event batch API", () => {
  it("requires NAS auth for event batches", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/events/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batchBody()),
      }),
      { DB: fakeD1() },
    );

    expect(response.status).toBe(401);
  });

  it("requires POST for event batches", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/events/batch", {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
      { DB: fakeD1(), NAS_TOKEN: token },
    );

    expect(response.status).toBe(405);
  });

  it("validates event batch content type and JSON", async () => {
    const wrongType = await worker.fetch(
      batchRequest(batchBody(), { headers: { "content-type": "text/plain" } }),
      { DB: fakeD1(), NAS_TOKEN: token },
    );
    expect(wrongType.status).toBe(400);

    const invalidJson = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/events/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{",
      }),
      { DB: fakeD1(), NAS_TOKEN: token },
    );
    expect(invalidJson.status).toBe(400);
  });

  it("validates run summary and event fields", async () => {
    for (const body of [
      batchBody({ run: { ...(batchBody().run as Record<string, unknown>), status: "bad" } }),
      batchBody({ run: { ...(batchBody().run as Record<string, unknown>), feeds_updated: -1 } }),
      batchBody({ events: [{ sequence: 0, event_time: "2026-07-06T12:00:01Z", level: "info", type: "sync_run_started" }] }),
      batchBody({ events: [{ sequence: 1, event_time: "2026-07-06T12:00:01Z", level: "loud", type: "sync_run_started" }] }),
      batchBody({ events: [{ sequence: 1, event_time: "2026-07-06T12:00:01Z", level: "info", type: "not_allowed" }] }),
    ]) {
      const response = await worker.fetch(batchRequest(body), { DB: fakeD1(), NAS_TOKEN: token });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("rejects JS-only date strings that SQLite datetime cannot order", async () => {
    for (const body of [
      batchBody({ run: { ...(batchBody().run as Record<string, unknown>), started_at: "Mon Jul 06 2026 12:00:00 GMT" } }),
      batchBody({ run: { ...(batchBody().run as Record<string, unknown>), started_at: "2026-02-30T00:00:00Z" } }),
      batchBody({ run: { ...(batchBody().run as Record<string, unknown>), started_at: "2026-07-06T12:00:00.123Z" } }),
      batchBody({ events: [{ sequence: 1, event_time: "Mon Jul 06 2026 12:00:00 GMT", level: "info", type: "sync_run_started" }] }),
      batchBody({ events: [{ sequence: 1, event_time: "2026-07-06T12:00:00.123Z", level: "info", type: "sync_run_started" }] }),
    ]) {
      const response = await worker.fetch(batchRequest(body), { DB: fakeD1(), NAS_TOKEN: token });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("rejects invalid status and finished_at combinations", async () => {
    for (const body of [
      batchBody({ run: { ...(batchBody().run as Record<string, unknown>), status: "running", finished_at: "2026-07-06T12:05:00Z" } }),
      batchBody({ run: { ...(batchBody().run as Record<string, unknown>), status: "success", finished_at: null } }),
      batchBody({ run: { ...(batchBody().run as Record<string, unknown>), started_at: "2026-07-06T12:05:00Z", finished_at: "2026-07-06T12:00:00Z" } }),
    ]) {
      const response = await worker.fetch(batchRequest(body), { DB: fakeD1(), NAS_TOKEN: token });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("rejects duplicate event sequences within one batch", async () => {
    const response = await worker.fetch(
      batchRequest(batchBody({
        events: [
          { sequence: 1, event_time: "2026-07-06T12:00:01Z", level: "info", type: "sync_run_started" },
          { sequence: 1, event_time: "2026-07-06T12:00:02Z", level: "info", type: "remote_config_fetched" },
        ],
      })),
      { DB: fakeD1(), NAS_TOKEN: token },
    );

    expect(response.status).toBe(400);
  });

  it("rejects oversized event batches and overlong strings", async () => {
    const oversizedEvents = Array.from({ length: 101 }, (_, index) => ({
      sequence: index + 1,
      event_time: "2026-07-06T12:00:01Z",
      level: "info",
      type: "sync_run_started",
    }));
    const oversized = await worker.fetch(
      batchRequest(batchBody({ events: oversizedEvents })),
      { DB: fakeD1(), NAS_TOKEN: token },
    );
    expect(oversized.status).toBe(400);

    const overlong = await worker.fetch(
      batchRequest(batchBody({
        events: [{ sequence: 1, event_time: "2026-07-06T12:00:01Z", level: "info", type: "sync_run_started", message: "x".repeat(513) }],
      })),
      { DB: fakeD1(), NAS_TOKEN: token },
    );
    expect(overlong.status).toBe(400);

    const tooLargeBody = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/events/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "x".repeat(65 * 1024),
      }),
      { DB: fakeD1(), NAS_TOKEN: token },
    );
    expect(tooLargeBody.status).toBe(400);
  });

  it("upserts a sync run and inserts events", async () => {
    const syncRunsByID = new Map<string, FakeSyncRunRow>();
    const eventsByKey = new Map<string, FakeEventRow>();
    const response = await worker.fetch(
      batchRequest(batchBody({
        events: [
          { sequence: 1, event_time: "2026-07-06T12:00:01Z", level: "info", type: "sync_run_started", message: "started" },
          { sequence: 2, event_time: "2026-07-06T12:03:01Z", level: "info", type: "episode_upload_finished", feed_id: "bili", local_episode_id: "BV1" },
        ],
      })),
      { DB: fakeD1({ syncRunsByID, eventsByKey }), NAS_TOKEN: token },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      run_id: "run-1",
      accepted_events: 2,
      inserted_events: 2,
      duplicate_events: 0,
    });
    expect(syncRunsByID.get("run-1")).toMatchObject({ status: "success", episodes_uploaded: 2 });
    expect(eventsByKey.get(fakeEventKey("run-1", 2))).toMatchObject({
      type: "episode_upload_finished",
      feed_id: "bili",
      local_episode_id: "BV1",
    });
  });

  it("uses conflict-safe sync run and event insert SQL", async () => {
    const sqlLog: string[] = [];
    const response = await worker.fetch(batchRequest(batchBody()), {
      DB: fakeD1({ sqlLog }),
      NAS_TOKEN: token,
    });

    expect(response.status).toBe(200);
    const sql = sqlLog.join("\n");
    expect(sql).toContain("ON CONFLICT(id) DO UPDATE");
    expect(sql).toContain("CASE");
    expect(sql).toContain("max(sync_runs.feeds_updated, excluded.feeds_updated)");
    expect(sql).toContain("INSERT OR IGNORE INTO events");
  });

  it("ignores duplicate events on retry", async () => {
    const syncRunsByID = new Map<string, FakeSyncRunRow>();
    const eventsByKey = new Map<string, FakeEventRow>();
    const env = { DB: fakeD1({ syncRunsByID, eventsByKey }), NAS_TOKEN: token };
    const first = await worker.fetch(batchRequest(batchBody()), env);
    const second = await worker.fetch(batchRequest(batchBody()), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      accepted_events: 1,
      inserted_events: 0,
      duplicate_events: 1,
    });
    expect(eventsByKey.size).toBe(1);
  });

  it("does not regress a final sync run to running", async () => {
    const syncRunsByID = new Map<string, FakeSyncRunRow>();
    const env = { DB: fakeD1({ syncRunsByID }), NAS_TOKEN: token };
    const final = await worker.fetch(batchRequest(batchBody()), env);
    const staleRunning = await worker.fetch(
      batchRequest(batchBody({
        run: {
          id: "run-1",
          started_at: "2026-07-06T11:59:00Z",
          finished_at: null,
          status: "running",
          feeds_updated: 3,
          episodes_downloaded: 4,
          episodes_uploaded: 5,
          errors_count: 6,
        },
        events: [],
      })),
      env,
    );

    expect(final.status).toBe(200);
    expect(staleRunning.status).toBe(200);
    expect(syncRunsByID.get("run-1")).toMatchObject({
      status: "success",
      started_at: "2026-07-06T12:00:00Z",
      finished_at: "2026-07-06T12:05:00Z",
      feeds_updated: 3,
      episodes_downloaded: 4,
      episodes_uploaded: 5,
      errors_count: 6,
    });
  });

  it("does not let stale retries change final sync run finished_at", async () => {
    const syncRunsByID = new Map<string, FakeSyncRunRow>();
    const env = { DB: fakeD1({ syncRunsByID }), NAS_TOKEN: token };
    const final = await worker.fetch(batchRequest(batchBody()), env);
    const laterFinal = await worker.fetch(
      batchRequest(batchBody({
        run: {
          id: "run-1",
          started_at: "2026-07-06T12:10:00Z",
          finished_at: "2026-07-06T12:15:00Z",
          status: "failed",
          feeds_updated: 7,
          episodes_downloaded: 8,
          episodes_uploaded: 9,
          errors_count: 10,
        },
        events: [],
      })),
      env,
    );

    expect(final.status).toBe(200);
    expect(laterFinal.status).toBe(200);
    expect(syncRunsByID.get("run-1")).toMatchObject({
      status: "success",
      started_at: "2026-07-06T12:00:00Z",
      finished_at: "2026-07-06T12:05:00Z",
      feeds_updated: 7,
      episodes_downloaded: 8,
      episodes_uploaded: 9,
      errors_count: 10,
    });
  });

  it("allows an empty event array while updating run summary", async () => {
    const syncRunsByID = new Map<string, FakeSyncRunRow>();
    const eventsByKey = new Map<string, FakeEventRow>();
    const response = await worker.fetch(
      batchRequest(batchBody({ events: [] })),
      { DB: fakeD1({ syncRunsByID, eventsByKey }), NAS_TOKEN: token },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted_events: 0,
      inserted_events: 0,
      duplicate_events: 0,
    });
    expect(syncRunsByID.has("run-1")).toBe(true);
    expect(eventsByKey.size).toBe(0);
  });
});
