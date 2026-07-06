# Dashboard Feed Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Worker-served dashboard able to create and edit remote feed configuration by calling the already implemented `POST /api/admin/feeds/upsert` API.

**Architecture:** Keep the dashboard as the current single Worker-served HTML/CSS/vanilla-JS shell. Add a compact feed form inside the Feeds section, reuse the existing `/api/admin/feeds` read model, and submit full-object upserts to `/api/admin/feeds/upsert`. The backend remains the source of truth for validation and persistence.

**Tech Stack:** Cloudflare Worker inline HTML, vanilla JavaScript, existing admin APIs, Vitest source-level Worker tests.

---

## Scope Boundaries

This phase may modify:

- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/test/auth-routes.test.ts`
- new dashboard source tests only if needed
- `docs/superpowers/plans/2026-07-06-dashboard-feed-form.md`

This phase must not implement:

- Any D1 schema migration.
- Any Go/NAS runtime change.
- Any new admin backend API.
- True feed delete, feed rename, or provider change for existing feeds.
- Cookie content management. Only `cookie_profile` string editing is in scope.
- OPML token creation/editing.
- R2 upload/purge changes.
- New frontend framework, build step, external script, external stylesheet, or external asset.
- Live Cloudflare deploy or NAS restart.

---

## Assumptions

- `/api/admin/feeds/upsert` is the backend contract for feed create/update.
- `feed_id` is stable identity. For edit mode, the dashboard must treat it as read-only.
- Provider is stable for existing feeds. For edit mode, the dashboard must treat it as read-only.
- Blank optional text fields should submit as `null`.
- Blank optional numeric filter fields should submit as `null`.
- Dashboard client validation is only for ergonomics; Worker API validation remains authoritative.
- The dashboard is a small admin tool, so source-level tests plus Worker dry-run are acceptable for this phase. Browser automation can be added later when there is a deployed or local Worker preview flow worth preserving.

---

## Acceptance Criteria

- Dashboard source includes a Feeds section action to start a new feed.
- Each feed row includes an edit action.
- A feed form can open in two modes:
  - create mode with sensible defaults.
  - edit mode prefilled from the selected feed's raw config fields.
- Form fields include:
  - `feed_id`
  - `provider`
  - `url`
  - `title_override`
  - `description_override`
  - `enabled`
  - `include_in_opml`
  - `private_feed`
  - `update_period`
  - `page_size`
  - `keep_last`
  - `cookie_profile`
  - filter fields: `title`, `not_title`, `description`, `not_description`, `min_duration`, `max_duration`, `min_age`, `max_age`
- In edit mode:
  - `feed_id` is read-only or disabled in the UI.
  - `provider` is read-only or disabled in the UI.
  - Save still submits the existing `feed_id` and `provider` values.
  - Submit identity must come from trusted dashboard state, not editable DOM values:
    - `feed_id` comes from `state.editingFeedID`.
    - `provider` comes from `findFeedByID(state.editingFeedID).provider`.
    - if the original feed cannot be found, do not submit.
- Save calls `POST /api/admin/feeds/upsert` with a full feed config object.
- Save success:
  - reloads dashboard data.
  - keeps/selects the saved feed.
  - closes or resets the form.
  - shows a success status.
- Save failure:
  - leaves form values intact.
  - shows the API error text in the dashboard status.
- Cancel closes the form without changing remote data.
- Existing enable/OPML toggles and episode actions keep working.
- Dashboard security constraints remain:
  - no `.innerHTML`
  - no `insertAdjacentHTML`
  - no external scripts/styles/assets
  - no `/api/nas/` references
  - no literal external `http://` or `https://` assets in dashboard source
- Tests and checks pass.

---

## UI Shape

- Add a `New` button in the Feeds section header next to the selected feed label.
- Add an `Edit` button beside the existing `Copy` button in every feed row.
- Add one inline form region below the Feeds header and above the table.
- Keep the form compact and operational:
  - grouped rows for identity/source, scheduling/retention, publication flags, and filters.
  - checkboxes for booleans.
  - select for provider.
  - numeric inputs for integer fields.
  - text inputs/textarea for strings.
- Avoid modal complexity in this phase.

---

## Payload Rules

Create defaults:

```json
{
  "feed_id": "",
  "provider": "youtube",
  "url": "",
  "title_override": null,
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
    "not_title": null,
    "description": null,
    "not_description": null,
    "min_duration": null,
    "max_duration": null,
    "min_age": null,
    "max_age": null
  }
}
```

Form conversion:

- `readFeedFormValues()` always returns the full `/api/admin/feeds/upsert` object shape.
- `textOrNull(value)`: trim, return `null` for blank, otherwise string.
- Required text fields:
  - `feed_id`
  - `url`
  - `update_period`
