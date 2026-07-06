# Admin Feed Config Upsert API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing Worker-side admin API needed for real remote feed configuration management: create a new remote feed, update an existing feed's editable config fields, persist filters, preserve/generated public subscription material, and expose enough feed config detail for a later dashboard edit form.

**Architecture:** Keep this as a Cloudflare Worker/D1 backend slice. Add a single Access-protected `POST /api/admin/feeds/upsert` endpoint that accepts a full feed config object. On create, Worker generates a random public feed path and stores only its SHA-256 token hash plus `public_path`. On update, Worker preserves existing `feed_token_hash` and `public_path`, treats `feed_id` and provider as stable identity, and updates editable config plus filters. Existing `/api/nas/config.toml` continues to compile from D1 tables, so NAS will pick up changes on the next remote config refresh.

**Tech Stack:** Cloudflare Workers, D1, TypeScript, existing `sha256Hex`, Vitest fake D1.

---

## Scope Boundaries

This phase may modify:

- `cloudflare/worker/src/db.ts`
- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/test/fake-d1.ts`
- `cloudflare/worker/test/admin-read.test.ts`
- `cloudflare/worker/test/admin-actions.test.ts`
- `cloudflare/worker/test/config-toml.test.ts`
- new `cloudflare/worker/test/admin-feed-config.test.ts` if cleaner
- `docs/superpowers/plans/2026-07-06-admin-feed-config-upsert.md`

This phase must not implement:

- Dashboard UI form wiring.
- True feed delete or feed rename.
- Provider change for existing feeds.
- Cookie content management.
- Arbitrary `youtube_dl_args` editing.
- OPML token creation/editing.
- D1 schema migrations.
- R2 upload/purge changes.
- Go/NAS runtime changes.
- Live Cloudflare deployment or NAS restart.

---

## Assumptions

- `feeds.feed_id` is system identity and must not be renamed.
- Provider is part of feed identity for this phase. New feeds choose `youtube` or `bilibili`; existing feeds cannot change provider through this endpoint.
- `public_path` is allowed to store the raw random path token because it is the public subscription URL material. The secret-like bearer token remains only `feed_token_hash`.
- Remote feed TOML remains the NAS protocol. Updating D1 feed config is enough; NAS applies it via existing TTL remote config refresh and scheduler reconcile.
- Bilibili cookies remain local. The API only stores `cookie_profile` string references.

---

## Acceptance Criteria

- `POST /api/admin/feeds/upsert` requires Cloudflare Access and `Content-Type: application/json`.
- Non-POST requests return `405`; unauthenticated admin requests return `403`.
- Request validates:
  - `feed_id` matches a bounded safe identifier pattern.
  - `provider` is `youtube` or `bilibili`.
  - `url` is absolute `http` or `https`.
  - URL host is compatible with provider using strict root/subdomain matching:
    - valid iff `host === root || host.endsWith("." + root)`.
    - YouTube root is `youtube.com`.
    - Bilibili root is `bilibili.com`.
    - reject lookalikes like `youtube.com.evil.test` and `evilbilibili.com`.
  - `update_period` is a Go-duration-like string.
  - `page_size` is a safe positive integer.
  - `keep_last` is a safe non-negative integer.
  - booleans are booleans.
  - optional string fields are strings or `null`.
  - filter numeric fields are non-negative integers or `null`.
- Create behavior:
  - inserts into `feeds`.
  - generates `feed_token_hash` and `public_path`.
  - bounded-retries random token generation on `feed_token_hash` or `public_path` unique collision.
  - upserts one `feed_filters` row.
  - writes feed and filter rows atomically with `env.DB.batch`.
  - response includes `ok`, `created: true`, `feed_id`, `public_feed_url`, and saved config fields.
- Update behavior:
  - requires feed to exist if caller is changing an existing feed.
  - rejects provider changes for existing feeds with `400`.
  - preserves existing `feed_token_hash` and `public_path`.
  - updates editable fields and `updated_at`.
  - upserts filters, clearing omitted optional filter fields to `null`.
  - writes feed and filter rows atomically with `env.DB.batch`.
  - response includes `ok`, `created: false`, `feed_id`, `public_feed_url`, and saved config fields.
- `GET /api/admin/feeds` continues to work for list UI and now also includes:
  - raw `title_override`
  - raw `description_override`
  - `filters` object
- `GET /api/admin/subscriptions` sees newly created feeds with generated public URLs.
- `GET /api/nas/config.toml` emits newly created/updated enabled feeds and filter values.
- Existing `POST /api/admin/feeds/status` behavior remains unchanged.
- Tests, D1 check, Wrangler dry-run, `go test ./...`, and `git diff --check` pass.

---

## API Contract

```http
POST /api/admin/feeds/upsert
Cf-Access-Jwt-Assertion: <present>
Content-Type: application/json
```

Request:

```json
{
  "feed_id": "tangpingshu",
  "provider": "youtube",
  "url": "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
  "title_override": "Tang Ping Shu",
  "description_override": null,
  "enabled": true,
  "include_in_opml": true,
  "private_feed": true,
  "update_period": "1h",
  "page_size": 25,
  "keep_last": 25,
  "cookie_profile": null,
  "filters": {
    "title": null,
    "not_title": "直播",
    "description": null,
    "not_description": null,
    "min_duration": null,
    "max_duration": null,
    "min_age": null,
    "max_age": null
  }
}
```

Response:

```json
{
  "ok": true,
  "created": true,
  "feed": {
    "feed_id": "tangpingshu",
    "provider": "youtube",
    "url": "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
    "title_override": "Tang Ping Shu",
    "description_override": null,
    "enabled": true,
    "include_in_opml": true,
    "private_feed": true,
    "update_period": "1h",
    "page_size": 25,
    "keep_last": 25,
    "cookie_profile": null,
    "filters": {
      "title": null,
      "not_title": "直播",
      "description": null,
      "not_description": null,
      "min_duration": null,
      "max_duration": null,
      "min_age": null,
      "max_age": null
    },
    "public_feed_url": "https://podcast.example.com/f/<token>.xml"
  }
}
```

Notes:

- Full-object upsert: omitted optional override/filter fields save as `null`.
- No server-side cookie profile validation because the Worker does not know NAS local cookie profile definitions.
- `enabled=false` keeps `public_path` valid and still allows existing public RSS access, matching prior disable semantics.

---

## Implementation Tasks

### Task 1: Types And Validation

**Files:**

- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/src/index.ts`

