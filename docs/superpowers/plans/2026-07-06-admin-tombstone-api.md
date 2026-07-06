# Admin Tombstone API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 4A Worker-side admin mutations for feed disable and episode hide/delete/restore, plus a NAS tombstone cursor API.

**Architecture:** Keep this as a Cloudflare Worker/D1 slice only. Admin routes are guarded by the existing Cloudflare Access header boundary; NAS routes keep Bearer token auth. Episode status changes use a D1 `batch()` transaction with a conditional update and a conditional tombstone insert, so `tombstone_changes` is written only when the episode state actually changes. NAS tombstone fetch is read-only and cursor-based.

**Tech Stack:** Cloudflare Workers, D1, TypeScript, Vitest, existing Worker test fake D1.

---

## Scope Boundaries

This phase may modify:

- `cloudflare/worker/src/db.ts`
- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/test/fake-d1.ts`
- `cloudflare/worker/test/auth-routes.test.ts`
- `cloudflare/worker/test/episode-upsert.test.ts`
- `cloudflare/worker/test/public-feeds.test.ts`
- `cloudflare/worker/test/admin-actions.test.ts`
- `cloudflare/worker/test/tombstones.test.ts`
- `docs/remote-control-plane.md`
- `docs/superpowers/plans/2026-07-06-admin-tombstone-api.md`

This phase must not implement:

- NAS local tombstone application or cursor persistence
- R2 delete/purge cron
- dashboard HTML UI beyond existing placeholder
- feed create/update of every config field
- true feed delete
- OPML feed listing
- event/sync-run upload
- Docker, CI, NAS live config, or deployment changes

---

## Acceptance Criteria

- `POST /api/admin/feeds/status` requires Cloudflare Access, validates JSON body, updates only `enabled` and/or `include_in_opml`, returns the saved feed status, and returns 404 for missing feeds.
- `enabled=false` remains compatible with existing NAS config TOML generation because `GET /api/nas/config.toml` only returns enabled feeds.
- `enabled=false` does not disable the public feed XML URL; `/f/<feed_token>.xml` remains accessible and renders existing visible remote episodes.
- `POST /api/admin/episodes/status` requires Cloudflare Access, validates JSON body, supports `hide`, `delete`, and `restore`, returns 404 for missing episodes, and returns 409 for unsupported state transitions.
- Episode `hide` changes `pending` or `visible` to `hidden`; repeated `hide` on `hidden` is idempotent and does not write a duplicate tombstone.
- Episode `delete` changes `pending`, `visible`, or `hidden` to `delete_pending`, sets `deleted_at` and `purge_after`, and repeated `delete` on `delete_pending` is idempotent.
- Episode `restore` changes `hidden` or `delete_pending` to `visible`, clears `deleted_at` and `purge_after`, and `purged` cannot be restored.
- Every real episode state change writes one `tombstone_changes` row with the resulting status and action.
- Episode state change and tombstone insert are atomic: if the tombstone insert fails, the episode status must not be changed.
- `GET /api/nas/tombstones?cursor=<n>` requires NAS Bearer auth, validates cursor/limit, returns changes ordered by `sequence ASC`, and includes `cursor`, `next_cursor`, `has_more`, and `changes`.
- `cursor=0` first captures a tombstone high-watermark, then returns a complete snapshot of all currently tombstoned episodes (`hidden`, `delete_pending`, `purged`). `next_cursor` advances only to that pre-snapshot high-watermark so concurrent changes are never skipped; if a concurrent change also appears in the snapshot, it may be delivered again incrementally and must remain idempotent for the later NAS application phase.
- `cursor>0` returns only rows from `tombstone_changes` where `sequence > cursor`.
- This phase does not change local Go behavior.

---

## API Contracts

### Feed Status

```http
POST /api/admin/feeds/status
Cf-Access-Jwt-Assertion: <present>
Content-Type: application/json
```

Request:

```json
{
  "feed_id": "tangpingshu",
  "enabled": false,
  "include_in_opml": false
}
```

Rules:

- `feed_id` is required and must be a non-empty string.
- At least one of `enabled` or `include_in_opml` must be present.
- Present status fields must be booleans.
- Response:

```json
{
  "ok": true,
  "feed_id": "tangpingshu",
  "enabled": false,
  "include_in_opml": false
}
```

### Episode Status

```http
POST /api/admin/episodes/status
Cf-Access-Jwt-Assertion: <present>
Content-Type: application/json
```

Request:

```json
{
  "feed_id": "tangpingshu",
  "local_episode_id": "sxzZ-B6nfw4",
  "action": "hide"
}
```

Actions:

| Action | Allowed current statuses | Result status | Idempotent status | Rejected statuses |
| --- | --- | --- | --- | --- |
| `hide` | `pending`, `visible` | `hidden` | `hidden` | `delete_pending`, `purged` |
| `delete` | `pending`, `visible`, `hidden` | `delete_pending` | `delete_pending` | `purged` |
| `restore` | `hidden`, `delete_pending` | `visible` | `visible` | `pending`, `purged` |

Response:

```json
{
  "ok": true,
  "feed_id": "tangpingshu",
  "local_episode_id": "sxzZ-B6nfw4",
  "action": "hide",
  "status": "hidden",
  "changed": true
}
```

### Tombstones

```http
GET /api/nas/tombstones?cursor=123&limit=100
Authorization: Bearer <NAS_TOKEN>
```

Response:

```json
{
  "cursor": 123,
  "next_cursor": 130,
  "has_more": false,
  "changes": [
    {
      "sequence": 124,
      "feed_id": "tangpingshu",
      "local_episode_id": "sxzZ-B6nfw4",
      "status": "hidden",
      "action": "hide",
      "created_at": "2026-07-06 10:00:00"
    }
  ]
}
```

Implementation details:

- Default incremental `limit` is `100`; max is `500`.
- `cursor` must be an integer `>= 0`.
- `limit` must be an integer between `1` and `500`.
- For `cursor=0`, return synthetic snapshot rows from `episodes` for tombstoned statuses only: `status IN ('hidden', 'delete_pending', 'purged')`. Snapshot rows use `sequence: 0`, `action` derived from status (`hidden -> hide`, `delete_pending -> delete`, `purged -> purge`), and `created_at` from `updated_at`.
- This intentionally narrows the earlier API draft phrase "all non-visible episode" to tombstoned statuses. `pending` is a publishing workflow state, not a remote tombstone, and must not cause NAS to suppress future publishing.
- For `cursor=0`, read `MAX(sequence)` from `tombstone_changes` before reading the snapshot. Set `next_cursor` to that pre-snapshot high-watermark, even if snapshot rows have `sequence=0`.
- For `cursor=0`, snapshot is not paginated in Phase 4A. This avoids advancing `next_cursor` while omitting snapshot rows.
- For `cursor>0`, query `tombstone_changes` with `sequence > cursor ORDER BY sequence ASC LIMIT limit + 1`; return at most `limit` rows and set `has_more` based on the extra row.

---

## Task 1: Types And Bounded JSON Helpers

**Files:**

- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/src/index.ts`