- Required numeric fields:
  - `page_size`, positive integer.
  - `keep_last`, non-negative integer.
- Optional numeric filter fields:
  - blank -> `null`.
  - otherwise non-negative integer.
- Booleans come from checkbox `.checked`.
- In edit mode, build identity fields from state/original feed:
  - `feed_id`: `state.editingFeedID`.
  - `provider`: `findFeedByID(state.editingFeedID).provider`.
  - If the original feed is missing, throw a local error and skip the POST.
- In edit prefill, filter inputs must use nested raw values from `feed.filters.*`, not display fields such as top-level `feed.title` or `feed.description`.

---

## Implementation Tasks

### Task 1: Dashboard State And Paths

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [x] Add `feedUpsert: "/api/admin/feeds/upsert"` to dashboard paths.
- [x] Add form state:
  - `feedFormOpen`
  - `feedFormMode`
  - `editingFeedID`
- [x] Add helpers to find a feed by ID and build default form data.

### Task 2: HTML And CSS

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [x] Add Feeds section header actions with a `New` button.
- [x] Add one hidden form region with stable IDs/data markers for tests.
- [x] Add compact form CSS using existing palette and spacing.
- [x] Keep layout responsive without nested cards or external assets.

### Task 3: Form Fill And Reset

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [x] Implement `openNewFeedForm()`.
- [x] Implement `openEditFeedForm(feedID)`.
- [x] Implement `closeFeedForm()`.
- [x] Implement `setFeedFormValues(feed)`.
- [x] Implement `readFeedFormValues()` with local conversion for nulls and numbers.
- [x] In edit mode, make `feed_id` and `provider` non-editable.
- [x] In edit mode, submit `feed_id` from `state.editingFeedID` and `provider` from the original feed object, not from DOM control values.
- [x] If the original feed is missing in edit mode, show an error and do not call the API.
- [x] Prefill filter controls from `feed.filters.*`, not from display `feed.title` or `feed.description`.

### Task 4: Submit Flow

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [x] Add `submitFeedForm(event)`.
- [x] Call `postJSON(paths.feedUpsert, payload)`.
- [x] On success:
  - set `state.selectedFeedID` to saved `feed_id`.
  - close form.
  - reload dashboard.
  - show success status.
- [x] On failure:
  - keep form open.
  - show error status.
- [x] Disable form buttons while `state.busy` is true.

### Task 5: Preserve Existing Dashboard Behavior

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [x] Existing feed status toggles still post to `/api/admin/feeds/status`.
- [x] Existing episode actions still post to `/api/admin/episodes/status`.
- [x] Existing subscription copy actions still work.
- [x] Existing selected feed and episode loading flow remains intact.

### Task 6: Tests

**Files:**

- Modify: `cloudflare/worker/test/auth-routes.test.ts`
- Add a dashboard source test only if it keeps assertions cleaner.

- [x] Dashboard shell test asserts source includes:
  - `/api/admin/feeds/upsert`
  - form marker such as `data-feed-form`
  - `openNewFeedForm`
  - `openEditFeedForm`
  - `submitFeedForm`
  - feed form field IDs for every top-level payload field.
  - feed form field IDs for all 8 filter keys.
- [x] Dashboard source tests assert helper/source markers for:
  - full-object payload construction.
  - all top-level payload keys.
  - all filter payload keys.
  - edit-mode identity from `state.editingFeedID` and original feed provider.
  - submit target `paths.feedUpsert`.
- [x] Dashboard security source test still rejects unsafe DOM shortcuts and external assets.
- [x] Existing auth/method tests still pass.

### Task 7: Verification

- [x] Run `cd cloudflare/worker && npm run check`.
- [x] Run `cd cloudflare/worker && npm run d1:check`.
- [x] Run `cd cloudflare/worker && npm run wrangler:check`.
- [x] Run `go test ./...`.
- [x] Run `git diff --check`.
- [x] Spawn implementation review sub-agents after tests pass and address blockers.

---

## Review Gates

Plan review should verify:

- The phase is UI-only and does not leak backend/schema changes.
- The form submits the full-object upsert API shape.
- Edit mode cannot accidentally attempt rename/provider change because submit identity comes from state/original feed, not form control values.
- Security constraints remain explicit.
- The test strategy is realistic for the current no-build inline dashboard.

Implementation review should verify:

- No unsafe DOM APIs were introduced.
- No external assets were introduced.
- Form conversion preserves null/number/boolean semantics.
- Save success/failure behavior is understandable.
- Existing dashboard actions still call their original endpoints.

---

## Rollback Plan

If the dashboard form causes issues, revert this phase commit. The previously committed `/api/admin/feeds/upsert` API, dashboard read-only shell, admin status actions, NAS config fetch, remote publish, RSS/OPML, tombstone sync, events, and scheduled purge remain independently usable.
