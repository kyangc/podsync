import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "../migrations");
const schema = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
  .join("\n");

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

  it("stores public URL material separately from token hashes", () => {
    expect(schema).toContain("ALTER TABLE feeds ADD COLUMN public_path TEXT");
    expect(schema).toContain("ALTER TABLE opml_tokens ADD COLUMN public_path TEXT");
    expect(schema).toContain("CREATE UNIQUE INDEX idx_feeds_public_path ON feeds(public_path)");
    expect(schema).toContain("CREATE UNIQUE INDEX idx_opml_tokens_public_path ON opml_tokens(public_path)");
  });

  it("models logical feed deletion without cascading tombstones away", () => {
    expect(schema).toContain("ALTER TABLE feeds ADD COLUMN deleted_at TEXT");
    expect(schema).toContain("CREATE INDEX idx_feeds_deleted_enabled_opml ON feeds(deleted_at, enabled, include_in_opml)");
  });
});
