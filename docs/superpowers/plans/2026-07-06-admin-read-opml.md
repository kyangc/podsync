# Admin Read APIs And OPML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Worker read APIs and public URL material needed for a dashboard to list feeds/episodes and copy RSS/OPML subscription URLs.

**Architecture:** Keep this as a Cloudflare Worker/D1 read-surface slice. Add explicit public URL material to D1 because existing `feed_token_hash` and `opml_tokens.token_hash` are non-reversible; public RSS/OPML auth continues to use token hashes. Admin routes stay behind the existing Cloudflare Access header boundary, while public OPML remains token-path based and unauthenticated.

**Tech Stack:** Cloudflare Worker TypeScript, D1 migrations, Vitest, existing fake D1 test harness.

---

## Scope Boundaries

This phase may modify:

- `cloudflare/worker/migrations/0002_public_paths.sql`
- `cloudflare/worker/src/db.ts`
- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/test/fake-d1.ts`
- `cloudflare/worker/test/public-feeds.test.ts`
- `cloudflare/worker/test/admin-read.test.ts`
- `cloudflare/worker/test/schema.test.ts`
- `docs/superpowers/plans/2026-07-06-admin-read-opml.md`

This phase must not implement:

- feed create/edit/delete beyond existing status mutation
- dashboard HTML/JS UI beyond the existing placeholder
- R2 delete/purge
- NAS Go changes
- event/sync-run upload
- retention cron
- Docker, CI, deployment, or live Cloudflare data changes

---

## Acceptance Criteria

- D1 has nullable public path columns for feeds and OPML tokens.
- Public RSS lookup still uses `feed_token_hash`; it does not trust `public_path`.
- Public OPML lookup still uses `opml_tokens.token_hash`; it renders enabled + OPML-included feeds that have valid feed public paths.
- Public OPML emits absolute feed XML URLs using the request origin and stored public feed paths.
- OPML excludes disabled feeds, `include_in_opml=false` feeds, and feeds missing public path material.
- `GET /api/admin/feeds` requires Cloudflare Access and returns feed configuration plus display metadata and `public_feed_url`.
- `GET /api/admin/episodes?feed_id=<id>` requires Cloudflare Access and returns recent episodes for one feed with status and metadata.
- Admin episode listing validates `feed_id`, `status`, `limit`, and `offset`.
- `GET /api/admin/subscriptions` requires Cloudflare Access and returns feed subscription URLs plus OPML URLs when public path material exists.
- No Worker mutation behavior changes except schema support for public path material.

---

## Design Decisions

- Add `public_path` rather than storing raw token fields. The value is the public XML path, for example `/f/<feed-token>.xml` or `/opml/<opml-token>.xml`.
- Do not backfill existing rows in migration because the original token cannot be derived from `*_token_hash`. Existing feeds continue to serve if their token is known; they simply cannot appear in generated OPML/admin URL fields until `public_path` is populated.
- Validate public paths at render time. A bad path is omitted from OPML/admin URL output rather than making the whole request fail.
- Use offset pagination for the first admin episode list. It is simple, sufficient for dashboard browsing, and avoids introducing cursor contracts not needed yet.

---

## API Contracts

### Admin Feeds

```http
GET /api/admin/feeds
Cf-Access-Jwt-Assertion: <present>
```

Response:

```json
{
  "feeds": [
    {
      "feed_id": "bili",
      "provider": "bilibili",
      "url": "https://space.bilibili.com/10835521",
      "title": "Bilibili Feed",
      "description": "A feed",
      "enabled": true,
      "include_in_opml": true,
      "private_feed": true,
      "update_period": "1h",
      "page_size": 25,
      "keep_last": 25,
      "cookie_profile": "bilibili",
      "public_feed_url": "https://podcast.example.com/f/feed-secret.xml"
    }
  ]
}
```

### Admin Episodes

```http
GET /api/admin/episodes?feed_id=bili&status=visible&limit=50&offset=0
Cf-Access-Jwt-Assertion: <present>
```

Response:

```json
{
  "feed_id": "bili",
  "limit": 50,
  "offset": 0,
  "episodes": [
    {
      "local_episode_id": "BV1",
      "source_episode_id": "BV1",
      "source_url": "https://www.bilibili.com/video/BV1",
      "title": "Episode",
      "published_at": "2026-07-06T12:00:00Z",
      "duration": 123,
      "status": "visible",
      "has_media": true,
      "size": 456,
      "mime_type": "audio/mpeg",
      "updated_at": "2026-07-06 12:10:00"
    }
  ]
}
```

### Admin Subscriptions

```http
GET /api/admin/subscriptions
Cf-Access-Jwt-Assertion: <present>
```

Response:

```json
{
  "feeds": [
    {
      "feed_id": "bili",
      "title": "Bilibili Feed",
      "xml_url": "https://podcast.example.com/f/feed-secret.xml"
    }
  ],
  "opml": [
    {
      "label": "default",
      "xml_url": "https://podcast.example.com/opml/opml-secret.xml"
    }
  ]
}
```

---

## Task 1: D1 Schema And Types

**Files:**

- Create: `cloudflare/worker/migrations/0002_public_paths.sql`
- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/test/schema.test.ts`