- [x] **Step 1.1: Add Worker-side row/request types**

Add to `cloudflare/worker/src/db.ts`:

```ts
export interface AdminFeedStatusRequest {
  feed_id: string;
  enabled?: boolean;
  include_in_opml?: boolean;
}

export interface FeedStatusRow {
  feed_id: string;
  enabled: number;
  include_in_opml: number;
}

export type AdminEpisodeAction = "hide" | "delete" | "restore";

export interface AdminEpisodeStatusRequest {
  feed_id: string;
  local_episode_id: string;
  action: AdminEpisodeAction;
}

export interface EpisodeAdminRow {
  feed_id: string;
  local_episode_id: string;
  status: EpisodeStatus;
}

export interface TombstoneChangeRow {
  sequence: number;
  feed_id: string;
  local_episode_id: string;
  status: EpisodeStatus;
  action: "hide" | "delete" | "purge" | "restore";
  created_at: string;
}

export interface MaxSequenceRow {
  max_sequence: number | null;
}
```

Do not add schema libraries. Keep validation local and explicit.

- [x] **Step 1.2: Add a reusable bounded JSON parser**

In `cloudflare/worker/src/index.ts`, add:

```ts
async function readBoundedJson(request: Request): Promise<unknown | Response> {
  if (!isJsonContentType(request)) {
    return badRequest("content-type must be application/json");
  }
  const bodyText = await readBoundedText(request, maxJsonBodyBytes);
  if (bodyText === null) {
    return badRequest("request body too large");
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    return badRequest("invalid json");
  }
}
```