- [x] Add request/response helper types for admin feed config upsert.
- [x] Add `feedIDPattern` and duration/limit constants.
- [x] Add parser helpers:
  - bounded optional string or null.
  - required boolean fields.
  - integer range validation.
  - filter object parsing.
  - provider-compatible URL validation.
- [x] Keep validation messages concise and deterministic for tests.

### Task 2: Public Path Generation

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [x] Add `newPublicFeedPath()` that returns `/f/<random-token>.xml`.
- [x] Use `crypto.randomUUID()` or `crypto.getRandomValues`; token must match `publicPathTokenPattern`.
- [x] Derive `feed_token_hash` from the path token with existing `sha256Hex`.
- [x] Add bounded token generation retry for create:
  - try up to 5 token/path pairs.
  - if `INSERT INTO feeds` fails because `feed_token_hash` or `public_path` is not unique, retry with a new token.
  - after retry budget, return `500` with a generic non-secret message.
- [x] Create helper to convert saved `public_path` to `public_feed_url` using `absolutePublicURL(request, path, "/f/")`.

### Task 3: Admin Feed Upsert Handler

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [x] Add `handleAdminFeedUpsert(request, env)`.
- [x] Require bounded JSON and parse request.
- [x] Select existing `feed_id, provider, feed_token_hash, public_path`.
- [x] If existing provider differs from request provider, return `400`.
- [x] If create:
  - generate `public_path` and `feed_token_hash`.
  - insert into `feeds`.
