# Feed Metadata Upsert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the missing NAS feed metadata reporting path from `docs/remote-control-plane.md`: after a feed update succeeds on NAS, Podsync best-effort reports channel metadata to Cloudflare via `POST /api/nas/feed-metadata/upsert`, so Worker RSS/admin feed lists can use fresh source metadata.

**Architecture:** Add a small Worker NAS API that upserts `feed_metadata` by `feed_id`, guarded by NAS Bearer auth and provider/feed existence checks. Add a reusable Go NAS client method and an optional `services/update.Manager` feed metadata reporter. The updater calls the reporter only after provider `Build` and local `AddFeed` succeed. Reporter errors are warning-only and must not fail local update/download/XML/OPML.

**Tech Stack:** Go, existing `services/remote.NASClient`, existing `services/update.Manager` options, Cloudflare Worker TypeScript, D1, Vitest fake D1.

---

## Scope Boundaries

This phase may modify:

- `pkg/model/remote.go`
- `services/remote/client.go`
- `services/remote/client_test.go`
- `services/update/updater.go`
- `services/update/updater_test.go`
- `cmd/podsync/remote_publish.go`
- `cmd/podsync/remote_publish_test.go`
- `cmd/podsync/main.go`
- `cloudflare/worker/src/db.ts`
- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/test/fake-d1.ts`
- `cloudflare/worker/test/*.test.ts`
- `docs/superpowers/plans/2026-07-06-feed-metadata-upsert.md`

This phase must not implement:

- Dashboard UI.
- Feed create/edit/delete APIs.
- Changes to remote TOML schema or feed config resolver.
- Episode upsert changes unrelated to feed metadata.
- R2 upload/purge changes.
- Event/log ingestion changes.
- Docker, GitHub Actions, NAS deployment, or live Cloudflare deployment.
- Cookie or token management.

---

## Acceptance Criteria

- Worker exposes `POST /api/nas/feed-metadata/upsert`.
- The endpoint requires NAS Bearer auth and `Content-Type: application/json`.
- The endpoint rejects non-POST requests through the existing route method gate.
- Payload requires `feed_id`, `provider`, `source_url`, and `reported_at`.
- `provider` accepts only `youtube` and `bilibili` for this phase, matching remote feeds supported by current control-plane TOML.
- Optional fields: `title`, `description`, `image_url`, `link`, `author`, `category`, `language`, `explicit`, `last_source_update_at`.
- Timestamp fields must be strict UTC second `YYYY-MM-DDTHH:MM:SSZ`, matching existing event timestamp strictness.
- Worker returns `404` when `feed_id` does not exist.
- Worker returns `400` on provider mismatch.
- Successful upsert writes exactly one `feed_metadata` row keyed by `feed_id` and updates existing metadata idempotently.
- Existing admin feed list and public RSS channel metadata automatically reflect the upserted metadata through their current `LEFT JOIN feed_metadata` queries.
- Go `NASClient` can post feed metadata and redacts remote token/common sensitive text in errors.
- `remote.enabled=false` or missing `remote.base_url`/`remote.token` does not create or call the reporter.
- Feed metadata reporting is optional and best-effort: failure logs warning and does not fail local update flow.
- NAS reports metadata only after provider build and local `AddFeed` succeed. Feed update failures must not overwrite old remote metadata.
- Worker tests, Go tests, D1 check, Wrangler dry-run, scope diff, and whitespace check pass.

---

## Contract

Request:

```http
POST /api/nas/feed-metadata/upsert
Authorization: Bearer <NAS_TOKEN>
Content-Type: application/json
```

```json
{
  "feed_id": "tangpingshu",
  "provider": "youtube",
  "source_url": "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
  "title": "Feed title",
  "description": "Feed description",
  "image_url": "https://example.com/cover.jpg",
  "link": "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
  "author": "creator",
  "category": "TV & Film",
  "language": "en",
  "explicit": false,
  "last_source_update_at": "2026-07-06T12:00:00Z",
  "reported_at": "2026-07-06T12:05:00Z"
}
```

Response:

```json
{
  "ok": true,
  "feed_id": "tangpingshu"
}
```

Worker SQL:

```sql
INSERT INTO feed_metadata (
  feed_id, provider, source_url, title, description, image_url, link,
  author, category, language, explicit, last_source_update_at, reported_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(feed_id) DO UPDATE SET
  provider = excluded.provider,
  source_url = excluded.source_url,
  title = excluded.title,
  description = excluded.description,
  image_url = excluded.image_url,
  link = excluded.link,
  author = excluded.author,
  category = excluded.category,
  language = excluded.language,
  explicit = excluded.explicit,
  last_source_update_at = excluded.last_source_update_at,
  reported_at = excluded.reported_at
```

No schema migration is needed because `feed_metadata` already exists in `0001_initial.sql`.

---

## Task 1: Worker Feed Metadata API

**Files:**

- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Add: `cloudflare/worker/test/feed-metadata-upsert.test.ts`

- [ ] **Step 1.1: Add request/result types**

In `db.ts`, add:

```ts
export interface FeedMetadataUpsertRequest {
  feed_id: string;
  provider: "youtube" | "bilibili";
  source_url: string;
  title?: string;
  description?: string;
  image_url?: string;
  link?: string;
  author?: string;
  category?: string;
  language?: string;
  explicit?: boolean;
  last_source_update_at?: string;
  reported_at: string;
}
```

If needed for provider checks, reuse existing inline row types instead of adding unnecessary exported rows.

- [ ] **Step 1.2: Add strict parser**

In `index.ts`, add `parseFeedMetadataUpsert(body)`:

- require object body.
- require non-empty `feed_id`, `source_url`, `reported_at`.
- require provider via existing `isProvider`.
- validate `reported_at` with existing `validDateString`.
- validate optional `last_source_update_at` with `validDateString` when present.
- use `optionalString` for optional string fields.
- accept `explicit` only when boolean; omit otherwise.

Do not accept fractional timestamp seconds.

- [ ] **Step 1.3: Add handler**

Create `handleFeedMetadataUpsert(request, env)`:

1. Require NAS auth with `isAuthorizedNasRequest`.
2. Read bounded JSON with existing `readBoundedJson`.
3. Parse body.
4. Select `feed_id, provider` from `feeds`.
5. Return `404` if missing.
6. Return `400` if provider mismatch.
7. Upsert into `feed_metadata`.
8. Return `{ ok: true, feed_id }`.

Use current D1 schema fields only. Do not add migrations.

- [ ] **Step 1.4: Add route**

In fetch routing:

```ts
if (url.pathname === "/api/nas/feed-metadata/upsert") {
  if (request.method !== "POST") return methodNotAllowed();
  return handleFeedMetadataUpsert(request, env);
}
```

Place it next to other `/api/nas/*` routes.

- [ ] **Step 1.5: Extend fake D1**

Add fake support for:

- `feedMetadataByID?: Map<string, FakeFeedMetadataRow>`
- selecting existing `feeds` already exists; reuse it.
- `INSERT INTO feed_metadata ... ON CONFLICT` upsert.
- `LEFT JOIN feed_metadata` queries should prefer `feedMetadataByID` values over existing partial `metadata_title`/`metadata_description` test conveniences.

Keep existing tests compatible by continuing to honor `metadata_title`/`metadata_description` when `feedMetadataByID` has no row.

- [ ] **Step 1.6: Worker tests**

Add `feed-metadata-upsert.test.ts` covering:

- requires NAS auth.
- requires POST route method.
- rejects wrong content type / invalid JSON.
- validates required fields and provider.
- rejects non-strict timestamp and fractional timestamp.
- returns 404 when feed is missing.
- returns 400 on provider mismatch.
- inserts a new metadata row.
- updates existing metadata row idempotently.
- public RSS channel metadata uses reported metadata.
- admin feed list uses reported metadata.

Verification:

```bash
cd cloudflare/worker && npm run check
```

---

## Task 2: Go Remote Feed Metadata Client

**Files:**

- Modify: `pkg/model/remote.go`
- Modify: `services/remote/client.go`
- Modify: `services/remote/client_test.go`

- [ ] **Step 2.1: Add model type**

Add to `pkg/model/remote.go`:

```go
type RemoteFeedMetadata struct {
  FeedID             string    `json:"feed_id"`
  Provider           Provider  `json:"provider"`
  SourceURL          string    `json:"source_url"`
  Title              string    `json:"title,omitempty"`
  Description        string    `json:"description,omitempty"`
  ImageURL           string    `json:"image_url,omitempty"`
  Link               string    `json:"link,omitempty"`
  Author             string    `json:"author,omitempty"`
  Category           string    `json:"category,omitempty"`
  Language           string    `json:"language,omitempty"`
  Explicit           *bool     `json:"explicit,omitempty"`
  LastSourceUpdateAt time.Time `json:"-"`
  ReportedAt         time.Time `json:"-"`
}
```

If direct JSON tags for time fields would emit RFC3339Nano, do not rely on default encoding. Use a client payload struct that formats UTC seconds.

- [ ] **Step 2.2: Add reporter interface**

In `services/remote/client.go`:

```go
type FeedMetadataReporter interface {
  UpsertFeedMetadata(ctx context.Context, metadata *model.RemoteFeedMetadata) error
}
```

- [ ] **Step 2.3: Add client method**

Implement `(*NASClient).UpsertFeedMetadata`.

Rules:

- Validate non-nil metadata.
- Require feed id, provider youtube/bilibili, source URL, reported_at.
- Format `reported_at` and optional `last_source_update_at` as `time.RFC3339` after `UTC().Truncate(time.Second)`.
- POST `/api/nas/feed-metadata/upsert`.
- Bearer auth, JSON content type, JSON accept.
- Non-2xx errors redact `c.token` and common sensitive shapes through `scrubSensitiveText`.
- `400` and `404` are `NonRetryableError`.
- Success only needs a 2xx response; if JSON response is decoded, require `ok` true or ignore body? Use a minimal result struct and require `ok=true` to catch malformed Worker responses.

- [ ] **Step 2.4: Client tests**

Add tests for:

- expected payload, path, auth, content type.
- UTC second timestamp formatting.
- optional fields omitted when empty.
- validation rejects nil/missing required/provider unsupported.
- 400/404 nonretryable.
- non-2xx redaction includes token/header/query sensitive shapes.
- missing/false `ok` response is an error.
- base URL query/fragment are cleared for this endpoint.

Verification:

```bash
go test ./services/remote ./pkg/model
```

---

## Task 3: NAS Update Integration

**Files:**

- Modify: `services/update/updater.go`
- Modify: `services/update/updater_test.go`
- Modify: `cmd/podsync/remote_publish.go`
- Modify: `cmd/podsync/remote_publish_test.go`
- Modify: `cmd/podsync/main.go`

- [ ] **Step 3.1: Add updater seam**

In `services/update`, add:

```go
type RemoteFeedMetadataReporter interface {
  UpsertFeedMetadata(ctx context.Context, metadata *model.RemoteFeedMetadata) error
}
```

Add `WithRemoteFeedMetadataReporter(reporter RemoteFeedMetadataReporter) Option` and a `remoteFeedMetadataReporter` field on `Manager`.

- [ ] **Step 3.2: Add a minimal builder factory seam for tests**

Current `updateFeed` calls `builder.New(...).Build(...)` directly. To test feed metadata reporting without touching real provider APIs, add a small factory seam:

```go
type feedBuilderFactory func(ctx context.Context, provider model.Provider, key string, downloader Downloader) (builder.Builder, error)
```

Add `builderFactory feedBuilderFactory` to `Manager`, default it to `defaultFeedBuilderFactory` in `NewUpdater` or fall back to `defaultFeedBuilderFactory` in `updateFeed`, and use it in `updateFeed`:

```go
func defaultFeedBuilderFactory(ctx context.Context, provider model.Provider, key string, downloader Downloader) (builder.Builder, error) {
  return builder.New(ctx, provider, key, downloader)
}

factory := u.builderFactory
if factory == nil {
  factory = defaultFeedBuilderFactory
}
provider, err := factory(ctx, info.Provider, key, u.downloader)
```

This seam is only for dependency injection around the existing builder creation point. Do not change provider behavior, URL parsing, or key lookup semantics. Tests in package `update` may set `manager.builderFactory` directly; no public option is required unless the implementation naturally prefers one.

Do not assign `builder.New` directly to the `feedBuilderFactory` type: `builder.New` accepts `pkg/builder.Downloader`, while this seam accepts the local `update.Downloader` super-interface. The wrapper is intentional and should compile because `update.Downloader` provides the `PlaylistMetadata` method required by `pkg/builder.Downloader`.

- [ ] **Step 3.3: Build metadata from feed result**

Add a helper:

```go
func remoteFeedMetadataFromResult(feedConfig *feed.Config, result *model.Feed, reportedAt time.Time) (*model.RemoteFeedMetadata, error)
```

Rules:

- Parse provider from `feedConfig.URL` with `builder.ParseURL`.
- Only return metadata for YouTube and Bilibili. For other providers, return nil/no-op. Current Worker contract only accepts those.
- `FeedID = feedConfig.ID`.
- `SourceURL = feedConfig.URL` by default; `Link = result.ItemURL`, falling back to `feedConfig.Custom.Link` when configured.
- `Title = result.Title`, overridden by `feedConfig.Custom.Title` when configured.
- `Description = result.Description`, overridden by `feedConfig.Custom.Description` when configured.
- `ImageURL = result.CoverArt`, overridden by `feedConfig.Custom.CoverArt` when configured.
- `Author = result.Author`, overridden by `feedConfig.Custom.Author` when configured.
- `Category = feedConfig.Custom.Category`.
- `Language = feedConfig.Custom.Language`.
- `Explicit` should be set only when `feedConfig.Custom.Explicit` is true. Do not report false by default because current local default false is indistinguishable from unset.
- `LastSourceUpdateAt = result.PubDate` when non-zero.
- `ReportedAt = reportedAt.UTC()`.

- [ ] **Step 3.4: Report after successful local AddFeed**

In `updateFeed`, after `u.db.AddFeed(ctx, feedConfig.ID, result)` succeeds and before removing stale episodes is acceptable. The important invariant is: do not report if provider `Build` or local `AddFeed` failed.

Call helper and reporter:

```go
if err := u.reportRemoteFeedMetadata(ctx, feedConfig, result, time.Now().UTC()); err != nil {
  log.WithError(err).WithField("feed_id", feedConfig.ID).Warn("failed to report remote feed metadata")
}
```

Do not return the error. This must be warning-only.

- [ ] **Step 3.5: Wire from cmd**

Add:

```go
type remoteFeedMetadataReporterFactory func(baseURL string, token string) (remotepublish.FeedMetadataReporter, error)
func newRemoteFeedMetadataReporter(baseURL string, token string) (remotepublish.FeedMetadataReporter, error) {
  return remotepublish.NewNASClient(baseURL, token, nil)
}
```

Create a helper, for example `remoteFeedMetadataOptions(cfg, newReporter) ([]update.Option, error)`, that:

- returns nil when `remote.enabled=false`.
- returns nil when `base_url` or `token` is missing.
- constructs `NASClient` only when enabled and complete.
- returns `update.WithRemoteFeedMetadataReporter(reporter)`.

In `main.go`, append these options when building `updateOptions`. If reporter construction fails, log warning and continue without it.

Do not couple this to complete R2 config. Feed metadata can be reported when remote config is enabled even if R2 upload is not configured.

- [ ] **Step 3.6: Go tests**

Add/update tests:

- helper maps provider and metadata fields.
- custom title/description/cover/author/link override source metadata.
- explicit false is omitted; explicit true is reported.
- unsupported provider returns no metadata/no error.
- `updateFeed` with fake builder and fake DB reports metadata after `AddFeed` succeeds.
- `updateFeed` does not report metadata when fake builder fails.
- `updateFeed` does not report metadata when fake DB `AddFeed` fails.
- reporter failure from `updateFeed` is warning-only and does not return an error.
- no reporter means no-op.
- `remoteFeedMetadataOptions` disabled/incomplete does not call factory.
- `remoteFeedMetadataOptions` enabled uses base URL/token.

Prefer narrow tests around `updateFeed` helper/fakes. Do not introduce a large integration test that depends on real provider APIs.

Verification:

```bash
go test ./services/update ./cmd/podsync ./services/remote ./pkg/model
```

---

## Task 4: Quality Gate And Commit

- [ ] **Step 4.1: Run Go gates**

```bash
go test ./services/update ./cmd/podsync ./services/remote ./pkg/model
go test ./...
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

- [ ] **Step 4.2: Run Worker gates**

```bash
cd cloudflare/worker && npm run check
cd cloudflare/worker && npm run d1:check
cd cloudflare/worker && npm run wrangler:check
```

- [ ] **Step 4.3: Scope check**

```bash
git diff --stat
git diff -- .github Dockerfile 'Dockerfile.*'
git diff --check
```

Expected:

- no Docker/GitHub Actions/NAS deployment changes.
- no R2 purge/outbox/event changes except necessary shared NAS client code.
- no dashboard UI.

- [ ] **Step 4.4: Request sub-agent implementation review**

Spec/scope reviewer prompt:

```text
Review current diff against docs/superpowers/plans/2026-07-06-feed-metadata-upsert.md.
Verify it implements only NAS feed metadata upsert Worker API plus Go best-effort reporting after successful feed update.
Confirm no dashboard UI, feed CRUD, remote TOML schema, R2 purge, event logging, Docker/CI, or live deployment leaked in.
Return PASS or NEEDS_FIX with blocking file/line findings only.
```

Code-risk reviewer prompt:

```text
Review Worker and Go feed metadata upsert for contract, validation, timestamp precision,
provider mismatch, auth, redaction, best-effort local behavior, and tests.
Return PASS or NEEDS_FIX with blocking file/line findings only.
```

- [ ] **Step 4.5: Commit**

Only after both reviewers pass and gates are green:

```bash
git add pkg/model services/remote services/update cmd/podsync cloudflare/worker docs/superpowers/plans/2026-07-06-feed-metadata-upsert.md
git commit -m "feat: report remote feed metadata"
```

Do not push unless the user explicitly asks.