Update `handleEpisodeUpsert` to use this helper without changing its behavior.

- [x] **Step 1.3: Verify existing Worker behavior**

Run:

```bash
cd cloudflare/worker && npm test -- episode-upsert
```

Expected: PASS.

---

## Task 2: Feed Disable Admin API

**Files:**

- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Modify: `cloudflare/worker/test/public-feeds.test.ts`
- Add: `cloudflare/worker/test/admin-actions.test.ts`

- [x] **Step 2.1: Add feed status parser**

Add in `cloudflare/worker/src/index.ts`:

```ts
function parseAdminFeedStatus(body: unknown): AdminFeedStatusRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid feed status body");
  const value = body as Record<string, unknown>;
  if (!nonEmptyString(value.feed_id)) return badRequest("feed_id is required");
  if (value.enabled === undefined && value.include_in_opml === undefined) {
    return badRequest("enabled or include_in_opml is required");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return badRequest("enabled must be boolean");
  }
  if (value.include_in_opml !== undefined && typeof value.include_in_opml !== "boolean") {
    return badRequest("include_in_opml must be boolean");
  }
  const request: AdminFeedStatusRequest = { feed_id: value.feed_id };
  if (value.enabled !== undefined) request.enabled = value.enabled;
  if (value.include_in_opml !== undefined) request.include_in_opml = value.include_in_opml;
  return request;
}
```

- [x] **Step 2.2: Add feed status handler**

Add `handleAdminFeedStatus(request, env)`:

```ts
async function handleAdminFeedStatus(request: Request, env: Env): Promise<Response> {
  const body = await readBoundedJson(request);
  if (body instanceof Response) return body;

  const parsed = parseAdminFeedStatus(body);
  if (parsed instanceof Response) return parsed;

  const feed = await env.DB.prepare(
    `SELECT feed_id, enabled, include_in_opml
       FROM feeds
      WHERE feed_id = ?`,
  ).bind(parsed.feed_id).first<FeedStatusRow>();
  if (!feed) return text("feed not found", 404);

  const enabled = parsed.enabled === undefined ? feed.enabled : parsed.enabled ? 1 : 0;
  const includeInOpml = parsed.include_in_opml === undefined ? feed.include_in_opml : parsed.include_in_opml ? 1 : 0;

  await env.DB.prepare(
    `UPDATE feeds
        SET enabled = ?, include_in_opml = ?
      WHERE feed_id = ?`,
  ).bind(enabled, includeInOpml, parsed.feed_id).run();

  return Response.json({
    ok: true,
    feed_id: parsed.feed_id,
    enabled: enabled === 1,
    include_in_opml: includeInOpml === 1,
  });
}
```

Replace the existing `/api/admin/*` block with a guarded dispatch block. Specific admin routes must live inside this block so they cannot bypass Cloudflare Access and cannot be swallowed by the existing catch-all:

```ts
if (url.pathname.startsWith("/api/admin/")) {
  if (!hasCloudflareAccessIdentity(request)) return text("forbidden", 403);
  if (url.pathname === "/api/admin/feeds/status") {
    if (request.method !== "POST") return methodNotAllowed();
    return handleAdminFeedStatus(request, env);
  }
  return text("not found", 404);
}
```

Do not add an independent admin route outside this block.

- [x] **Step 2.3: Keep disabled public RSS accessible**

In `handleFeedXml`, remove `f.enabled = 1` from the feed token lookup:

```sql
SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override, f.page_size,
       m.title, m.description, m.link
  FROM feeds f
  LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
 WHERE f.feed_token_hash = ?
```

This keeps existing public feed URLs valid after dashboard disable. NAS config TOML still uses `WHERE f.enabled = 1`, so disabled feeds stop being scheduled locally.

- [x] **Step 2.4: Extend fake D1 for feed updates**

In `cloudflare/worker/test/fake-d1.ts`:

- Let `SELECT ... FROM feeds WHERE feed_id = ?` return `feedsByID` first, then a matching `tomlFeeds` row.
- Let the feed status `UPDATE feeds SET enabled = ?, include_in_opml = ? WHERE feed_id = ?` mutate both `feedsByID` and matching `tomlFeeds`.
- Make TOML feed query return only rows with `enabled === 1`, matching the real SQL `WHERE f.enabled = 1`.
- Keep public feed token lookup independent of `enabled`, matching the revised public RSS SQL.

- [x] **Step 2.5: Add feed admin tests**

Create `cloudflare/worker/test/admin-actions.test.ts` with tests:

```ts
it("requires Cloudflare Access for feed status changes")
it("requires POST for feed status changes")
it("validates feed status request body")
it("rejects feed status wrong content type without mutating D1")
it("rejects feed status invalid json without mutating D1")
it("rejects feed status oversized body without mutating D1")
it("updates feed enabled and include_in_opml flags")
it("returns 404 for missing feed status changes")
it("disabled feeds are omitted from NAS config TOML")
it("disabled feeds still serve public RSS")
```

Use request helper:

```ts
function adminRequest(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://podcast.example.com${path}`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": "present",
      "content-type": "application/json",
      ...init.headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}
```

For the TOML omission test:

1. Seed fake D1 with one `tomlFeeds` row where `enabled: 1`.
2. Call `POST /api/admin/feeds/status` with `{ feed_id: "feed", enabled: false }`.
3. Call `GET /api/nas/config.toml` with correct NAS token.
4. Assert the returned TOML does not contain `[feeds."feed"]`.

For the public RSS test:

1. Seed `tomlFeeds` with the feed row and `publicFeedsByHash` with the same feed's public token lookup row.
2. Call `POST /api/admin/feeds/status` with `{ feed_id: "feed", enabled: false }`.
3. Call `GET /f/<feed_token>.xml`.
4. Assert `200` and RSS content type.

- [x] **Step 2.6: Verify feed admin behavior**

Run:

```bash
cd cloudflare/worker && npm test -- admin-actions config-toml auth-routes
```

Expected: PASS.

---

## Task 3: Episode Hide/Delete/Restore Admin API

**Files:**

- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Modify: `cloudflare/worker/test/admin-actions.test.ts`

- [x] **Step 3.1: Add episode action parser**

Add in `cloudflare/worker/src/index.ts`:

```ts
function isAdminEpisodeAction(value: unknown): value is AdminEpisodeAction {
  return value === "hide" || value === "delete" || value === "restore";
}

function parseAdminEpisodeStatus(body: unknown): AdminEpisodeStatusRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid episode status body");
  const value = body as Record<string, unknown>;
  if (!nonEmptyString(value.feed_id)) return badRequest("feed_id is required");
  if (!nonEmptyString(value.local_episode_id)) return badRequest("local_episode_id is required");
  if (!isAdminEpisodeAction(value.action)) return badRequest("action is invalid");
  return {
    feed_id: value.feed_id,
    local_episode_id: value.local_episode_id,
    action: value.action,
  };
}
```

- [x] **Step 3.2: Add transition helper**

Add:

```ts
interface EpisodeTransition {
  changed: boolean;
  status: EpisodeStatus;
  action: "hide" | "delete" | "restore";
  conflict?: string;
}

