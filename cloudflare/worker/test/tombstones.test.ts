import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { fakeD1, fakeEpisodeKey, type FakeEpisodeRow, type FakeTombstoneChangeRow } from "./fake-d1";

const token = "secret";

function tombstoneRequest(path = "/api/nas/tombstones"): Request {
  return new Request(`https://podcast.example.com${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function episode(status: FakeEpisodeRow["status"], localEpisodeID: string): FakeEpisodeRow {
  return {
    feed_id: "feed",
    provider: "youtube",
    source_episode_id: localEpisodeID,
    local_episode_id: localEpisodeID,
    source_url: null,
    thumbnail: null,
    title: localEpisodeID,
    description: null,
    published_at: null,
    duration: null,
    status,
    r2_key: `audio/feed/${localEpisodeID}.mp3`,
    size: 1,
    mime_type: "audio/mpeg",
    asset_token: "token",
    deleted_at: null,
    purge_after: null,
    updated_at: `2026-07-06 00:00:0${localEpisodeID.length}`,
  };
}

function change(sequence: number, status: FakeTombstoneChangeRow["status"], action: FakeTombstoneChangeRow["action"]): FakeTombstoneChangeRow {
  return {
    sequence,
    feed_id: "feed",
    local_episode_id: `episode-${sequence}`,
    status,
    action,
    created_at: `2026-07-06 00:00:${String(sequence).padStart(2, "0")}`,
  };
}

function env(options: Parameters<typeof fakeD1>[0] = {}) {
  return {
    DB: fakeD1(options),
    NAS_TOKEN: token,
  };
}

describe("NAS tombstones API", () => {
  it("requires NAS auth for tombstones", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/api/nas/tombstones"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(401);
  });

  it("requires GET for tombstones", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/tombstones", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      env(),
    );

    expect(response.status).toBe(405);
  });

  it("validates cursor and limit", async () => {
    for (const path of [
      "/api/nas/tombstones?cursor=-1",
      "/api/nas/tombstones?cursor=",
      "/api/nas/tombstones?cursor=abc",
      "/api/nas/tombstones?cursor=9007199254740992",
      "/api/nas/tombstones?limit=0",
      "/api/nas/tombstones?limit=",
      "/api/nas/tombstones?limit=501",
    ]) {
      const response = await worker.fetch(tombstoneRequest(path), env());

      expect(response.status).toBe(400);
    }
  });

  it("returns cursor zero snapshot of tombstoned episodes", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "hidden"), episode("hidden", "hidden")],
      [fakeEpisodeKey("feed", "delete"), episode("delete_pending", "delete")],
      [fakeEpisodeKey("feed", "purged"), episode("purged", "purged")],
    ]);
    const response = await worker.fetch(tombstoneRequest(), env({
      episodesByKey,
      tombstoneChanges: [change(7, "hidden", "hide")],
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { next_cursor: number; has_more: boolean; changes: FakeTombstoneChangeRow[] };
    expect(body.next_cursor).toBe(7);
    expect(body.has_more).toBe(false);
    expect(body.changes).toHaveLength(3);
    expect(body.changes.map((row) => [row.local_episode_id, row.sequence, row.action])).toEqual([
      ["delete", 0, "delete"],
      ["hidden", 0, "hide"],
      ["purged", 0, "purge"],
    ]);
  });

  it("does not include visible or pending episodes in cursor zero snapshot", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "visible"), episode("visible", "visible")],
      [fakeEpisodeKey("feed", "pending"), episode("pending", "pending")],
      [fakeEpisodeKey("feed", "hidden"), episode("hidden", "hidden")],
    ]);
    const response = await worker.fetch(tombstoneRequest(), env({ episodesByKey }));

    expect(response.status).toBe(200);
    const body = await response.json() as { changes: FakeTombstoneChangeRow[] };
    expect(body.changes.map((row) => row.local_episode_id)).toEqual(["hidden"]);
  });

  it("returns incremental tombstone changes ordered by sequence", async () => {
    const response = await worker.fetch(tombstoneRequest("/api/nas/tombstones?cursor=1"), env({
      tombstoneChanges: [change(3, "delete_pending", "delete"), change(2, "hidden", "hide")],
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { next_cursor: number; has_more: boolean; changes: FakeTombstoneChangeRow[] };
    expect(body.next_cursor).toBe(3);
    expect(body.has_more).toBe(false);
    expect(body.changes.map((row) => row.sequence)).toEqual([2, 3]);
  });

  it("sets has_more when incremental results exceed limit", async () => {
    const response = await worker.fetch(tombstoneRequest("/api/nas/tombstones?cursor=1&limit=1"), env({
      tombstoneChanges: [change(2, "hidden", "hide"), change(3, "delete_pending", "delete")],
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { next_cursor: number; has_more: boolean; changes: FakeTombstoneChangeRow[] };
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBe(2);
    expect(body.changes.map((row) => row.sequence)).toEqual([2]);
  });

  it("returns empty incremental response without advancing cursor", async () => {
    const response = await worker.fetch(tombstoneRequest("/api/nas/tombstones?cursor=10"), env({
      tombstoneChanges: [change(2, "hidden", "hide")],
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { next_cursor: number; has_more: boolean; changes: FakeTombstoneChangeRow[] };
    expect(body.next_cursor).toBe(10);
    expect(body.has_more).toBe(false);
    expect(body.changes).toEqual([]);
  });

  it("does not skip tombstones created during cursor zero snapshot", async () => {
    let inserted = false;
    const tombstoneChanges = [change(5, "hidden", "hide")];
    const testEnv = env({
      tombstoneChanges,
      beforeTombstoneSnapshot() {
        if (inserted) return;
        inserted = true;
        tombstoneChanges.push(change(6, "delete_pending", "delete"));
      },
    });

    const snapshot = await worker.fetch(tombstoneRequest(), testEnv);
    expect(snapshot.status).toBe(200);
    const snapshotBody = await snapshot.json() as { next_cursor: number };
    expect(snapshotBody.next_cursor).toBe(5);

    const incremental = await worker.fetch(tombstoneRequest("/api/nas/tombstones?cursor=5"), testEnv);
    expect(incremental.status).toBe(200);
    const incrementalBody = await incremental.json() as { changes: FakeTombstoneChangeRow[] };
    expect(incrementalBody.changes.map((row) => row.sequence)).toEqual([6]);
  });
});
