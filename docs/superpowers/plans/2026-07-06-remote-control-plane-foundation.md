# Remote Control Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first verifiable foundation for Podsync's Cloudflare control plane while preserving the current NAS/local Podsync behavior.

**Scope statement:** This slice covers a P0 regression seed plus P1A-P1B Worker foundation from `docs/remote-control-plane.md`. It does not implement Go remote config fetch, scheduler reconcile, R2 upload, episode upsert, tombstone application, dashboard mutations, or logging ingestion.

**Tech stack:** Go 1.25, existing Podsync packages, Cloudflare Workers, TypeScript, Wrangler, D1, Vitest.

---

## Scope Boundaries

This plan may create or modify:

- `docs/superpowers/plans/2026-07-06-remote-control-plane-foundation.md`
- `cloudflare/worker/**`
- `cmd/podsync/config_test.go`
- `.gitignore` only for Worker local state such as `.wrangler/`

This plan must not modify:

- Go production runtime files under `cmd/podsync/*.go`, `services/**`, or `pkg/**`
- `Dockerfile`
- NAS live config
- GitHub Actions
- Existing local podcast XML/audio/history data

The P0 work in this slice is intentionally test-only. It seeds the remote-disabled compatibility fixture before any Go remote runtime exists. Full P0 assertions for "no HTTP, no R2, no outbox" become executable in the later Go remote-runtime slice that introduces those seams.

---

## Reviewer Findings Incorporated

- Do not claim full P0 runtime coverage before the Go remote runtime exists; add a test-only compatibility seed instead.
- Use plain Vitest config, not `@cloudflare/vitest-pool-workers/config`.
- Include `@types/node` if tests use Node modules.
- Commit `package-lock.json`; use `npm ci` after the initial install.
- Do not enable R2 binding or cron in this foundation slice.
- Verify route-level auth boundaries: admin/dashboard, NAS Bearer, public token routes.
- Public `/f/<feed_token>.xml` and `/opml/<opml_token>.xml` must reject invalid tokens.
- `/api/nas/config.toml` must include feed filters.
- D1 schema gate must apply the migration to local D1 and query structure, not only inspect SQL strings.
- `episodes.title` must allow null while an episode is pending.
- `tombstone_changes.sequence` must be monotonic and statuses/actions must use `CHECK` constraints.
- `compileFeedsToml` must quote feed IDs as TOML keys.
- Upsert/tombstone/events/R2 key safety findings remain future acceptance criteria unless this slice implements those routes.

---

### Task 0: P0 Local Mode Regression Seed

**Files:**

- Modify: `cmd/podsync/config_test.go`

- [ ] **Step 0.1: Add a remote-disabled compatibility fixture**

Add a test named `TestRemoteDisabledDoesNotChangeLocalConfig` in `cmd/podsync/config_test.go`.

The test should:

- Load one normal local config.
- Load the same config with an extra disabled remote block:

```toml
[remote]
enabled = false
base_url = "http://127.0.0.1:1"
token = "unused"
cache_path = "/tmp/podsync-remote-cache.toml"
config_refresh_interval = "5m"
```

- Assert both configs have the same local feed map semantics for:
  - feed ID
  - URL
  - format
  - quality
  - page size
  - update period
  - OPML flag
  - filters, including `not_title`
  - cleanup policy
- Assert server/storage/database defaults remain equivalent.

Do not add a `Remote` config type in this task. The test should pass with the current code and continue to guard behavior when a later slice introduces `[remote]`.

- [ ] **Step 0.2: Run the Go compatibility gate**

Run:

```bash
go test ./cmd/podsync ./pkg/feed ./services/web
go test ./...
```

Expected: PASS.

This gate relies on the existing XML, OPML, and `/health` tests plus the new config fixture. If these fail, stop and fix only the test fixture or report the pre-existing failure.

---

### Task 1: Worker Tooling Skeleton

**Files:**

- Create: `cloudflare/worker/package.json`
- Create: `cloudflare/worker/package-lock.json`
- Create: `cloudflare/worker/tsconfig.json`
- Create: `cloudflare/worker/vitest.config.ts`
- Create: `cloudflare/worker/wrangler.jsonc`
- Create: `cloudflare/worker/src/index.ts`
- Create: `cloudflare/worker/src/env.ts`
- Create: `cloudflare/worker/scripts/reset-d1-check.mjs`
- Create: `cloudflare/worker/test/smoke.test.ts`
- Modify: `.gitignore` only if `.wrangler/` or another generated local Worker state path appears

- [ ] **Step 1.1: Create the Worker package**

Create `cloudflare/worker/package.json` with these scripts:

```json
{
  "name": "podsync-control-plane-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "d1:reset": "node scripts/reset-d1-check.mjs",
    "d1:check": "npm run d1:reset && wrangler d1 migrations apply podsync-control-plane --local --persist-to .wrangler/d1-check && wrangler d1 execute podsync-control-plane --local --persist-to .wrangler/d1-check --command \"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feeds'\"",
    "wrangler:check": "wrangler deploy --dry-run --outdir dist/dry-run"
  },
  "devDependencies": {}
}
```

Then install dependencies from inside `cloudflare/worker`:

```bash
npm install --save-dev typescript vitest wrangler @cloudflare/workers-types @types/node
```

Commit the generated `package-lock.json`. After this initial install, use `npm ci` for repeatable runs.

- [ ] **Step 1.2: Add local D1 check reset script**

Create `cloudflare/worker/scripts/reset-d1-check.mjs`:

```js
import { rmSync } from "node:fs";

rmSync(".wrangler/d1-check", { recursive: true, force: true });
```

The `d1:check` script must use this fresh local D1 state every time. Do not use Wrangler's unsupported `--yes` flag.

- [ ] **Step 1.3: Create TypeScript config**

Create `cloudflare/worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["@cloudflare/workers-types", "node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 1.4: Create plain Vitest config**

Create `cloudflare/worker/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

Do not use `@cloudflare/vitest-pool-workers/config` in this slice.

- [ ] **Step 1.5: Create Wrangler config without R2 or cron**

Create `cloudflare/worker/wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "podsync-control-plane",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-06",
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "podsync-control-plane",
      "database_id": "00000000-0000-0000-0000-000000000000"
    }
  ]
}
```

R2 buckets and cron triggers are intentionally omitted until the R2 publish and retention phases.

- [ ] **Step 1.6: Define Env bindings**

Create `cloudflare/worker/src/env.ts`:

```ts
export interface Env {
  DB: D1Database;
  NAS_TOKEN?: string;
}
```

- [ ] **Step 1.7: Create a minimal Worker**

Create `cloudflare/worker/src/index.ts`:

```ts
import type { Env } from "./env";

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    return text("not found", 404);
  },
};
```

- [ ] **Step 1.8: Add smoke test**

Create `cloudflare/worker/test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const env = {
  DB: {} as D1Database,
};

describe("worker smoke", () => {
  it("returns health", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
```

- [ ] **Step 1.9: Run Worker check**

Run:

```bash
cd cloudflare/worker
npm run check
```

Expected: PASS.

---

### Task 2: D1 Schema And Migration Gate

**Files:**

- Create: `cloudflare/worker/migrations/0001_initial.sql`
- Create: `cloudflare/worker/src/db.ts`
- Create: `cloudflare/worker/test/schema.test.ts`

- [ ] **Step 2.1: Add initial D1 schema**

Create `cloudflare/worker/migrations/0001_initial.sql`:

```sql
CREATE TABLE feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('youtube', 'bilibili')),
  url TEXT NOT NULL,
  title_override TEXT,
  description_override TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  include_in_opml INTEGER NOT NULL DEFAULT 1 CHECK (include_in_opml IN (0, 1)),
  private_feed INTEGER NOT NULL DEFAULT 1 CHECK (private_feed IN (0, 1)),
  update_period TEXT NOT NULL DEFAULT '1h',
  page_size INTEGER NOT NULL DEFAULT 25,
  keep_last INTEGER NOT NULL DEFAULT 25,
  cookie_profile TEXT,
  feed_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE feed_filters (
  feed_id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  not_title TEXT,
  description TEXT,
  not_description TEXT,
  min_duration INTEGER,
  max_duration INTEGER,
  min_age INTEGER,
  max_age INTEGER,
  FOREIGN KEY (feed_id) REFERENCES feeds(feed_id) ON DELETE CASCADE
);

CREATE TABLE global_downloader_defaults (
  provider TEXT PRIMARY KEY NOT NULL,
  socket_timeout INTEGER NOT NULL,
  retries INTEGER NOT NULL,
  fragment_retries INTEGER NOT NULL
);

INSERT INTO global_downloader_defaults (provider, socket_timeout, retries, fragment_retries)
VALUES ('youtube', 12, 1, 1);

CREATE TABLE opml_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'default',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE feed_metadata (
  feed_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('youtube', 'bilibili')),
  source_url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  image_url TEXT,
  link TEXT,
  author TEXT,
  category TEXT,
  language TEXT,
  explicit INTEGER CHECK (explicit IS NULL OR explicit IN (0, 1)),
  last_source_update_at TEXT,
  reported_at TEXT NOT NULL,
  FOREIGN KEY (feed_id) REFERENCES feeds(feed_id) ON DELETE CASCADE
);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('youtube', 'bilibili')),
  source_episode_id TEXT NOT NULL,
  local_episode_id TEXT NOT NULL,
  source_url TEXT,
  thumbnail TEXT,
  title TEXT,
  description TEXT,
  published_at TEXT,
  duration INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'visible', 'hidden', 'delete_pending', 'purged')),
  r2_key TEXT,
  size INTEGER,
  mime_type TEXT,
  asset_token TEXT,
  deleted_at TEXT,
  purge_after TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(feed_id, local_episode_id),
  FOREIGN KEY (feed_id) REFERENCES feeds(feed_id) ON DELETE CASCADE
);

CREATE TABLE tombstone_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT NOT NULL,
  local_episode_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('hidden', 'delete_pending', 'purged', 'visible')),
  action TEXT NOT NULL CHECK (action IN ('hide', 'delete', 'purge', 'restore')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  feeds_updated INTEGER NOT NULL DEFAULT 0,
  episodes_downloaded INTEGER NOT NULL DEFAULT 0,
  episodes_uploaded INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_time TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  type TEXT NOT NULL,
  feed_id TEXT,
  local_episode_id TEXT,
  message TEXT,
  error_code TEXT,
  error_detail TEXT,
  UNIQUE(run_id, sequence)
);

CREATE INDEX idx_feeds_enabled_opml ON feeds(enabled, include_in_opml);
CREATE INDEX idx_episodes_feed_status ON episodes(feed_id, status, published_at);
CREATE INDEX idx_tombstone_sequence ON tombstone_changes(sequence);
CREATE INDEX idx_events_time ON events(event_time);
```

- [ ] **Step 2.2: Add row types**

Create `cloudflare/worker/src/db.ts` with row interfaces used by routes:

```ts
export interface FeedRow {
  feed_id: string;
  provider: "youtube" | "bilibili";
  url: string;
  title_override: string | null;
  description_override: string | null;
  enabled: number;
  include_in_opml: number;
  private_feed: number;
  update_period: string;
  page_size: number;
  keep_last: number;
  cookie_profile: string | null;
  feed_token_hash: string;
}

export interface FeedFilterRow {
  feed_id: string;
  title: string | null;
  not_title: string | null;
  description: string | null;
  not_description: string | null;
  min_duration: number | null;
  max_duration: number | null;
  min_age: number | null;
  max_age: number | null;
}

export interface FeedTomlRow extends FeedRow, Partial<Omit<FeedFilterRow, "feed_id">> {}
```

- [ ] **Step 2.3: Add schema tests**

Create `cloudflare/worker/test/schema.test.ts`.

The tests should:

- Read `migrations/0001_initial.sql`.
- Assert required constraints exist:
  - `UNIQUE(feed_id, local_episode_id)`
  - `UNIQUE(run_id, sequence)`
  - `feed_token_hash TEXT NOT NULL UNIQUE`
  - `token_hash TEXT NOT NULL UNIQUE`
  - `sequence INTEGER PRIMARY KEY AUTOINCREMENT`
  - tombstone `status` and `action` `CHECK` constraints
  - nullable `title TEXT` in `episodes`
- Assert no R2 or cron schema placeholder is present in this slice.

Use `node:fs` and `node:path`; this is why `@types/node` is part of the dev dependencies.

- [ ] **Step 2.4: Run the real local D1 migration gate**

Run from `cloudflare/worker`:

```bash
npm run d1:check
```

Expected: PASS. This command must apply the migration to Wrangler's local D1 and query `sqlite_master`.

If Wrangler's exact CLI flags differ from the installed version, use `npx wrangler d1 migrations apply --help` and `npx wrangler d1 execute --help`, update the script once, and rerun. Do not replace this with string-only tests.

- [ ] **Step 2.5: Run Worker check**

Run:

```bash
cd cloudflare/worker
npm run check
npm run d1:check
```

Expected: PASS.

---

### Task 3: Route Auth And NAS Config TOML Contract

**Files:**

- Create: `cloudflare/worker/src/auth.ts`
- Create: `cloudflare/worker/src/tokens.ts`
- Create: `cloudflare/worker/src/toml.ts`
- Modify: `cloudflare/worker/src/index.ts`
- Create: `cloudflare/worker/test/fake-d1.ts`
- Create: `cloudflare/worker/test/config-toml.test.ts`
- Create: `cloudflare/worker/test/auth-routes.test.ts`

- [ ] **Step 3.1: Add token helpers**