- [ ] **Step 1.1: Add public path migration**

Create `cloudflare/worker/migrations/0002_public_paths.sql`:

```sql
ALTER TABLE feeds ADD COLUMN public_path TEXT;
ALTER TABLE opml_tokens ADD COLUMN public_path TEXT;

CREATE UNIQUE INDEX idx_feeds_public_path ON feeds(public_path);
CREATE UNIQUE INDEX idx_opml_tokens_public_path ON opml_tokens(public_path);
```

SQLite unique indexes allow multiple `NULL` values, so old rows can stay unset.

- [ ] **Step 1.2: Add Worker row types**

Add to `cloudflare/worker/src/db.ts`:

```ts
export interface AdminFeedListRow {
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
  public_path: string | null;
  metadata_title: string | null;
  metadata_description: string | null;
}

export interface AdminEpisodeListRow {
  local_episode_id: string;
  source_episode_id: string;
  source_url: string | null;
  title: string | null;
  published_at: string | null;
  duration: number | null;
  status: EpisodeStatus;
  r2_key: string | null;
  size: number | null;
  mime_type: string | null;
  updated_at: string;
}

export interface PublicOpmlFeedRow {
  feed_id: string;
  title: string | null;
  title_override: string | null;
  public_path: string | null;
}

export interface AdminSubscriptionFeedRow {
  feed_id: string;
  title: string | null;
  title_override: string | null;
  public_path: string | null;
}

export interface AdminSubscriptionOpmlRow {
  label: string;
  public_path: string | null;
}
```

- [ ] **Step 1.3: Update schema tests**

Update `cloudflare/worker/test/schema.test.ts` so it reads all migration files in sorted order, not just `0001_initial.sql`:

```ts
const migrationsDir = join(here, "../migrations");
const schema = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
  .join("\n");
```

Then assert:

```ts
expect(schema).toContain("ALTER TABLE feeds ADD COLUMN public_path TEXT");
expect(schema).toContain("ALTER TABLE opml_tokens ADD COLUMN public_path TEXT");
expect(schema).toContain("CREATE UNIQUE INDEX idx_feeds_public_path ON feeds(public_path)");
expect(schema).toContain("CREATE UNIQUE INDEX idx_opml_tokens_public_path ON opml_tokens(public_path)");
```

- [ ] **Step 1.4: Verify schema slice**

Run:

```bash
cd cloudflare/worker && npm test -- schema
```

Expected: PASS.

---

## Task 2: Public URL Helpers And Non-Empty OPML

**Files:**

- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Modify: `cloudflare/worker/test/public-feeds.test.ts`

- [ ] **Step 2.1: Add public path helpers**

Add to `cloudflare/worker/src/index.ts`:

```ts
const publicPathTokenPattern = /^[A-Za-z0-9_-]+$/;

function validPublicXmlPath(path: string | null, prefix: "/f/" | "/opml/"): path is string {
  if (path === null) return false;
  if (!path.startsWith(prefix) || !path.endsWith(".xml")) return false;
  const token = path.slice(prefix.length, -".xml".length);
  return publicPathTokenPattern.test(token);
}

function absolutePublicURL(request: Request, path: string | null, prefix: "/f/" | "/opml/"): string | null {
  if (!validPublicXmlPath(path, prefix)) return null;
  return new URL(path, new URL(request.url).origin).toString();
}
```