function episodeTransition(current: EpisodeStatus, action: AdminEpisodeAction): EpisodeTransition {
  if (action === "hide") {
    if (current === "hidden") return { changed: false, status: "hidden", action: "hide" };
    if (current === "pending" || current === "visible") return { changed: true, status: "hidden", action: "hide" };
    return { changed: false, status: current, action: "hide", conflict: "episode cannot be hidden from current status" };
  }
  if (action === "delete") {
    if (current === "delete_pending") return { changed: false, status: "delete_pending", action: "delete" };
    if (current === "pending" || current === "visible" || current === "hidden") {
      return { changed: true, status: "delete_pending", action: "delete" };
    }
    return { changed: false, status: current, action: "delete", conflict: "episode cannot be deleted from current status" };
  }
  if (current === "visible") return { changed: false, status: "visible", action: "restore" };
  if (current === "hidden" || current === "delete_pending") return { changed: true, status: "visible", action: "restore" };
  return { changed: false, status: current, action: "restore", conflict: "episode cannot be restored from current status" };
}
```

- [x] **Step 3.3: Add status update SQL helpers**

Add helper that builds the conditional update SQL based on action:

```ts
function episodeStatusUpdateSQL(action: AdminEpisodeAction): string {
  if (action === "delete") {
    return `UPDATE episodes
               SET status = 'delete_pending',
                   deleted_at = CURRENT_TIMESTAMP,
                   purge_after = datetime(CURRENT_TIMESTAMP, '+7 days'),
                   updated_at = CURRENT_TIMESTAMP
             WHERE feed_id = ?
               AND local_episode_id = ?
               AND status IN ('pending', 'visible', 'hidden')`;
  }
  if (action === "restore") {
    return `UPDATE episodes
               SET status = 'visible',
                   deleted_at = NULL,
                   purge_after = NULL,
                   updated_at = CURRENT_TIMESTAMP
             WHERE feed_id = ?
               AND local_episode_id = ?
               AND status IN ('hidden', 'delete_pending')`;
  }
  return `UPDATE episodes
             SET status = 'hidden',
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND local_episode_id = ?
             AND status IN ('pending', 'visible')`;
}
```

- [x] **Step 3.4: Add episode status handler**

Add `handleAdminEpisodeStatus(request, env)`:

1. Read bounded JSON with `readBoundedJson`.
2. Parse with `parseAdminEpisodeStatus`.
3. Select current episode status by `feed_id + local_episode_id`; 404 if missing.
4. Compute transition with `episodeTransition`.
5. If `transition.conflict`, return 409 with the conflict text.
6. If `transition.changed` is false, return JSON with `changed:false` and do not insert tombstone.
7. Run the conditional update and tombstone insert in one D1 `batch()` transaction. Cloudflare D1 documents `batch()` as a SQL transaction: if a statement in the sequence fails, the sequence aborts or rolls back. This is the atomic boundary for "episode state changed" and "tombstone row written".
8. Use these statements:

```ts
const updateStatement = env.DB.prepare(episodeStatusUpdateSQL(parsed.action))
  .bind(parsed.feed_id, parsed.local_episode_id);

const tombstoneStatement = env.DB.prepare(
  `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
   SELECT ?, ?, ?, ?, CURRENT_TIMESTAMP
    WHERE changes() = 1`,
).bind(parsed.feed_id, parsed.local_episode_id, transition.status, transition.action);
```

9. Run:

```ts
let results: D1Result[];
try {
  results = await env.DB.batch([updateStatement, tombstoneStatement]);
} catch {
  const current = await selectEpisodeAdminRow(env, parsed.feed_id, parsed.local_episode_id);
  const currentTransition = current ? episodeTransition(current.status, parsed.action) : null;
  if (!current || currentTransition?.conflict) {
    return text(`episode status changed concurrently: ${current?.status ?? "missing"}`, 409);
  }
  return text("episode status update failed", 500);
}
```

10. Check the returned batch results:

```ts
const [updateResult, tombstoneResult] = results;
if (updateResult.meta.changes !== 1 || tombstoneResult.meta.changes !== 1) {
  const current = await selectEpisodeAdminRow(env, parsed.feed_id, parsed.local_episode_id);
  return text(`episode status changed concurrently: ${current?.status ?? "missing"}`, 409);
}
```

This prevents writing tombstones without matching episode state changes. If the tombstone insert statement itself fails, D1 rolls back the update and the handler must not leave an episode status change without a tombstone.

11. The tombstone insert SQL in the batch is:

```sql
INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
SELECT ?, ?, ?, ?, CURRENT_TIMESTAMP
 WHERE changes() = 1
