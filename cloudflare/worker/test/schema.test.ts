import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "../migrations/0001_initial.sql"), "utf8");

describe("D1 schema contract", () => {
  it("has required idempotency and token constraints", () => {
    expect(schema).toContain("UNIQUE(feed_id, local_episode_id)");
    expect(schema).toContain("UNIQUE(run_id, sequence)");
    expect(schema).toContain("feed_token_hash TEXT NOT NULL UNIQUE");
    expect(schema).toContain("token_hash TEXT NOT NULL UNIQUE");
  });

  it("models tombstone sequence and allowed visibility transitions", () => {
    expect(schema).toContain("sequence INTEGER PRIMARY KEY AUTOINCREMENT");
    expect(schema).toContain("status TEXT NOT NULL CHECK (status IN ('hidden', 'delete_pending', 'purged', 'visible'))");
    expect(schema).toContain("action TEXT NOT NULL CHECK (action IN ('hide', 'delete', 'purge', 'restore'))");
  });

  it("allows pending episodes without complete metadata", () => {
    expect(schema).toMatch(/CREATE TABLE episodes \([\s\S]*\n  title TEXT,\n  description TEXT,/);
  });
});