- [ ] **Step 2.2: Render OPML feed rows**

Change `handleOpml` signature to accept `request`:

```ts
async function handleOpml(pathname: string, request: Request, env: Env): Promise<Response>
```

After validating the OPML token, query feed rows:

```ts
const { results } = await env.DB.prepare(
  `SELECT f.feed_id, f.title_override, f.public_path, m.title
     FROM feeds f
     LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
    WHERE f.enabled = 1
      AND f.include_in_opml = 1
      AND f.public_path IS NOT NULL
    ORDER BY f.feed_id ASC`,
).all<PublicOpmlFeedRow>();

const feeds = results.flatMap((feed) => {
  const xmlUrl = absolutePublicURL(request, feed.public_path, "/f/");
  if (!xmlUrl) return [];
  return [{
    title: feed.title ?? feed.title_override ?? feed.feed_id,
    xmlUrl,
  }];
});

return text(renderOpml(feeds), 200, "text/x-opml; charset=utf-8");
```

Update route call:

```ts
return handleOpml(url.pathname, request, env);
```

- [ ] **Step 2.3: Extend fake D1 for OPML feed query**

In `cloudflare/worker/test/fake-d1.ts`:

- Let feed-like rows optionally carry `public_path`.
- Let `opmlTokenHashes` continue working for token validation.
- Add `opmlTokensByHash?: Map<string, { label: string; public_path: string | null; enabled?: number }>` for later admin subscriptions.
- Support the OPML feed query from `feeds f LEFT JOIN feed_metadata`.
- Return rows from `tomlFeeds` where `enabled === 1`, `include_in_opml === 1`, and `public_path` is non-empty.

- [ ] **Step 2.4: Add public OPML tests**

Extend `cloudflare/worker/test/public-feeds.test.ts`:

```ts
it("renders OPML outlines for enabled public feeds")
it("omits disabled non-opml and missing-public-path feeds from OPML")
it("does not use feed token hashes as OPML URLs")
it("omits malformed public feed paths from OPML")
```

Use `tomlFeeds` rows with `public_path: "/f/feed-secret.xml"` via intersection type in the test helper. Assert:

- OPML contains `xmlUrl="https://podcast.example.com/f/feed-secret.xml"`.
- disabled feeds are absent.
- `feed_token_hash` string is absent from OPML.
- invalid paths like `/f/%2e%2e/x.xml`, `/f/feed.xml?x=1`, `/f/feed.xml#x`, `/f//feed.xml`, `/f/feed.secret.xml`, and `/opml/feed-secret.xml` are absent.

- [ ] **Step 2.5: Verify OPML slice**

Run:

```bash
cd cloudflare/worker && npm test -- public-feeds
```

Expected: PASS.

---

## Task 3: Admin Read APIs

**Files:**

- Modify: `cloudflare/worker/src/index.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`
- Create: `cloudflare/worker/test/admin-read.test.ts`

- [ ] **Step 3.0: Update imports**

Update the type imports in `cloudflare/worker/src/index.ts` to include:

```ts
AdminEpisodeListRow,
AdminFeedListRow,
AdminSubscriptionFeedRow,
AdminSubscriptionOpmlRow,
PublicOpmlFeedRow,
```

- [ ] **Step 3.1: Add admin list helpers**

Add in `cloudflare/worker/src/index.ts`:

```ts
function jsonBoolean(value: number): boolean {
  return value === 1;
}

function parseEpisodeStatusParam(value: string | null): EpisodeStatus | Response | null {
  if (value === null || value === "") return null;
  if (value === "pending" || value === "visible" || value === "hidden" || value === "delete_pending" || value === "purged") {
    return value;
  }
  return badRequest("status is invalid");
}

function adminListLimit(url: URL, fallback: number, max: number): number | Response {
  const limit = parseIntegerParam(url.searchParams.get("limit"), fallback, "limit");
  if (limit instanceof Response) return limit;
  if (limit < 1 || limit > max) return badRequest("limit is invalid");
  return limit;
}

function adminListOffset(url: URL): number | Response {
  return parseIntegerParam(url.searchParams.get("offset"), 0, "offset");
}
```

- [ ] **Step 3.2: Implement `GET /api/admin/feeds`**

Add:

