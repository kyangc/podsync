# Episode Upsert And Worker RSS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 3C: after NAS uploads media to R2, upsert episode metadata to the Cloudflare Worker and render visible episodes in Worker RSS feeds.

**Architecture:** Keep the existing local NAS podcast flow intact. The Phase 3B `services/remote.Processor` remains the local outbox worker. Phase 3C extends it so a task is marked locally complete only after R2 Put/Head succeeds and the Worker `POST /api/nas/episodes/upsert` accepts the episode. The Worker persists episode metadata in D1 with status-protection semantics, and public `/f/<feed_token>.xml` renders D1 `visible` episodes with enclosure URLs built from `MEDIA_PUBLIC_BASE_URL` plus `r2_key`.

**Cloudflare constraints:** Follow current Workers guidance: use D1 binding access through `env`, do not store secrets in source, do not introduce request-scoped module globals, await all async work, keep `ctx` binding intact if used, and validate with `npm run check`, `npm run d1:check`, and `npm run wrangler:check`.

---

## Scope Boundaries

This phase may modify:

- `pkg/model/remote.go`
- `pkg/db/remote_outbox.go`
- `pkg/db/remote_outbox_test.go`
- `services/update/updater.go`
- `services/update/updater_test.go`
- `services/remote/client.go`
- `services/remote/client_test.go`
- `services/remote/processor.go`
- `services/remote/processor_test.go`
- `cmd/podsync/remote_publish.go`
- `cmd/podsync/remote_publish_test.go`
- `cloudflare/worker/src/auth.ts`
- `cloudflare/worker/src/db.ts`
- `cloudflare/worker/src/env.ts`
- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/src/xml.ts`
- `cloudflare/worker/wrangler.jsonc`
- `cloudflare/worker/test/fake-d1.ts`
- `cloudflare/worker/test/*episode*.test.ts`
- `cloudflare/worker/test/public-feeds.test.ts`
- `docs/superpowers/plans/2026-07-06-episode-upsert-rss.md`

This phase must not implement:

- dashboard CRUD
- admin episode hide/delete/restore UI or APIs
- tombstone pull/apply on NAS
- event batch upload or sync run logging
- OPML feed listing changes
- R2 delete/purge
- historical backfill of already downloaded episodes
- NAS live config edits or deployment changes
- Docker or GitHub Actions changes

---

## Acceptance Criteria

- `RemotePublishTask` stores enough episode metadata for upsert without needing current feed config at publish time: provider, source episode id, title, description, thumbnail, duration, source URL, published date, R2 asset fields, and server episode status.
- New downloads enqueue remote publish tasks with provider/source metadata; re-enqueue refreshes local episode metadata but preserves existing remote asset/upsert state.
- Processor uploads to R2, calls Worker episode upsert, and only then marks task `succeeded`.
- If Worker upsert fails, the task remains retryable, preserves the R2 key/token/MIME, records `LastError`, and can retry later.
- If Worker upsert returns a protected server status such as `hidden`, `delete_pending`, or `purged`, the local task is still completed because the server accepted the metadata and intentionally keeps it out of RSS.
- Worker `POST /api/nas/episodes/upsert` requires NAS bearer auth, JSON content, bounded request bodies, validates required fields, and is atomically idempotent on `feed_id + local_episode_id`.
- Worker upsert never turns `hidden`, `delete_pending`, or `purged` episodes back into `visible`.
- Public feed RSS renders visible episodes with valid `<item>` and `<enclosure>` elements.
- Empty feeds remain valid RSS and do not require `MEDIA_PUBLIC_BASE_URL`.
- Visible episode RSS requires `MEDIA_PUBLIC_BASE_URL`; if missing, return a clear 500 instead of emitting broken enclosure URLs.
- No dashboard, tombstone, event logging, OPML listing, R2 purge, Docker, CI, or NAS live config changes.

---

## Task 1: Extend Local Remote Publish Metadata

**Files:**

- Modify: `pkg/model/remote.go`
- Modify: `pkg/db/remote_outbox.go`
- Modify: `pkg/db/remote_outbox_test.go`
- Modify: `services/update/updater.go`
- Modify: `services/update/updater_test.go`

- [x] **Step 1.1: Extend task model**

Add fields:

```go
type RemotePublishTask struct {
	Provider        Provider  `json:"provider"`
	SourceEpisodeID string    `json:"source_episode_id"`
	Description     string    `json:"description"`
	Thumbnail       string    `json:"thumbnail"`
	Duration        int64     `json:"duration"`
	ServerStatus    string    `json:"server_status"`
	UpsertedAt      time.Time `json:"upserted_at"`
}
```

Use the existing `Provider` type from `pkg/model`; do not introduce a duplicate provider enum.

- [x] **Step 1.2: Populate metadata at enqueue time**

In `services/update/updater.go`, update `enqueueRemotePublishTask`:

- Parse provider from `feedConfig.URL` using existing `builder.ParseURL`.
- Set `Provider` to parsed provider.
- Set `SourceEpisodeID` to `episode.ID` for now. This preserves the design contract and can be widened later if a provider exposes a different source id.
- Copy `Description`, `Thumbnail`, and `Duration`.
- Keep warn-only behavior at call sites if enqueue fails.

- [x] **Step 1.3: Preserve remote state on idempotent enqueue**

For an existing task, refresh:

```text
Provider
SourceEpisodeID
MediaPath
Size
Title
Description
Thumbnail
Duration
SourceURL
PublishedAt
UpdatedAt
```

Preserve:

```text
Status
Attempts
NextAttemptAt
LastError
R2Key
AssetToken
MimeType
ServerStatus
UpsertedAt
CompletedAt
CreatedAt
```

- [x] **Step 1.4: Extend complete transition**

Change `CompleteRemotePublishTask` to accept a server status:

```go
func (b *Badger) CompleteRemotePublishTask(_ context.Context, id string, serverStatus string, now time.Time) error
```

Semantics:

- Set `Status=succeeded`, clear `LastError`, clear `NextAttemptAt`, set `CompletedAt` and `UpdatedAt`.
- If `serverStatus != ""`, set `ServerStatus=serverStatus` and `UpsertedAt=now`.
- Preserve R2 asset fields.

Update all call sites and tests.

- [x] **Step 1.5: Add tests**

Add/extend tests:

```go
func TestEnqueueRemotePublishTaskRecordsProviderAndEpisodeMetadata(t *testing.T)
func TestEnqueueRemotePublishTaskReturnsProviderParseError(t *testing.T)
func TestBadger_EnqueueRemotePublishTaskPreservesRemoteUpsertState(t *testing.T)
func TestBadger_CompleteRemotePublishTaskRecordsServerStatus(t *testing.T)
```

Run:

```bash
go test ./services/update ./pkg/db -run 'TestEnqueueRemotePublishTask|TestBadger_EnqueueRemotePublishTaskPreservesRemoteUpsertState|TestBadger_CompleteRemotePublishTaskRecordsServerStatus'
```

Expected: PASS.

---

## Task 2: Worker Episode Upsert API

**Files:**

- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Add: `cloudflare/worker/test/episode-upsert.test.ts`

- [x] **Step 2.1: Add request/row types**

In `src/db.ts`, add:

```ts
export type EpisodeStatus = "pending" | "visible" | "hidden" | "delete_pending" | "purged";

export interface EpisodeUpsertRequest {
  feed_id: string;
  provider: "youtube" | "bilibili";
  source_episode_id: string;
  local_episode_id: string;
  source_url?: string;
  thumbnail?: string;
  title?: string;
  description?: string;
  published_at?: string;
  duration?: number;
  r2_key: string;
  size: number;
  mime_type: string;
  asset_token: string;
}
```

Keep validation code local and explicit; do not add a schema library in this phase.

- [x] **Step 2.2: Add NAS route**

Add route:

```text
POST /api/nas/episodes/upsert
Authorization: Bearer <NAS_TOKEN>
Content-Type: application/json
```

Behavior:

- Reject unauthorized with 401.
- Reject non-POST with 405.
- Reject missing or non-JSON `Content-Type`, oversized body over 64 KiB, invalid JSON, unsupported provider, missing required fields, invalid `size`, invalid `duration`, or unparsable `published_at` with 400.
- Implement bounded body parsing with a helper that reads the request stream in chunks and stops once it exceeds 64 KiB; do not use unbounded `request.text()` / `request.json()` for this route.
- Return 404 if `feed_id` does not exist.
- Return 400 if request provider does not match feed provider.
- Insert missing episode with `status='visible'`.
- Update existing episodes with SQL status protection: `status = CASE WHEN status IN ('pending', 'visible') THEN 'visible' ELSE status END`.
- That means existing `pending` or `visible` rows become/remain `visible`, while `hidden`, `delete_pending`, and `purged` rows keep their protected status even if a dashboard mutation happens between read and write.
- Insert and update statements must set `updated_at = CURRENT_TIMESTAMP`; inserts should also set `created_at = CURRENT_TIMESTAMP` explicitly or rely on the schema default.
- Return JSON:

```json
{
  "ok": true,
  "feed_id": "...",
  "local_episode_id": "...",
  "status": "visible"
}
```

Do not write tombstone changes in this phase. Dashboard visibility changes remain future work.

- [x] **Step 2.3: D1 query shape**

Avoid relying on SQLite `RETURNING`; use simple D1-compatible steps with one atomic UPSERT:

1. Select feed provider.
2. Execute one `INSERT ... ON CONFLICT(feed_id, local_episode_id) DO UPDATE ...` statement.
3. Select final status.

The UPSERT must include:

```sql
status = CASE
  WHEN episodes.status IN ('pending', 'visible') THEN 'visible'
  ELSE episodes.status
END,
updated_at = CURRENT_TIMESTAMP
```

Do not implement this as `SELECT then INSERT else UPDATE`; two concurrent NAS retries could both see no row and race on the unique key.

All D1 calls must be awaited. Do not use module-level mutable request state.

- [x] **Step 2.4: Tests**

Extend `fake-d1.ts` to support:

- feed lookup by `feed_id`
- episode lookup by `feed_id + local_episode_id`
- insert/update episode state
- final status select
- SQL capture or a fake transition hook that can prove the UPSERT uses `ON CONFLICT` plus `CASE`

Add tests:

```ts
it("requires NAS auth for episode upsert")
it("requires POST for episode upsert")
it("validates episode upsert body")
it("rejects oversized episode upsert body")
it("rejects wrong content type")
it("rejects unparsable published_at")
it("inserts a new visible episode")
it("updates a visible episode idempotently")
it("updates pending to visible")
it("keeps hidden/delete_pending/purged episodes protected")
it("uses CASE status protection during update")
it("does not trust a stale pre-update status read")
it("rejects provider mismatch")
it("returns 404 for missing feed")
```

Run:

```bash
cd cloudflare/worker && npm test -- episode-upsert
```

Expected: PASS.

---

## Task 3: Worker RSS Visible Episodes

**Files:**

- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/src/env.ts`
- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/src/xml.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Modify: `cloudflare/worker/test/public-feeds.test.ts`

- [x] **Step 3.1: Add public episode row type**

Add:

```ts
export interface PublicEpisodeRow {
  local_episode_id: string;
  source_url: string | null;
  title: string | null;
  description: string | null;
  published_at: string | null;
  duration: number | null;
  r2_key: string;
  size: number;
  mime_type: string;
}
```

Extend `PublicFeedRow` with `page_size`.

- [x] **Step 3.2: Add media base env and config**

Add `MEDIA_PUBLIC_BASE_URL?: string` to the current Env type.

Add a non-secret placeholder var to `wrangler.jsonc`:

```jsonc
"vars": {
  "MEDIA_PUBLIC_BASE_URL": "https://media.example.com"
}
```

This value is a deployment-time public media base URL, not a secret. It must be an absolute `http` or `https` URL. The real deployment can override it per environment later. The project currently has a small hand-maintained `src/env.ts`; do not perform a broad generated-type migration in Phase 3C. Keep that as a separate cleanup if needed. Still run `npm run typecheck` and `npm run wrangler:check`.

- [x] **Step 3.3: Query visible episodes**

In `handleFeedXml`, after feed lookup:

```sql
SELECT local_episode_id, source_url, title, description, published_at, duration,
       r2_key, size, mime_type
  FROM episodes
 WHERE feed_id = ?
   AND status = 'visible'
   AND r2_key IS NOT NULL
 ORDER BY COALESCE(published_at, updated_at) DESC
 LIMIT ?
```

Use `feed.page_size` with a safe default such as 25.

- [x] **Step 3.4: Render RSS items**

Replace `renderEmptyRss` usage with `renderRss(metadata, episodes)`.

Item rules:

- `<rss>` root must include `xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"` whenever the renderer may emit iTunes tags. Prefer always adding it to keep empty and non-empty RSS rendering consistent.
- `title`: episode title or local episode id.
- `description`: episode description or empty.
- `link`: source URL if present.
- `guid isPermaLink="false"`: local episode id.
- `pubDate`: valid UTC string when `published_at` exists.
- `enclosure`: URL = `MEDIA_PUBLIC_BASE_URL` joined with the R2 key encoded per path segment while preserving `/` separators, length = size, type = MIME.
- `itunes:duration`: seconds when duration is positive.
- Reject empty R2 keys, absolute-looking keys, keys containing `..` path segments, and keys containing backslashes before generating enclosure URLs.
- The final enclosure URL must still be XML-escaped by the renderer.

Empty feeds still return valid RSS with no items and do not require `MEDIA_PUBLIC_BASE_URL`.

If visible episodes exist but `MEDIA_PUBLIC_BASE_URL` is missing, non-absolute, or not `http`/`https`, return 500 with a short text error.

- [x] **Step 3.5: Tests**

Update public feed tests:

- existing empty-feed test still passes with no item.
- visible episodes render item/enclosure/guid/pubDate.
- RSS root includes the iTunes namespace when `itunes:duration` is emitted.
- media URL generation preserves `/` separators in keys such as `audio/feed/episode.mp3` and encodes special characters per segment.
- invalid R2 keys are rejected and do not render broken enclosure URLs.
- enclosure URLs are XML-escaped.
- hidden/purged episodes are not returned by fake D1 and do not render.
- missing `MEDIA_PUBLIC_BASE_URL` with visible episodes returns 500.
- XML escaping covers title/description/source URL.

Run:

```bash
cd cloudflare/worker && npm test -- public-feeds
```

Expected: PASS.

---

## Task 4: NAS Episode Upsert Client And Processor Wiring

**Files:**

- Add: `services/remote/client.go`
- Add: `services/remote/client_test.go`
- Modify: `services/remote/processor.go`
- Modify: `services/remote/processor_test.go`
- Modify: `cmd/podsync/remote_publish.go`
- Modify: `cmd/podsync/remote_publish_test.go`

- [x] **Step 4.1: Add NAS client**

Create `services/remote/client.go`:

```go
type EpisodeUpsertResult struct {
	Status string `json:"status"`
}

type EpisodeUpserter interface {
	UpsertEpisode(ctx context.Context, task *model.RemotePublishTask) (*EpisodeUpsertResult, error)
}
```

`NASClient` behavior:

- Construct from `baseURL` and token.
- Validate base URL is absolute, scheme is `http` or `https`, and token is non-empty.
- Default HTTP client timeout should be 30 seconds; tests may inject a custom client/server.
- POST JSON to `/api/nas/episodes/upsert`.
- Set `Authorization: Bearer <token>` and `Content-Type: application/json`.
- Include all task metadata and R2 asset fields.
- Encode `PublishedAt` as RFC3339 when non-zero.
- Normalize legacy Phase 3B rows before POST:
  - if `SourceEpisodeID` is empty, use `LocalEpisodeID`.
  - if `Provider` is empty, infer it from legacy episode `SourceURL` with a small host/path helper, not `builder.ParseURL`. Current stored `SourceURL` values are episode URLs such as YouTube `/watch?v=...` and Bilibili `/video/BV...`, while `builder.ParseURL` is feed/list oriented.
  - if provider remains empty or unsupported, return a non-retryable validation error that the processor can mark terminal failed instead of retrying forever.
- For non-2xx responses, read at most 4 KiB of response body and return an error without logging token.
- Decode response status; if status is empty, return an error.

- [x] **Step 4.2: Processor calls upsert after upload**

Extend `Processor`:

```go
Upserter EpisodeUpserter
```

Flow:

1. Prepare attempt.
2. Put/Head upload.
3. If `Upserter != nil`, call `UpsertEpisode`.
4. If upsert fails with a non-retryable validation error caused by local task metadata, call `FailRemotePublishTask`; otherwise call `RetryRemotePublishTask`. Preserve R2 asset fields.
5. If upsert succeeds, call `CompleteRemotePublishTask(ctx, task.ID, result.Status, now)`.
6. If `Upserter == nil`, keep Phase 3B behavior and complete with empty server status.

Do not special-case `hidden`, `delete_pending`, or `purged` as failures; a 2xx upsert response means the server accepted the episode and decided visibility.

- [x] **Step 4.3: Cmd wiring**

In `cmd/podsync/remote_publish.go`:

- Add a factory for the NAS upserter using `cfg.Remote.BaseURL` and `cfg.Remote.Token`.
- `buildRemoteProcessor` should set both R2 publisher and NAS upserter when remote publish is enabled.
- Remote disabled/incomplete R2 still skips worker.

- [x] **Step 4.4: Tests**

Add tests:

```go
func TestNASClientUpsertEpisodePostsExpectedPayload(t *testing.T)
func TestNASClientUpsertEpisodeNormalizesLegacyTask(t *testing.T)
func TestInferProviderFromLegacyEpisodeURL(t *testing.T)
func TestNASClientRejectsUnsupportedLegacyProvider(t *testing.T)
func TestNASClientUpsertEpisodeRejectsNon2xx(t *testing.T)
func TestNASClientUpsertEpisodeTruncatesErrorBody(t *testing.T)
func TestNASClientDoesNotLeakTokenInErrors(t *testing.T)
func TestNASClientRequiresBaseURLAndToken(t *testing.T)
func TestNASClientRequiresHTTPOrHTTPSBaseURL(t *testing.T)
func TestProcessorUpsertsAfterUploadAndCompletesWithServerStatus(t *testing.T)
func TestProcessorRetriesWhenUpsertFails(t *testing.T)
func TestProcessorFailsNonRetryableUpsertValidation(t *testing.T)
func TestProcessorCompletesWhenUpsertReturnsHiddenStatus(t *testing.T)
func TestBuildRemoteProcessorAttachesUpserter(t *testing.T)
```

`TestInferProviderFromLegacyEpisodeURL` must cover at least:

- `https://www.youtube.com/watch?v=<id>` -> `youtube`
- `https://youtu.be/<id>` -> `youtube`
- `https://www.bilibili.com/video/<bvid>` -> `bilibili`
- unsupported hosts return empty/unsupported and are treated as non-retryable validation errors when provider is still missing.

Run:

```bash
go test ./services/remote ./cmd/podsync -run 'TestNASClient|TestInferProviderFromLegacyEpisodeURL|TestProcessor.*Upsert|TestBuildRemoteProcessor'
```

Expected: PASS.

---

## Task 5: Phase 3C Quality Gate And Commit

- [x] **Step 5.1: Go gate**

Run:

```bash
go test ./...
go test -race ./services/remote ./pkg/db ./cmd/podsync
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS.

- [x] **Step 5.2: Worker gate**

Run:

```bash
cd cloudflare/worker
npm run check
npm run d1:check
npm run wrangler:check
```

Expected: PASS.

- [x] **Step 5.3: Scope checks**

Run:

```bash
git diff -- .github Dockerfile 'Dockerfile.*'
git diff --check
git status --short
git diff --stat
```

Expected:

- no CI, Docker, or NAS live config changes.
- no dashboard/tombstone/event/OPML/R2 delete implementation.

- [x] **Step 5.4: Sub-agent implementation review**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify Phase 3C from docs/remote-control-plane.md is implemented:
  Worker episode upsert, upsert status protection, visible RSS items, NAS after-R2 upsert,
  no dashboard/tombstone/events/OPML/delete/history backfill scope creep.

Quality reviewer:
  Review Worker auth/validation/D1 idempotency, RSS XML escaping/enclosure URLs,
  NAS client HTTP behavior, processor retry/completion semantics, tests, and Cloudflare Worker best-practice risks.
```

Expected: no blocking or important findings. Fix and re-review any blocking or important findings before commit.

- [x] **Step 5.5: Commit Phase 3C**

Commit:

```bash
git add pkg/model pkg/db services/update services/remote cmd/podsync cloudflare/worker docs/superpowers/plans/2026-07-06-episode-upsert-rss.md
git commit -m "feat: upsert remote episodes and render rss"
```

Do not push unless explicitly requested.
