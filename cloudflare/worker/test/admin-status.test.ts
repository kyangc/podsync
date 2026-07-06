import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { fakeD1, fakeEventKey, type FakeEventRow, type FakeSyncRunRow } from "./fake-d1";

function adminGet(path: string, init: RequestInit = {}): Request {
  const { headers, ...rest } = init;
  return new Request(`https://podcast.example.com${path}`, {
    method: "GET",
    headers: {
      "cf-access-jwt-assertion": "present",
      ...headers,
    },
    ...rest,
  });
}

function syncRun(overrides: Partial<FakeSyncRunRow> = {}): FakeSyncRunRow {
  return {
    id: "run-1",
    started_at: "2026-07-06T12:00:00Z",
    finished_at: "2026-07-06T12:05:00Z",
    status: "success",
    feeds_updated: 1,
    episodes_downloaded: 2,
    episodes_uploaded: 2,
    errors_count: 0,
    ...overrides,
  };
}

function event(overrides: Partial<FakeEventRow> = {}): FakeEventRow {
  return {
    run_id: "run-1",
    sequence: 1,
    event_time: "2026-07-06T12:00:01Z",
    level: "info",
    type: "sync_run_started",
    feed_id: null,
    local_episode_id: null,
    message: "started",
    error_code: null,
    error_detail: null,
    ...overrides,
  };
}

describe("admin status read APIs", () => {
  it("requires Cloudflare Access for admin sync runs", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/api/admin/sync-runs"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(403);
  });

  it("requires Cloudflare Access for admin events", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/api/admin/events"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(403);
  });

  it("requires GET for admin sync runs and events", async () => {
    for (const path of ["/api/admin/sync-runs", "/api/admin/events"]) {
      const response = await worker.fetch(
        new Request(`https://podcast.example.com${path}`, {
          method: "POST",
          headers: { "cf-access-jwt-assertion": "present" },
        }),
        { DB: fakeD1() },
      );

      expect(response.status, path).toBe(405);
    }
  });

  it("lists recent sync runs with limit and offset", async () => {
    const syncRunsByID = new Map([
      ["old", syncRun({ id: "old", started_at: "2026-07-06T10:00:00Z" })],
      ["tie-b", syncRun({ id: "tie-b", started_at: "2026-07-06T11:00:00Z" })],
      ["tie-a", syncRun({ id: "tie-a", started_at: "2026-07-06T11:00:00Z" })],
      ["new", syncRun({ id: "new", started_at: "2026-07-06T12:00:00Z", status: "failed", errors_count: 2 })],
    ]);
    const response = await worker.fetch(adminGet("/api/admin/sync-runs?limit=2&offset=1"), {
      DB: fakeD1({ syncRunsByID }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { limit: number; offset: number; sync_runs: Array<{ id: string; status: string; errors_count: number }> };
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.sync_runs).toEqual([
      expect.objectContaining({ id: "tie-b" }),
      expect.objectContaining({ id: "tie-a" }),
    ]);
  });

  it("lists recent events with limit and offset", async () => {
    const eventsByKey = new Map([
      [fakeEventKey("run-1", 1), event({ run_id: "run-1", sequence: 1, event_time: "2026-07-06T12:00:00Z" })],
      [fakeEventKey("run-2", 1), event({ run_id: "run-2", sequence: 1, event_time: "2026-07-06T12:01:00Z", type: "remote_config_fetched" })],
      [fakeEventKey("run-2", 2), event({ run_id: "run-2", sequence: 2, event_time: "2026-07-06T12:01:00Z", type: "episode_upload_finished", feed_id: "bili" })],
      [fakeEventKey("run-3", 1), event({ run_id: "run-3", sequence: 1, event_time: "2026-07-06T12:02:00Z", level: "error", type: "remote_api_failed" })],
    ]);
    const response = await worker.fetch(adminGet("/api/admin/events?limit=2&offset=1"), {
      DB: fakeD1({ eventsByKey }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { limit: number; offset: number; events: Array<{ run_id: string; sequence: number; type: string; feed_id: string | null }> };
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.events).toEqual([
      expect.objectContaining({ run_id: "run-2", sequence: 2, type: "episode_upload_finished", feed_id: "bili" }),
      expect.objectContaining({ run_id: "run-2", sequence: 1, type: "remote_config_fetched" }),
    ]);
  });

  it("validates admin status list params", async () => {
    for (const path of [
      "/api/admin/sync-runs?limit=0",
      "/api/admin/sync-runs?limit=201",
      "/api/admin/sync-runs?offset=-1",
      "/api/admin/events?limit=0",
      "/api/admin/events?limit=201",
      "/api/admin/events?offset=-1",
    ]) {
      const response = await worker.fetch(adminGet(path), { DB: fakeD1() });

      expect(response.status, path).toBe(400);
    }
  });
});