```ts
async function handleAdminFeeds(request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override,
            f.enabled, f.include_in_opml, f.private_feed, f.update_period,
            f.page_size, f.keep_last, f.cookie_profile, f.public_path,
            m.title AS metadata_title, m.description AS metadata_description
       FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
      ORDER BY f.feed_id ASC`,
  ).all<AdminFeedListRow>();

  return Response.json({
    feeds: results.map((feed) => ({
      feed_id: feed.feed_id,
      provider: feed.provider,
      url: feed.url,
      title: feed.metadata_title ?? feed.title_override ?? feed.feed_id,
      description: feed.metadata_description ?? feed.description_override ?? null,
      enabled: jsonBoolean(feed.enabled),
      include_in_opml: jsonBoolean(feed.include_in_opml),
      private_feed: jsonBoolean(feed.private_feed),
      update_period: feed.update_period,
      page_size: feed.page_size,
      keep_last: feed.keep_last,
      cookie_profile: feed.cookie_profile,
      public_feed_url: absolutePublicURL(request, feed.public_path, "/f/"),
    })),
  });
}
```

- [ ] **Step 3.3: Implement `GET /api/admin/episodes`**

Add:

```ts
async function handleAdminEpisodes(url: URL, env: Env): Promise<Response> {
  const feedID = url.searchParams.get("feed_id");
  if (!feedID || feedID.trim() === "") return badRequest("feed_id is required");
  const status = parseEpisodeStatusParam(url.searchParams.get("status"));
  if (status instanceof Response) return status;
  const limit = adminListLimit(url, 50, 200);
  if (limit instanceof Response) return limit;
  const offset = adminListOffset(url);
  if (offset instanceof Response) return offset;

  const exists = await env.DB.prepare(
    `SELECT feed_id FROM feeds WHERE feed_id = ?`,
  ).bind(feedID).first<{ feed_id: string }>();
  if (!exists) return text("feed not found", 404);

  const whereStatus = status ? " AND status = ?" : "";
  const bindings: unknown[] = status ? [feedID, status, limit, offset] : [feedID, limit, offset];
  const { results } = await env.DB.prepare(
    `SELECT local_episode_id, source_episode_id, source_url, title, published_at,
            duration, status, r2_key, size, mime_type, updated_at
       FROM episodes
      WHERE feed_id = ?${whereStatus}
      ORDER BY COALESCE(datetime(published_at), datetime(updated_at)) DESC, local_episode_id ASC
      LIMIT ? OFFSET ?`,
  ).bind(...bindings).all<AdminEpisodeListRow>();

  return Response.json({
    feed_id: feedID,
    limit,
    offset,
    episodes: results.map((episode) => ({
      local_episode_id: episode.local_episode_id,
      source_episode_id: episode.source_episode_id,
      source_url: episode.source_url,
      title: episode.title,
      published_at: episode.published_at,
      duration: episode.duration,
      status: episode.status,
      has_media: episode.r2_key !== null && episode.r2_key !== "",
      size: episode.size,
      mime_type: episode.mime_type,
      updated_at: episode.updated_at,
    })),
  });
}
```

- [ ] **Step 3.4: Implement `GET /api/admin/subscriptions`**

Add:

```ts
async function handleAdminSubscriptions(request: Request, env: Env): Promise<Response> {
  const { results: feeds } = await env.DB.prepare(
    `SELECT f.feed_id, f.title_override, f.public_path, m.title
       FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
      WHERE f.public_path IS NOT NULL
      ORDER BY f.feed_id ASC`,
  ).all<AdminSubscriptionFeedRow>();

  const { results: opml } = await env.DB.prepare(
    `SELECT label, public_path
       FROM opml_tokens
      WHERE enabled = 1 AND public_path IS NOT NULL
      ORDER BY label ASC`,
  ).all<AdminSubscriptionOpmlRow>();

  return Response.json({
    feeds: feeds.flatMap((feed) => {
      const xmlURL = absolutePublicURL(request, feed.public_path, "/f/");
      if (!xmlURL) return [];
      return [{ feed_id: feed.feed_id, title: feed.title ?? feed.title_override ?? feed.feed_id, xml_url: xmlURL }];
    }),
    opml: opml.flatMap((token) => {
      const xmlURL = absolutePublicURL(request, token.public_path, "/opml/");
      if (!xmlURL) return [];
      return [{ label: token.label, xml_url: xmlURL }];
    }),
  });
}
```

- [ ] **Step 3.5: Wire admin routes**

Inside the existing `/api/admin/*` guarded block:

```ts
if (url.pathname === "/api/admin/feeds") {
  if (request.method !== "GET") return methodNotAllowed();
  return handleAdminFeeds(request, env);
}
if (url.pathname === "/api/admin/episodes") {
  if (request.method !== "GET") return methodNotAllowed();
  return handleAdminEpisodes(url, env);
}
if (url.pathname === "/api/admin/subscriptions") {
  if (request.method !== "GET") return methodNotAllowed();
  return handleAdminSubscriptions(request, env);
}
```

Keep these routes inside the Access guard.

- [ ] **Step 3.6: Extend fake D1 for admin read queries**

In `cloudflare/worker/test/fake-d1.ts`, support:

- admin feed list query from `feeds f LEFT JOIN feed_metadata`.
- admin episode list query with optional status, limit, and offset.
- admin subscription feed query.
- admin subscription OPML token query.
- missing-feed lookup for episode list.

Use deterministic ordering matching SQL. Admin episode ordering must normalize date strings the same way as SQLite `datetime(...)` so mixed ISO `published_at` values like `2026-07-06T12:00:00Z` and SQLite `updated_at` values like `2026-07-06 13:00:00` sort correctly.

- [ ] **Step 3.7: Add admin read tests**

Create `cloudflare/worker/test/admin-read.test.ts` with:

```ts
it("requires Cloudflare Access for admin feeds")
it("requires Cloudflare Access for admin episodes")
it("requires Cloudflare Access for admin subscriptions")
it("lists admin feeds with public URLs and metadata fallback")
it("requires GET for admin feeds")
it("lists admin episodes for one feed")
it("filters admin episodes by status")
it("orders admin episodes by published date fallback and local id")
it("applies admin episode limit and offset")
it("validates admin episode query params")
it("returns 404 for missing admin episode feed")
it("lists subscription feed and OPML URLs")
it("omits invalid public paths from subscriptions")
it("rejects multi-segment and encoded-slash public paths from subscription output")
it("omits disabled OPML tokens from subscriptions")
```

The episode ordering test must include one row with `published_at = null` and a later `updated_at`, plus same-time rows with different `local_episode_id`, to verify the fake D1 branch follows:

```sql
ORDER BY COALESCE(datetime(published_at), datetime(updated_at)) DESC, local_episode_id ASC
```

The invalid subscription path test must cover `/f/%2e%2e/x.xml`, `/f/feed.xml?x=1`, `/f/feed.xml#x`, `/f//feed.xml`, `/f/feed.secret.xml`, `/opml/feed-secret.xml`, and `/opml/opml.secret.xml`.

- [ ] **Step 3.8: Verify admin read slice**

Run:

```bash
cd cloudflare/worker && npm test -- admin-read auth-routes
```

Expected: PASS.

---

## Task 4: Phase 4C Quality Gate And Commit

- [ ] **Step 4.1: Worker gate**

Run:

```bash
cd cloudflare/worker
npm run check
npm run d1:check
npm run wrangler:check
```

Expected: PASS.

- [ ] **Step 4.2: Go regression gate**

Run:

```bash
go test ./...
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS. This phase should not modify Go files.

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
- no Docker/CI changes
- no R2 purge
- no dashboard UI beyond placeholder
- Worker schema/source/tests plus this plan changed

- [ ] **Step 4.4: Sub-agent implementation review**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify Phase 4C implements only Worker admin read APIs, public path material, and non-empty OPML.
  Confirm no feed CRUD, dashboard UI, R2 purge, NAS Go changes, events, Docker/CI, or deployment.

Quality reviewer:
  Review public URL material handling, token-hash auth boundaries, OPML filtering, admin auth routing,
  episode query validation, fake D1 fidelity, migration safety, and test coverage.
```

Expected: no blocking or important findings. Fix and re-review any blocking or important findings before commit.

- [ ] **Step 4.5: Commit Phase 4C**

Run:

```bash
git add cloudflare/worker docs/superpowers/plans/2026-07-06-admin-read-opml.md
git commit -m "feat: add admin read APIs and opml"
```

Do not push unless explicitly requested.
