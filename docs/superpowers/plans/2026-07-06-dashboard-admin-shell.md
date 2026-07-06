# Dashboard Admin Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current dashboard placeholder with a small, usable Cloudflare Access-protected admin shell backed by the admin APIs already implemented in prior phases. The dashboard should let the user inspect current feeds, copy subscription URLs, toggle feed delivery flags, inspect recent episodes for a selected feed, apply episode hide/delete/restore actions, and review recent sync runs/events.

**Architecture:** Keep the first dashboard as a static Worker-served HTML document with embedded CSS and JavaScript. The JS talks only to existing same-origin admin APIs. No frontend build system, framework, asset pipeline, new admin endpoint, or D1 schema change is introduced in this phase.

**Tech Stack:** Cloudflare Worker TypeScript, existing admin APIs, vanilla HTML/CSS/JS, Vitest route/content tests.

---

## Scope Boundaries

This phase may modify:

- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/test/auth-routes.test.ts`
- `cloudflare/worker/test/*.test.ts` only for dashboard route/content tests
- `docs/superpowers/plans/2026-07-06-dashboard-admin-shell.md`

This phase must not implement:

- Feed create/edit/delete APIs.
- Feed URL/provider/config editing.
- True feed delete.
- Cookie management.
- Remote TOML schema changes.
- New D1 migrations.
- New frontend build tooling or dependencies.
- R2 upload/purge logic changes.
- Go/NAS runtime changes.
- Live Cloudflare deployment or NAS service restart.

---

## Assumptions

- Cloudflare Access already protects `/dashboard/*` and `/api/admin/*` at route level in Worker code.
- Existing admin APIs are the source of truth for first version dashboard state:
  - `GET /api/admin/feeds`
  - `GET /api/admin/subscriptions`
  - `GET /api/admin/episodes?feed_id=...`
  - `POST /api/admin/feeds/status`
  - `POST /api/admin/episodes/status`
  - `GET /api/admin/sync-runs`
  - `GET /api/admin/events`
- Dashboard can be servered as a single HTML response. The Worker bundle size should remain small enough for current Wrangler dry-run.
- Since this is an operational tool, the UI should be dense, calm, and table-oriented instead of a marketing page.

---

## Acceptance Criteria

- `/dashboard` and `/dashboard/anything` still require Cloudflare Access and `GET`.
- Authorized dashboard route returns a full HTML document, not the current placeholder title only.
- Dashboard first viewport is the actual management workspace: header, status summary, feed list, selected-feed episode panel, subscriptions panel, and recent activity panels.
- Dashboard JS fetches same-origin admin APIs only:
  - feeds, subscriptions, sync runs, events on load.
  - episodes when a feed is selected.
  - feed status and episode status through existing POST endpoints.
- Dashboard includes controls for:
  - selecting a feed.
  - toggling `enabled`.
  - toggling `include_in_opml`.
  - copying public feed/OPML URLs.
  - filtering selected feed episodes by status.
  - hide/delete/restore episode actions.
  - refreshing dashboard state.
- UI must make loading, empty, success, and error states visible.
- Dashboard response must include defensive headers:
  - `Content-Security-Policy`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: no-store`
- All dynamic DOM insertion must use text nodes / `textContent` / attributes, not unsafe `innerHTML` from API data.
- Tests verify:
  - dashboard auth/method boundaries remain intact.
  - nested dashboard routes keep the same Access and method boundaries.
  - dashboard response contains expected app shell markers and API endpoint references.
  - dashboard response includes defensive security/cache headers.
  - dashboard source does not use `.innerHTML`, `insertAdjacentHTML`, external `<script src>`, or external stylesheet `<link>`.
  - dashboard includes no obvious placeholder-only title body.
  - `npm run check`, `npm run d1:check`, `npm run wrangler:check`, `go test ./...`, and `git diff --check` pass.

---

## UI Shape

The first version should be one operational screen:

```text
Top bar:
  Podsync Control
  Refresh button
  Last loaded / toast area

Summary row:
  feeds total
  enabled count
  in OPML count
  latest run status

Main grid:
  Left: Feeds table/list
    feed_id
    provider
    title
    enabled toggle
    OPML toggle
    public URL copy button

  Right: Episodes for selected feed
    status filter
    title/id/source link
    published/updated
    media presence
    hide/delete/restore actions

Lower grid:
  Subscriptions
    feed URLs
    OPML URLs

  Recent runs
    status, time, counts

  Recent events
    level, type, feed/episode, message/error
```

Use compact tables and restrained controls. Avoid cards inside cards. Do not add explanatory marketing text or large hero sections.

---

## Implementation Tasks

### Task 1: Render Static Dashboard HTML

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [ ] Add a `dashboardHTML()` helper returning a full `<!doctype html>` document string.
- [ ] Add semantic landmarks:
  - `<main id="app" data-dashboard-app>`
  - feed list region
  - episodes region
  - subscriptions region
  - recent runs/events region
- [ ] Add minimal CSS inline in `<style>`.
- [ ] Keep CSS palette multi-tone and utilitarian; avoid one-color gradient/orb decoration.
- [ ] Add `dashboardHeaders()` or equivalent helper with:
  - `Content-Type: text/html; charset=utf-8`
  - `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: no-store`
- [ ] Update the dashboard route to return `dashboardHTML()` with those headers.
- [ ] Do not add external script/style URLs.

### Task 2: Add Client-Side API Layer

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [ ] In inline JS, add a small `api(path, options)` helper.
- [ ] Fetch on load:
  - `/api/admin/feeds`
  - `/api/admin/subscriptions`
  - `/api/admin/sync-runs?limit=10`
  - `/api/admin/events?limit=25`
- [ ] Load `/api/admin/episodes?feed_id=...&limit=50` when a feed is selected.
- [ ] Add `POST /api/admin/feeds/status` call for `enabled` and `include_in_opml` changes.
- [ ] Add `POST /api/admin/episodes/status` call for hide/delete/restore.
- [ ] Refresh affected views after successful actions.
- [ ] Show errors without throwing uncaught promise rejections.

### Task 3: Render State Safely

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [ ] Build dynamic rows using `document.createElement`.
- [ ] Assign user/API data with `textContent`, `href`, and safe attributes only.
- [ ] Do not use API data inside `innerHTML`.
- [ ] Use disabled states while mutations are in flight.
- [ ] Copy URLs via `navigator.clipboard.writeText` when available, falling back to selecting a temporary input.
- [ ] Keep table text constrained so long IDs/URLs wrap without overlapping.

### Task 4: Dashboard Route Tests

**Files:**

- Modify: `cloudflare/worker/test/auth-routes.test.ts` or add `cloudflare/worker/test/dashboard.test.ts`

- [ ] Keep existing auth/method tests passing.
- [ ] Add assertions that authorized `/dashboard/` response:
  - has `text/html`.
  - has the dashboard security/cache headers.
  - contains `data-dashboard-app`.
  - references expected API paths.
  - contains feed/episode/subscription/run/event regions.
  - is more than a placeholder shell.
- [ ] Add nested route boundary assertions for `/dashboard/settings`:
  - no Access header returns `403`.
  - `POST` with Access returns `405`.
  - `GET` with Access returns `200`.
- [ ] Add source safety assertions:
  - response body does not contain `.innerHTML`.
  - response body does not contain `insertAdjacentHTML`.
  - response body does not contain `<script src=`.
  - response body does not contain `<link rel="stylesheet"` or `<link rel='stylesheet'`.
  - response body references only same-origin `/api/admin/...` API paths.

### Task 5: Verification

- [ ] Run `cd cloudflare/worker && npm run check`.
- [ ] Run `cd cloudflare/worker && npm run d1:check`.
- [ ] Run `cd cloudflare/worker && npm run wrangler:check`.
- [ ] Run `go test ./...`.
- [ ] Run `git diff --check`.
- [ ] Spawn implementation review sub-agents after tests pass and address any blockers.

---

## Non-Goals To Preserve

- No dashboard feed create/edit form in this phase.
- No arbitrary TOML editor.
- No cookie text/file manager.
- No token/R2 secret display.
- No client-side storage of copied URLs or admin data.
- No extra authentication scheme beyond existing Cloudflare Access route boundary.

---

## Rollback Plan

If dashboard HTML/JS causes issues, revert this phase commit. Existing admin APIs, NAS APIs, RSS/OPML, publish, tombstone, events, and scheduled purge behavior should remain untouched by design.