```

12. Return JSON with `changed:true`.

Route wiring must remain inside the existing admin guard block:

```ts
if (url.pathname.startsWith("/api/admin/")) {
  if (!hasCloudflareAccessIdentity(request)) return text("forbidden", 403);
  if (url.pathname === "/api/admin/feeds/status") {
    if (request.method !== "POST") return methodNotAllowed();
    return handleAdminFeedStatus(request, env);
  }
  if (url.pathname === "/api/admin/episodes/status") {
    if (request.method !== "POST") return methodNotAllowed();
    return handleAdminEpisodeStatus(request, env);
  }
  return text("not found", 404);
}
```

- [x] **Step 3.5: Extend fake D1 for episode admin updates**

In `cloudflare/worker/test/fake-d1.ts`:

- Add `tombstoneChanges?: FakeTombstoneChangeRow[]`.
- Add `beforeEpisodeStatusUpdate?: (key: string, episode: FakeEpisodeRow | undefined) => void`.
- Add `failTombstoneInsert?: boolean`.
- Add `deleted_at: string | null`, `purge_after: string | null`, and `updated_at: string | null` to `FakeEpisodeRow`.
- Update existing `fakeEpisode(...)` in `cloudflare/worker/test/episode-upsert.test.ts` and `visibleEpisode(...)` in `cloudflare/worker/test/public-feeds.test.ts` to set those three new fields.
- Implement `D1Database.batch` in the fake. It must apply statements against a cloned copy of the fake state and commit the clone only if all statements succeed. If a batched tombstone insert fails, the fake must roll back the episode status update.
- For status update SQL, mutate `episodesByKey` only when the current status matches the SQL allowed statuses.
- Return `D1Result.meta.changes` as `1` only when the fake update changed a row.
- For tombstone insert SQL, append a row with monotonically increasing `sequence`.
- Sequence allocation must continue from the current maximum `tombstoneChanges.sequence`, not from array length.

- [x] **Step 3.6: Add episode admin tests**

Extend `cloudflare/worker/test/admin-actions.test.ts` with:

```ts
it("requires Cloudflare Access for episode status changes")
it("requires POST for episode status changes")
it("validates episode status request body")
it("hides visible episodes and writes one tombstone")
it("does not duplicate tombstones for repeated hide")
it("deletes hidden episodes and sets purge fields")
it("restores delete_pending episodes and clears purge fields")
it("rejects restoring purged episodes")
it("returns 404 for missing episodes")
it("does not write tombstone when conditional status update loses a race")
it("rolls back episode status when tombstone insert fails")
```

For the race test, seed a visible episode and set `beforeEpisodeStatusUpdate` to change it to `delete_pending` before the fake conditional update. Assert:

- response status is `409`
- episode status remains `delete_pending`
- `tombstoneChanges` length is `0`

For the tombstone insert failure test, seed a visible episode, set `failTombstoneInsert: true`, call `hide`, and assert:

- response status is `500`
- episode status remains `visible`
- `tombstoneChanges` length is `0`

For restore, assert the inserted tombstone row has `action: "restore"` and `status: "visible"`.

- [x] **Step 3.7: Verify episode admin behavior**

Run:

```bash
cd cloudflare/worker && npm test -- admin-actions
```

Expected: PASS.

---

## Task 4: NAS Tombstone Cursor API

**Files:**

- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Add: `cloudflare/worker/test/tombstones.test.ts`

- [x] **Step 4.1: Add cursor parsing helpers**

Add:

```ts
function parseIntegerParam(value: string | null, fallback: number, name: string): number | Response {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return badRequest(`${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return badRequest(`${name} is invalid`);
  return parsed;
}

function tombstoneLimit(url: URL): number | Response {
  const limit = parseIntegerParam(url.searchParams.get("limit"), 100, "limit");
  if (limit instanceof Response) return limit;
  if (limit < 1 || limit > 500) return badRequest("limit is invalid");
  return limit;
}

type TombstonedEpisodeStatus = "hidden" | "delete_pending" | "purged";

function tombstoneActionForStatus(status: TombstonedEpisodeStatus): "hide" | "delete" | "purge" {
  switch (status) {
    case "hidden":
      return "hide";
    case "delete_pending":
      return "delete";
    case "purged":
      return "purge";
  }
}
```

- [x] **Step 4.2: Add max sequence helper**

Add:

```ts
async function maxTombstoneSequence(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT MAX(sequence) AS max_sequence FROM tombstone_changes`,
  ).first<MaxSequenceRow>();
  return row?.max_sequence ?? 0;
}
```

- [x] **Step 4.3: Add tombstone handler**

Add `handleNasTombstones(request, env)`:

1. Require NAS auth.
2. Parse `cursor` with fallback `0`.
3. Parse `limit` with fallback `100`.
4. If `cursor === 0`, read high-watermark first:

```ts
const highWatermark = await maxTombstoneSequence(env);
```

5. Then query snapshot:

```sql
SELECT 0 AS sequence, feed_id, local_episode_id, status,
       updated_at AS created_at
  FROM episodes
 WHERE status IN ('hidden', 'delete_pending', 'purged')
 ORDER BY feed_id ASC, local_episode_id ASC