Create `cloudflare/worker/src/tokens.ts`.

Requirements:

- Provide `sha256Hex(value: string): Promise<string>`.
- Use Web Crypto (`crypto.subtle.digest`) and `TextEncoder`.
- Use lowercase hex.

- [ ] **Step 3.2: Add auth helpers**

Create `cloudflare/worker/src/auth.ts`.

Requirements:

- `isAuthorizedNasRequest(request, env)` returns `false` if `NAS_TOKEN` is absent.
- It accepts only `Authorization: Bearer <token>`.
- It avoids direct secret string equality. Compare SHA-256 digests plus original byte length.
- It is async because it uses Web Crypto.
- `hasCloudflareAccessIdentity(request)` returns true only when `Cf-Access-Jwt-Assertion` is present.

- [ ] **Step 3.3: Add TOML compiler with filters**

Create `cloudflare/worker/src/toml.ts`.

Requirements:

- `compileFeedsToml(feeds, youtubeDefaults)` emits only enabled feeds.
- Always quote feed IDs as TOML table keys: `[feeds."feed-id"]`.
- Emit:
  - `url`
  - `format = "audio"`
  - `quality = "high"`
  - `page_size`
  - `update_period`
  - `opml`
  - `private_feed`
  - `clean = { keep_last = N }`
  - `cookie_profile` when non-empty
  - `filters = { ... }` when any filter field is present
  - YouTube `youtube_dl_args` from global defaults
- Preserve filter numeric zero values when they are explicitly present as `0`.
- Escape TOML strings with `JSON.stringify`.

- [ ] **Step 3.4: Wire route boundaries**

Modify `cloudflare/worker/src/index.ts`.

Routes:

- `GET /health` returns `{ ok: true }`.
- `GET /api/nas/config.toml`:
  - Requires NAS Bearer auth.
  - Reads enabled feeds with `LEFT JOIN feed_filters`.
  - Reads YouTube downloader defaults.
  - Returns `application/toml; charset=utf-8`.
- `/api/admin/*`:
  - Requires Cloudflare Access identity header.
  - Returns a stub `404` after Access passes.
  - Returns `403` when Access identity is missing.
- `/dashboard/*`:
  - Requires Cloudflare Access identity header.
  - Returns a minimal stub response after Access passes.
  - Returns `403` when Access identity is missing.

Do not add dashboard mutation behavior in this slice. The Access check is a local route-boundary guard that assumes Cloudflare Access is enforced in front of the Worker; it is not JWT verification and must not be treated as the complete security model for future admin mutations.

- [ ] **Step 3.5: Add route-level auth tests**

Create `cloudflare/worker/test/auth-routes.test.ts`.

Tests must cover:

- `/api/nas/config.toml` without token -> `401`
- `/api/nas/config.toml` with wrong token -> `401`
- `/api/nas/config.toml` with correct token -> `200`
- `/api/admin/feeds` without `Cf-Access-Jwt-Assertion` -> `403`
- `/api/admin/feeds` with `Cf-Access-Jwt-Assertion` -> not `403`
- `/dashboard/` without `Cf-Access-Jwt-Assertion` -> `403`
- `/dashboard/` with `Cf-Access-Jwt-Assertion` -> `200`

Use a small fake D1 implementation in `test/fake-d1.ts` so the tests do not require live Cloudflare credentials.

- [ ] **Step 3.6: Add TOML compiler tests**

Create `cloudflare/worker/test/config-toml.test.ts`.

Tests must cover:

- Disabled feeds are omitted.
- Feed IDs are quoted.
- YouTube downloader defaults compile to:

```toml
youtube_dl_args = ["--socket-timeout", "12", "--retries", "1", "--fragment-retries", "1"]
```

- Bilibili feed with `cookie_profile = "bilibili-main"` emits that field.
- `filters = { not_title = "直播" }` is emitted when present.
- Numeric filters preserve explicit zero values.
- A feed ID containing a hyphen or dot still produces valid quoted TOML syntax.

- [ ] **Step 3.7: Run Worker check**

Run:

```bash
cd cloudflare/worker
npm run check
npm run d1:check
```

Expected: PASS.

---

### Task 4: Public Empty RSS And OPML Contracts

**Files:**

- Create: `cloudflare/worker/src/xml.ts`
- Modify: `cloudflare/worker/src/index.ts`
- Create: `cloudflare/worker/test/public-feeds.test.ts`

- [ ] **Step 4.1: Add XML render helpers**

Create `cloudflare/worker/src/xml.ts`.

Requirements:

