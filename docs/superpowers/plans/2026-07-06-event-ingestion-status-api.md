# Event Ingestion And Status API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Worker-side Phase 5A API surface for NAS key event ingestion and admin status reads, without changing NAS runtime behavior yet.

**Architecture:** Reuse the existing D1 `sync_runs` and `events` tables. NAS sends a bounded JSON batch to `/api/nas/events/batch` with one run summary and zero or more key events; the Worker upserts the run summary and idempotently inserts events by `(run_id, sequence)`. Admin reads stay behind the existing Cloudflare Access guard through `/api/admin/sync-runs` and `/api/admin/events`.

**Tech Stack:** Cloudflare Worker TypeScript, D1, Vitest, existing fake D1 test harness.

---

## Scope Boundaries

This phase may modify:

- `cloudflare/worker/src/db.ts`
- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/test/fake-d1.ts`
- `cloudflare/worker/test/events-batch.test.ts`
- `cloudflare/worker/test/admin-status.test.ts`
- `docs/superpowers/plans/2026-07-06-event-ingestion-status-api.md`

This phase must not implement:

- NAS Go event collection, event outbox, or upload scheduling
- dashboard HTML/JS status panels
- retention cron
- R2 delete/purge or raw log upload
- feed create/edit/delete
- cookie/token/header redaction logic in Go
- D1 schema changes unless a reviewer finds a hard blocker
- Docker, CI, deployment, or live Cloudflare data changes

---

## Acceptance Criteria

- `POST /api/nas/events/batch` requires NAS Bearer auth.
- Event batch body is bounded by the existing JSON size limit and validates content type.
- Event batch upserts one `sync_runs` row by run id.
- Re-sending the same event `(run_id, sequence)` is idempotent and does not duplicate rows.
- A stale `running` batch does not regress an already-final `success`, `partial`, or `failed` run.
- Event type and level are restricted to the Phase 5 key-event whitelist.
- Event strings are length-limited so accidental huge logs are rejected early.
- `GET /api/admin/sync-runs` requires Cloudflare Access and returns recent run summaries.
- `GET /api/admin/events` requires Cloudflare Access and returns recent events.
- Admin list APIs validate `limit` and `offset`.
- No NAS Go or dashboard UI behavior changes in this phase.

---

## API Contracts

### NAS Event Batch

```http
POST /api/nas/events/batch
Authorization: Bearer <NAS_TOKEN>
Content-Type: application/json
```

Request:

```json
{
  "run": {
    "id": "2026-07-06T12:00:00Z-nas",
    "started_at": "2026-07-06T12:00:00Z",
    "finished_at": "2026-07-06T12:05:00Z",
    "status": "success",
    "feeds_updated": 3,
    "episodes_downloaded": 2,
    "episodes_uploaded": 2,
    "errors_count": 0
  },
  "events": [
    {
      "sequence": 1,
      "event_time": "2026-07-06T12:00:01Z",
      "level": "info",
      "type": "sync_run_started",
      "message": "sync started"
    },
    {
      "sequence": 2,
      "event_time": "2026-07-06T12:03:01Z",
      "level": "info",
      "type": "episode_upload_finished",
      "feed_id": "bili",
      "local_episode_id": "BV1",
      "message": "uploaded episode"
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "run_id": "2026-07-06T12:00:00Z-nas",
  "accepted_events": 2,
  "inserted_events": 2,
  "duplicate_events": 0
}
```

`events` may be an empty array when NAS only wants to update run summary. The maximum first-version batch size is 100 events.

### Admin Sync Runs

```http
GET /api/admin/sync-runs?limit=50&offset=0
Cf-Access-Jwt-Assertion: <present>
```

Response:

```json
{
  "limit": 50,
  "offset": 0,
  "sync_runs": [
    {
      "id": "2026-07-06T12:00:00Z-nas",
      "started_at": "2026-07-06T12:00:00Z",
      "finished_at": "2026-07-06T12:05:00Z",
      "status": "success",
      "feeds_updated": 3,
      "episodes_downloaded": 2,
      "episodes_uploaded": 2,
      "errors_count": 0
    }
  ]
}
```

### Admin Events

```http
GET /api/admin/events?limit=50&offset=0
Cf-Access-Jwt-Assertion: <present>
```

Response:

```json
{
  "limit": 50,
  "offset": 0,
  "events": [
    {
      "run_id": "2026-07-06T12:00:00Z-nas",
      "sequence": 2,
      "event_time": "2026-07-06T12:03:01Z",
      "level": "info",
      "type": "episode_upload_finished",
      "feed_id": "bili",
      "local_episode_id": "BV1",
      "message": "uploaded episode",
      "error_code": null,
      "error_detail": null
    }
  ]
}
```

---

## Design Decisions

- Keep this phase Worker-only. NAS collection/upload is Phase 5B so production podsync behavior remains unchanged.
- Use existing `sync_runs` and `events` tables; no migration is needed.
- Require one run summary per batch. This makes `/api/admin/sync-runs` useful before the NAS uploader is implemented.
- Events do not carry their own `run_id`; they inherit `body.run.id`, avoiding mismatched run ids inside one request.
- Use `INSERT OR IGNORE` for events to make retry idempotency cheap and aligned with existing `UNIQUE(run_id, sequence)`.
- Upsert sync run summaries conservatively: final statuses are allowed to replace `running`, but a later stale `running` retry must not replace an already-final row.
- API validation only caps and validates payload shape. Redaction of cookie/token/header text belongs to the NAS event producer in Phase 5B.

---

## Task 1: Types And Validators

**Files:**

- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/src/index.ts`

- [ ] **Step 1.1: Add event/run types**

Add to `cloudflare/worker/src/db.ts` near the existing request/row types:

```ts
export type SyncRunStatus = "running" | "success" | "partial" | "failed";
export type EventLevel = "debug" | "info" | "warn" | "error";

export type RemoteEventType =
  | "sync_run_started"
  | "sync_run_finished"
  | "remote_config_fetched"
  | "remote_config_fallback_used"
  | "remote_config_invalid"
  | "feed_update_started"
  | "feed_update_finished"
  | "feed_update_failed"
  | "episode_discovered"
  | "episode_download_finished"
  | "episode_download_failed"
  | "episode_upload_finished"
  | "episode_upload_failed"
  | "episode_report_finished"
  | "episode_report_failed"
  | "tombstone_fetched"
  | "tombstone_applied"
  | "tombstone_apply_failed"
  | "r2_probe_failed"
  | "remote_api_failed"
  | "cookie_profile_missing"
  | "cookie_profile_invalid";

export interface SyncRunUpsertRequest {
  id: string;
  started_at: string;
  finished_at?: string | null;
  status: SyncRunStatus;
  feeds_updated: number;
  episodes_downloaded: number;
  episodes_uploaded: number;
  errors_count: number;
}

export interface RemoteEventInput {
  sequence: number;
  event_time: string;
  level: EventLevel;
  type: RemoteEventType;
  feed_id?: string | null;
  local_episode_id?: string | null;
  message?: string | null;
  error_code?: string | null;
  error_detail?: string | null;
}

export interface EventBatchRequest {
  run: SyncRunUpsertRequest;
  events: RemoteEventInput[];
}

export interface AdminSyncRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: SyncRunStatus;
  feeds_updated: number;
  episodes_downloaded: number;
  episodes_uploaded: number;
  errors_count: number;
}

export interface AdminEventRow {
  run_id: string;
  sequence: number;
  event_time: string;
  level: EventLevel;
  type: RemoteEventType;
  feed_id: string | null;
  local_episode_id: string | null;
  message: string | null;
  error_code: string | null;
  error_detail: string | null;
}
```

- [ ] **Step 1.2: Import the new types**

Update the type import in `cloudflare/worker/src/index.ts`:

```ts
AdminEventRow,
AdminSyncRunRow,
EventBatchRequest,
EventLevel,
RemoteEventInput,
RemoteEventType,
SyncRunStatus,
SyncRunUpsertRequest,
```

- [ ] **Step 1.3: Add constants and simple validators**

Add in `cloudflare/worker/src/index.ts` near the other module constants:

```ts
const maxEventBatchEvents = 100;
const maxRunIDLength = 128;
const maxEventTypeLength = 64;
const maxEventMessageLength = 512;
const maxEventCodeLength = 128;
const maxEventDetailLength = 2048;
const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

const syncRunStatuses = new Set<SyncRunStatus>(["running", "success", "partial", "failed"]);
const eventLevels = new Set<EventLevel>(["debug", "info", "warn", "error"]);
const remoteEventTypes = new Set<RemoteEventType>([
  "sync_run_started",
  "sync_run_finished",
  "remote_config_fetched",
  "remote_config_fallback_used",
  "remote_config_invalid",
  "feed_update_started",
  "feed_update_finished",
  "feed_update_failed",
  "episode_discovered",
  "episode_download_finished",
  "episode_download_failed",
  "episode_upload_finished",
  "episode_upload_failed",
  "episode_report_finished",
  "episode_report_failed",
  "tombstone_fetched",
  "tombstone_applied",
  "tombstone_apply_failed",
  "r2_probe_failed",
  "remote_api_failed",
  "cookie_profile_missing",
  "cookie_profile_invalid",
]);
```

Add helpers:

```ts
function validDateString(value: string): boolean {
  const match = utcTimestampPattern.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const [, year, month, day, hour, minute, second] = match;
  return parsed.getUTCFullYear() === Number(year)
    && parsed.getUTCMonth() + 1 === Number(month)
    && parsed.getUTCDate() === Number(day)
    && parsed.getUTCHours() === Number(hour)
    && parsed.getUTCMinutes() === Number(minute)
    && parsed.getUTCSeconds() === Number(second);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function optionalBoundedString(value: unknown, maxLength: number, name: string): string | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return badRequest(`${name} must be string`);
  if (value.length > maxLength) return badRequest(`${name} is too long`);
  return value;
}
```

- [ ] **Step 1.4: Parse sync run summary**

Add:

```ts
function parseSyncRunUpsert(value: unknown): SyncRunUpsertRequest | Response {
  if (!value || typeof value !== "object") return badRequest("run is required");
  const run = value as Record<string, unknown>;
  if (!nonEmptyString(run.id) || run.id.length > maxRunIDLength) return badRequest("run.id is invalid");
  if (!nonEmptyString(run.started_at) || !validDateString(run.started_at)) return badRequest("run.started_at is invalid");
  const finishedAt = run.finished_at;
  let finishedAtValue: string | null = null;
  if (finishedAt !== undefined && finishedAt !== null && (!nonEmptyString(finishedAt) || !validDateString(finishedAt))) {
    return badRequest("run.finished_at is invalid");
  }
  if (typeof finishedAt === "string") finishedAtValue = finishedAt;
  if (typeof run.status !== "string" || !syncRunStatuses.has(run.status as SyncRunStatus)) {
    return badRequest("run.status is invalid");
  }
  const status = run.status as SyncRunStatus;
  if (status === "running" && finishedAtValue !== null) {
    return badRequest("run.finished_at must be null while running");
  }
  if (status !== "running" && finishedAtValue === null) {
    return badRequest("run.finished_at is required for final status");
  }
  if (finishedAtValue !== null && finishedAtValue < run.started_at) {
    return badRequest("run.finished_at must be after started_at");
  }
  const feedsUpdated = run.feeds_updated;
  if (!nonNegativeInteger(feedsUpdated)) return badRequest("run.feeds_updated is invalid");
  const episodesDownloaded = run.episodes_downloaded;
  if (!nonNegativeInteger(episodesDownloaded)) return badRequest("run.episodes_downloaded is invalid");
  const episodesUploaded = run.episodes_uploaded;
  if (!nonNegativeInteger(episodesUploaded)) return badRequest("run.episodes_uploaded is invalid");
  const errorsCount = run.errors_count;
  if (!nonNegativeInteger(errorsCount)) return badRequest("run.errors_count is invalid");
  return {
    id: run.id,
    started_at: run.started_at,
    finished_at: finishedAtValue,
    status,
    feeds_updated: feedsUpdated,
    episodes_downloaded: episodesDownloaded,
    episodes_uploaded: episodesUploaded,
    errors_count: errorsCount,
  };
}
```

- [ ] **Step 1.5: Parse event input**

Add:

```ts
function parseRemoteEvent(value: unknown): RemoteEventInput | Response {
  if (!value || typeof value !== "object") return badRequest("event is invalid");
  const event = value as Record<string, unknown>;
  if (!positiveInteger(event.sequence)) return badRequest("event.sequence is invalid");
  if (!nonEmptyString(event.event_time) || !validDateString(event.event_time)) return badRequest("event.event_time is invalid");
  if (typeof event.level !== "string" || !eventLevels.has(event.level as EventLevel)) {
    return badRequest("event.level is invalid");
  }
  if (typeof event.type !== "string" || event.type.length > maxEventTypeLength || !remoteEventTypes.has(event.type as RemoteEventType)) {
    return badRequest("event.type is invalid");
  }

  const feedID = optionalBoundedString(event.feed_id, maxRunIDLength, "event.feed_id");
  if (feedID instanceof Response) return feedID;
  const localEpisodeID = optionalBoundedString(event.local_episode_id, maxRunIDLength, "event.local_episode_id");
  if (localEpisodeID instanceof Response) return localEpisodeID;
  const message = optionalBoundedString(event.message, maxEventMessageLength, "event.message");
  if (message instanceof Response) return message;
  const errorCode = optionalBoundedString(event.error_code, maxEventCodeLength, "event.error_code");
  if (errorCode instanceof Response) return errorCode;
  const errorDetail = optionalBoundedString(event.error_detail, maxEventDetailLength, "event.error_detail");
  if (errorDetail instanceof Response) return errorDetail;

  return {
    sequence: event.sequence,
    event_time: event.event_time,
    level: event.level as EventLevel,
    type: event.type as RemoteEventType,
    feed_id: feedID,
    local_episode_id: localEpisodeID,
    message,
    error_code: errorCode,
    error_detail: errorDetail,
  };
}
```

- [ ] **Step 1.6: Parse event batch**

Add:

```ts
function parseEventBatch(body: unknown): EventBatchRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid event batch body");
  const value = body as Record<string, unknown>;
  const run = parseSyncRunUpsert(value.run);
  if (run instanceof Response) return run;
  if (!Array.isArray(value.events)) return badRequest("events must be array");
  if (value.events.length > maxEventBatchEvents) return badRequest("events batch is too large");
  const events: RemoteEventInput[] = [];
  const seenSequences = new Set<number>();
  for (const rawEvent of value.events) {
    const event = parseRemoteEvent(rawEvent);
    if (event instanceof Response) return event;
    if (seenSequences.has(event.sequence)) return badRequest("event.sequence is duplicated");
    seenSequences.add(event.sequence);
    events.push(event);
  }
  return { run, events };
}
```

- [ ] **Step 1.7: Verify type slice**

Run:

```bash
cd cloudflare/worker && npm run typecheck
```

Expected: PASS.

---

## Task 2: NAS Event Batch API

**Files:**

- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Create: `cloudflare/worker/test/events-batch.test.ts`

- [ ] **Step 2.1: Add sync run upsert SQL helper**

Add:

```ts
function syncRunUpsertSQL(): string {
  return `INSERT INTO sync_runs (
            id, started_at, finished_at, status, feeds_updated,
            episodes_downloaded, episodes_uploaded, errors_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            started_at = CASE
              WHEN sync_runs.status = 'running' AND excluded.started_at < sync_runs.started_at THEN excluded.started_at
              ELSE sync_runs.started_at
            END,
            finished_at = CASE
              WHEN sync_runs.status = 'running' THEN excluded.finished_at
              ELSE sync_runs.finished_at
            END,
            status = CASE
              WHEN sync_runs.status = 'running' THEN excluded.status
              ELSE sync_runs.status
            END,
            feeds_updated = max(sync_runs.feeds_updated, excluded.feeds_updated),
            episodes_downloaded = max(sync_runs.episodes_downloaded, excluded.episodes_downloaded),
            episodes_uploaded = max(sync_runs.episodes_uploaded, excluded.episodes_uploaded),
            errors_count = max(sync_runs.errors_count, excluded.errors_count)`;
}
```

This uses fixed UTC second-resolution timestamp strings so raw `TEXT` comparison matches chronological order and can use the existing timestamp indexes. It keeps final statuses and final timestamps from being overwritten by any later retry. The first final status for a `run_id` wins; counters can still increase by `max(...)`.

- [ ] **Step 2.2: Add event insert SQL helper**

Add:

```ts
function eventInsertSQL(): string {
  return `INSERT OR IGNORE INTO events (
            run_id, sequence, event_time, level, type, feed_id,
            local_episode_id, message, error_code, error_detail
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}
```

- [ ] **Step 2.3: Implement `handleNasEventsBatch`**

Add:

```ts
async function handleNasEventsBatch(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorizedNasRequest(request, env))) {
    return text("unauthorized", 401);
  }
  const rawBody = await readBoundedJson(request);
  if (rawBody instanceof Response) return rawBody;

  const parsed = parseEventBatch(rawBody);
  if (parsed instanceof Response) return parsed;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(syncRunUpsertSQL()).bind(
      parsed.run.id,
      parsed.run.started_at,
      parsed.run.finished_at ?? null,
      parsed.run.status,
      parsed.run.feeds_updated,
      parsed.run.episodes_downloaded,
      parsed.run.episodes_uploaded,
      parsed.run.errors_count,
    ),
  ];

  for (const event of parsed.events) {
    statements.push(env.DB.prepare(eventInsertSQL()).bind(
      parsed.run.id,
      event.sequence,
      event.event_time,
      event.level,
      event.type,
      event.feed_id ?? null,
      event.local_episode_id ?? null,
      event.message ?? null,
      event.error_code ?? null,
      event.error_detail ?? null,
    ));
  }

  const results = await env.DB.batch(statements);
  const insertedEvents = results.slice(1).reduce((count, result) => count + (result.meta.changes ?? 0), 0);

  return Response.json({
    ok: true,
    run_id: parsed.run.id,
    accepted_events: parsed.events.length,
    inserted_events: insertedEvents,
    duplicate_events: parsed.events.length - insertedEvents,
  });
}
```

- [ ] **Step 2.4: Wire NAS route**

Inside the top-level fetch route block:

```ts
if (url.pathname === "/api/nas/events/batch") {
  if (request.method !== "POST") return methodNotAllowed();
  return handleNasEventsBatch(request, env);
}
```

Keep this route under NAS Bearer auth in the handler. Do not place it under the admin Access guard.

- [ ] **Step 2.5: Extend fake D1 state**

In `cloudflare/worker/test/fake-d1.ts`, add:

```ts
syncRunsByID?: Map<string, FakeSyncRunRow> | undefined;
eventsByKey?: Map<string, FakeEventRow> | undefined;
```

Add row interfaces matching `sync_runs` and `events`. Event key should be:

```ts
export function fakeEventKey(runID: string, sequence: number): string {
  return `${runID}\0${sequence}`;
}
```

Update `cloneOptions` and `commitOptions` to clone/commit both maps.

- [ ] **Step 2.6: Extend fake D1 writes**

In `FakeStatement.runWithOptions`, support:

- SQL containing `INSERT INTO sync_runs` and `ON CONFLICT(id)`.
- SQL containing `INSERT OR IGNORE INTO events`.

Implement fake sync run upsert with the same final-status protection as production SQL:

```ts
if (!existing || existing.status === "running") {
  status = incoming.status;
  started_at = earlierTimestamp(existing?.started_at, incoming.started_at);
  finished_at = incoming.finished_at;
} else {
  status = existing.status;
  started_at = existing.started_at;
  finished_at = existing.finished_at;
}
```

Use max counters and preserve final `started_at` / `finished_at` once a run leaves `running`.

Add this helper for fake sync run ordering:

```ts
function earlierTimestamp(current: string | undefined, incoming: string): string {
  if (current === undefined) return incoming;
  return incoming < current ? incoming : current;
}
```

For events, insert only when `fakeEventKey(runID, sequence)` does not already exist; set `changes = 1` for new rows and `0` for duplicates.

- [ ] **Step 2.7: Add NAS event batch tests**

Create `cloudflare/worker/test/events-batch.test.ts` with helpers:

```ts
const token = "secret-token";

function batchRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request("https://podcast.example.com/api/nas/events/batch", {
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
```

Tests:

```ts
it("requires NAS auth for event batches")
it("requires POST for event batches")
it("validates event batch content type and JSON")
it("validates run summary and event fields")
it("rejects JS-only date strings that SQLite datetime cannot order")
it("rejects invalid status and finished_at combinations")
it("rejects duplicate event sequences within one batch")
it("rejects oversized event batches and overlong strings")
it("upserts a sync run and inserts events")
it("uses conflict-safe sync run and event insert SQL")
it("ignores duplicate events on retry")
it("does not regress a final sync run to running")
it("does not let stale retries change final sync run finished_at")
it("allows an empty event array while updating run summary")
```

The date validation test must reject JS-only dates, invalid calendar dates, and fractional-second timestamps such as `2026-07-06T12:00:00.123Z`. The `status` / `finished_at` test must reject `running` with `finished_at`, final statuses without `finished_at`, and final runs where `finished_at < started_at`.

The SQL-shape test must inspect `sqlLog` and assert it contains:

```text
ON CONFLICT(id) DO UPDATE
CASE
max(sync_runs.feeds_updated, excluded.feeds_updated)
INSERT OR IGNORE INTO events
```

- [ ] **Step 2.8: Verify NAS event batch slice**

Run:

```bash
cd cloudflare/worker && npm test -- events-batch auth-routes
```

Expected: PASS.

---

## Task 3: Admin Status Read APIs

**Files:**

- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Create: `cloudflare/worker/test/admin-status.test.ts`

- [ ] **Step 3.1: Implement `handleAdminSyncRuns`**

Add:

```ts
async function handleAdminSyncRuns(url: URL, env: Env): Promise<Response> {
  const limit = adminListLimit(url, 50, 200);
  if (limit instanceof Response) return limit;
  const offset = adminListOffset(url);
  if (offset instanceof Response) return offset;

  const { results } = await env.DB.prepare(
    `SELECT id, started_at, finished_at, status, feeds_updated,
            episodes_downloaded, episodes_uploaded, errors_count
       FROM sync_runs
      ORDER BY started_at DESC, id DESC
      LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<AdminSyncRunRow>();

  return Response.json({ limit, offset, sync_runs: results });
}
```

- [ ] **Step 3.2: Implement `handleAdminEvents`**

Add:

```ts
async function handleAdminEvents(url: URL, env: Env): Promise<Response> {
  const limit = adminListLimit(url, 50, 200);
  if (limit instanceof Response) return limit;
  const offset = adminListOffset(url);
  if (offset instanceof Response) return offset;

  const { results } = await env.DB.prepare(
    `SELECT run_id, sequence, event_time, level, type, feed_id,
            local_episode_id, message, error_code, error_detail
       FROM events
      ORDER BY event_time DESC, run_id DESC, sequence DESC
      LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<AdminEventRow>();

  return Response.json({ limit, offset, events: results });
}
```

- [ ] **Step 3.3: Wire admin status routes**

Inside the existing `/api/admin/*` guarded block:

```ts
if (url.pathname === "/api/admin/sync-runs") {
  if (request.method !== "GET") return methodNotAllowed();
  return handleAdminSyncRuns(url, env);
}
if (url.pathname === "/api/admin/events") {
  if (request.method !== "GET") return methodNotAllowed();
  return handleAdminEvents(url, env);
}
```

Keep these routes inside the Cloudflare Access guard.

- [ ] **Step 3.4: Extend fake D1 reads**

In `cloudflare/worker/test/fake-d1.ts`, support:

- admin sync run query from `FROM sync_runs`.
- admin events query from `FROM events`.

Sort sync runs by fixed UTC second-resolution text with `started_at DESC, id DESC`. Sort events by fixed UTC second-resolution text with `event_time DESC, run_id DESC, sequence DESC`. Apply `LIMIT ? OFFSET ?`.

- [ ] **Step 3.5: Add admin status tests**

Create `cloudflare/worker/test/admin-status.test.ts` with:

```ts
it("requires Cloudflare Access for admin sync runs")
it("requires Cloudflare Access for admin events")
it("requires GET for admin sync runs and events")
it("lists recent sync runs with limit and offset")
it("lists recent events with limit and offset")
it("validates admin status list params")
```

Use fake D1 maps directly instead of going through the NAS write API; NAS write behavior is covered by `events-batch.test.ts`.

- [ ] **Step 3.6: Verify admin status slice**

Run:

```bash
cd cloudflare/worker && npm test -- admin-status events-batch auth-routes
```

Expected: PASS.

---

## Task 4: Phase 5A Quality Gate And Commit

- [ ] **Step 4.1: Worker gate**

Run:

```bash
cd cloudflare/worker
npm run check
npm run d1:check
npm run wrangler:check
```

Expected: PASS. `wrangler:check` is a local dry-run check and must not deploy or mutate live Cloudflare data.

- [ ] **Step 4.2: Go regression gate**

Run:

```bash
go test ./...
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS. This phase should not modify Go files, but this protects the repo.

- [ ] **Step 4.3: Scope checks**

Run:

```bash
git diff -- cmd pkg services .github Dockerfile 'Dockerfile.*'
git diff --check
git status --short --branch
git diff --stat
```

Expected:

- no Go production changes
- no NAS event uploader
- no dashboard UI
- no Docker/CI changes
- no retention cron
- Worker source/tests plus this plan changed

- [ ] **Step 4.4: Sub-agent implementation review**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify Phase 5A implements only Worker NAS event batch ingestion and admin status read APIs.
  Confirm no NAS Go event collection/upload, dashboard UI, retention cron, R2 purge, Docker/CI, or live CF data changes.

Quality reviewer:
  Review NAS auth boundary, Access boundary, idempotency, final-status protection, validation limits,
  event whitelist, fake D1 fidelity, and test coverage.
```

Expected: no blocking or important findings. Fix and re-review any blocking or important findings before commit.

- [ ] **Step 4.5: Commit Phase 5A**

Run:

```bash
git add cloudflare/worker docs/superpowers/plans/2026-07-06-event-ingestion-status-api.md
git commit -m "feat: add event ingestion status api"
```

Do not push unless explicitly requested.