```

Map `action` in TypeScript with `tombstoneActionForStatus`.

6. For cursor snapshot, set `next_cursor = highWatermark` and `has_more = false`. Do not apply `limit` to snapshot rows in Phase 4A. If an admin mutation happens after the high-watermark read, it may appear in the snapshot and also be returned in the next incremental request; this duplicate is acceptable and safer than skipping it.
7. If `cursor > 0`, query:

```sql
SELECT sequence, feed_id, local_episode_id, status, action, created_at
  FROM tombstone_changes
 WHERE sequence > ?
 ORDER BY sequence ASC
 LIMIT ?
```

Bind `limit + 1`, return at most `limit`, `has_more = rows.length > limit`, and `next_cursor = max(returned.sequence, cursor)`.

Route:

```ts
if (url.pathname === "/api/nas/tombstones") {
  if (request.method !== "GET") return methodNotAllowed();
  return handleNasTombstones(request, env, url);
}
```

- [x] **Step 4.4: Extend fake D1 for tombstone reads**

In `cloudflare/worker/test/fake-d1.ts`:

- Support `SELECT MAX(sequence) AS max_sequence FROM tombstone_changes`.
- Support snapshot query from `episodes WHERE status IN ('hidden', 'delete_pending', 'purged')`.
- Support `SELECT ... FROM tombstone_changes WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`.
- Add `beforeTombstoneSnapshot?: () => void` so tests can insert a tombstone after high-watermark capture but before snapshot rows are read.

- [x] **Step 4.5: Add tombstone API tests**

Create `cloudflare/worker/test/tombstones.test.ts` with tests:

```ts
it("requires NAS auth for tombstones")
it("requires GET for tombstones")
it("validates cursor and limit")
it("returns cursor zero snapshot of tombstoned episodes")
it("does not include visible or pending episodes in cursor zero snapshot")
it("returns incremental tombstone changes ordered by sequence")
it("sets has_more when incremental results exceed limit")
it("returns empty incremental response without advancing cursor")
it("does not skip tombstones created during cursor zero snapshot")
```

Use `NAS_TOKEN: "secret"` and `Authorization: Bearer secret` helpers.

- [x] **Step 4.6: Verify tombstone API**

Run:

```bash
cd cloudflare/worker && npm test -- tombstones admin-actions
```

Expected: PASS.

---

## Task 5: Phase 4A Quality Gate And Commit

- [x] **Step 5.1: Worker gate**

Run:

```bash
cd cloudflare/worker
npm run check
npm run d1:check
npm run wrangler:check
```

Expected: PASS.

- [x] **Step 5.2: Go regression gate**

Run:

```bash
go test ./...
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS. This phase should not modify Go files, but the gate protects the repository.

- [x] **Step 5.3: Scope checks**

Run:

```bash
git diff -- .github Dockerfile 'Dockerfile.*'
git diff --check
git status --short
git diff --stat
```

Expected:

- no Docker/CI changes
- no Go production changes
- no NAS tombstone application
- no R2 delete/purge implementation
- no dashboard UI implementation beyond existing placeholder
- plan/design docs changed and Worker files/tests changed

- [x] **Step 5.4: Sub-agent implementation review**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify Phase 4A from docs/remote-control-plane.md is implemented only for Worker admin feed status,
  Worker admin episode hide/delete/restore, tombstone_changes, and NAS tombstone cursor API.
  Confirm NAS local tombstone application, R2 purge, OPML listing, event upload, dashboard UI,
  Docker/CI, and deployment changes are not included.

Quality reviewer:
  Review auth boundaries, bounded JSON parsing, D1 conditional update semantics, tombstone sequence behavior,
  fake D1 fidelity, API response contracts, and test coverage. Look for races that could write tombstones
  without matching episode state changes.
```

Expected: no blocking or important findings. Fix and re-review any blocking or important findings before commit.

- [x] **Step 5.5: Commit Phase 4A**

Run:

```bash
git add cloudflare/worker docs/superpowers/plans/2026-07-06-admin-tombstone-api.md
git add docs/remote-control-plane.md
git commit -m "feat: add admin tombstone api"
```

Do not push unless explicitly requested.