- Escape XML text and attributes.
- `renderEmptyRss(metadata)` returns well-formed RSS 2.0 XML with:
  - `<?xml version="1.0" encoding="UTF-8"?>`
  - `<rss version="2.0">`
  - `<channel>`
  - `<title>`
  - `<link>`
  - `<description>`
  - `<lastBuildDate>`
  - `<generator>podsync-cf</generator>`
  - no `<item>`
- `renderOpml(feeds)` returns well-formed OPML 2.0 XML with a `<body>`.

- [ ] **Step 4.2: Add public token routes**

Modify `cloudflare/worker/src/index.ts`.

Routes:

- `GET /f/<feed_token>.xml`
  - Hashes the path token.
  - Looks up an enabled feed by `feed_token_hash`.
  - Returns `404` for invalid/missing/disabled token.
  - Returns empty RSS for valid token until visible episode publishing is implemented.
- `GET /opml/<opml_token>.xml`
  - Hashes the path token.
  - Looks up an enabled `opml_tokens` row.
  - Returns `404` for invalid/missing/disabled token.
  - Returns empty OPML in this foundation slice. Non-empty OPML is deferred until feed URL token material is designed.

These public routes must not require NAS token or Cloudflare Access.

- [ ] **Step 4.3: Add public contract tests**

Create `cloudflare/worker/test/public-feeds.test.ts`.

Tests must cover:

- Valid feed token returns `200` RSS content type.
- Invalid feed token returns `404`.
- RSS body is well-formed enough for contract checks and contains no `<item>`.
- Valid OPML token returns `200` OPML content type.
- Invalid OPML token returns `404`.
- OPML can return an empty `<body>` without failing.
- Public routes do not require `Authorization` or `Cf-Access-Jwt-Assertion`.

Use the fake D1 helper with token hashes produced by `sha256Hex`.

For this foundation slice, OPML may be empty. A later non-empty OPML implementation must decide how the Worker obtains public feed URLs because `feed_token_hash` cannot be reversed into the original `feed_token`.

- [ ] **Step 4.4: Run Worker check**

Run:

```bash
cd cloudflare/worker
npm run check
npm run d1:check
```

Expected: PASS.

---

### Task 5: Foundation Quality Gate

**Files:**

- Modify this plan only if implementation exposes a real mismatch.
- Do not modify `docs/remote-control-plane.md` in this task unless the design itself is wrong; implementation should conform to the design.

- [ ] **Step 5.1: Run full Worker gate**

Run:

```bash
cd cloudflare/worker
npm ci
npm run check
npm run d1:check
npm run wrangler:check
```

Expected:

- `npm ci`, typecheck, Vitest, and local D1 migration gate pass.
- `wrangler:check` passes if the placeholder D1 id is accepted for dry-run. If real Cloudflare resource ids are required, record it as blocked by missing deploy resource ids; do not skip the local gates.

- [ ] **Step 5.2: Run Go gate**

Run from repo root:

```bash
go test ./...
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS.

- [ ] **Step 5.3: Review generated diff scope**

Run:

```bash
git status --short
git diff --stat
```

Expected:

- Only `docs/**`, `cloudflare/worker/**`, `.gitignore`, and `cmd/podsync/config_test.go` changed.
- No Go production runtime files changed.
- No NAS live config changed.

- [ ] **Step 5.4: Sub-agent quality reviews**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify this slice honestly covers a P0 regression seed plus P1A-P1B foundation.
  Check route auth boundaries, TOML contract with filters, public token routes, D1 schema constraints, and local-mode compatibility fixture.

Quality reviewer:
  Review Worker TypeScript and test gates for Cloudflare Workers best practices:
  no hardcoded secrets, no global request state, no floating promises, no direct secret equality, strict types, and no R2/cron scope creep.
```

Expected: no blocking or important findings. Any blocking or important finding must be fixed and re-reviewed before proceeding to Phase 2.

---

## Future Plans After This Slice

Separate plans are required before implementation for:

- Phase 2A/2B/2C: Go `[remote]` config, remote TOML resolver/cache, local merge, scheduler reconcile, and full remote-disabled no-HTTP/no-R2/no-outbox tests.
- Phase 3A/3B/3C: DB-backed outbox, R2 Put/Head publisher, episode/feed metadata upsert, and Worker visible RSS.
- Phase 4: dashboard mutations, disable/hide/delete/restore, tombstone cursor API, and NAS tombstone application.
- Phase 5: key event logging, sync run status, retention windows, delayed purge cron, and dashboard status panels.
- Non-empty OPML feed URL material: decide whether to store an encrypted/public token value, a separate public path slug, or another non-reversible URL material field. Do not try to derive `/f/<feed_token>.xml` from `feed_token_hash`.