- [x] If update:
  - preserve existing `feed_token_hash` and `public_path`.
  - update editable feed fields.
- [x] Upsert into `feed_filters`.
- [x] Use `env.DB.batch([feedMutation, filterUpsert])` for both create and update so feed row and filter row are atomic.
- [x] Return saved config in a `feed` object with `public_feed_url`.
- [x] Add route `POST /api/admin/feeds/upsert`.

### Task 4: Extend Admin Feed Read Response

**Files:**

- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Modify: `cloudflare/worker/test/admin-read.test.ts`

- [x] Extend `AdminFeedListRow` to include filter columns.
- [x] Update `handleAdminFeeds` query to `LEFT JOIN feed_filters`.
- [x] Return raw `title_override`, `description_override`, and `filters` object while preserving current display `title` and `description`.
- [x] Update fake D1 admin feed rows to include filter values.
- [x] Update existing admin read tests without weakening current assertions.

### Task 5: Fake D1 Support

**Files:**

- Modify: `cloudflare/worker/test/fake-d1.ts`

- [x] Extend `FakeFeedRow` and `FakeReadableFeed` with filter fields or a reusable filter shape.
- [x] Make config TOML query combine `tomlFeeds` and `feedsByID`, not only `tomlFeeds`, so newly inserted fake feeds can be emitted.
- [x] Add fake support for:
  - `INSERT INTO feeds`.
  - `UPDATE feeds`.
  - `INSERT INTO feed_filters ... ON CONFLICT`.
- [x] Make fake batch staging rollback feed/filter mutations if the second statement fails.
- [x] Add optional fake hooks to simulate:
  - public path/hash unique collision on insert.
  - filter upsert failure.
- [x] Preserve existing feed status update behavior.
- [x] Keep existing tests compatible.

### Task 6: Tests

**Files:**

- Add or modify Worker tests.

- [x] Auth/method tests for `/api/admin/feeds/upsert`.
- [x] Content-type, invalid JSON, and oversized-body tests.
- [x] Validation tests for invalid feed ID, provider, URL/provider mismatch, duration, page size, keep last, booleans, and filters.
- [x] Host validation tests reject provider lookalikes:
  - `https://youtube.com.evil.test/channel/x`
  - `https://evilbilibili.com/10835521`
- [x] Create feed test:
  - returns `created: true`.
  - generated `public_feed_url` starts with request origin `/f/`.
  - `feedsByID` has generated `feed_token_hash` and `public_path`.
  - `feed_filters` values are saved.
  - subscriptions API returns the new feed URL.
  - NAS config TOML includes the new feed and filters.
- [x] Create token collision test:
  - fake first insert collision on generated public path/hash.
  - handler retries and succeeds with a different generated token.
- [x] Update feed test:
  - returns `created: false`.
  - preserves existing public path/hash.
  - updates editable fields and filters.
  - NAS config TOML reflects updates.
- [x] Atomicity test:
  - fake filter upsert failure during create or update.
  - feed row changes are rolled back.
- [x] Provider change test returns `400` and does not mutate existing feed.
- [x] Existing admin feed status tests still pass.

### Task 7: Verification

- [x] Run `cd cloudflare/worker && npm run check`.
- [x] Run `cd cloudflare/worker && npm run d1:check`.
- [x] Run `cd cloudflare/worker && npm run wrangler:check`.
- [x] Run `go test ./...`.
- [x] Run `git diff --check`.
- [x] Spawn implementation review sub-agents after tests pass and address blockers.

---

## Rollback Plan

If this endpoint causes issues, revert this phase commit. Existing dashboard shell, admin status actions, NAS config fetch, remote publish, RSS/OPML, tombstone sync, events, and scheduled purge should remain independently usable.
