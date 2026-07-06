# Admin Feed Delete Implementation Plan

## Goal

Complete the second-stage feed delete behavior described in `docs/remote-control-plane.md`: an admin can delete a feed from the Cloudflare dashboard/control plane, existing remote episodes are tombstoned as `delete_pending`, public subscription surfaces stop exposing the feed, and NAS tombstone sync can still see the deletion markers.

This phase must keep deletion recoverability and sync safety above physical cleanup. Physical media deletion remains the existing delayed scheduled purge path.

## Assumptions

- `feed_id` remains immutable and is still the identity used by NAS, R2 keys, local episode ids, RSS links, and tombstones.
- Feed delete means logical delete, not a SQL `DELETE FROM feeds`.
- Deleted feeds do not need a first-version restore API.
- Existing episode-level delayed purge already owns R2 object deletion and `purged` tombstones.
- Dashboard delete is included in this phase so the feature is usable from the control plane without a manual `curl`.

## Non-Goals

- No hard deletion of `feeds`, `episodes`, `feed_metadata`, `feed_filters`, or `tombstone_changes`.
- No feed restore API.
- No immediate R2 deletion.
- No NAS-side local file/XML deletion in this phase.
- No OPML token management changes.
- No feed rename or provider migration.

## Design

### Soft Delete Model

Add `feeds.deleted_at TEXT` through a new migration.

When a feed is deleted:

1. Set `feeds.deleted_at = CURRENT_TIMESTAMP`.
2. Set `feeds.enabled = 0`.
3. Set `feeds.include_in_opml = 0`.
4. Set `feeds.public_path = NULL`.
5. Mark currently publishable or hidden episodes for that feed as `delete_pending`.
6. Insert one `tombstone_changes` row per newly marked episode with `status='delete_pending'` and `action='delete'`.

Do not cascade or remove the feed row. Keeping rows is required because `/api/nas/tombstones?cursor=0` builds a current snapshot from `episodes`; hard deletion would make NAS miss old delete markers after cursor loss or first sync.

### API

Add `POST /api/admin/feeds/delete`.

Request:

```json
{
  "feed_id": "example"
}
```

Response:

```json
{
  "ok": true,
  "feed_id": "example",
  "deleted": true,
  "episodes_marked": 12
}
```

Validation:

- Cloudflare Access required through the existing `/api/admin/` gate.
- Method must be POST.
- JSON body must be bounded by existing `readBoundedJson`.
- `feed_id` must be a non-empty string.
- Missing feed returns 404.
- Already deleted feed is idempotent and returns `deleted: false`, `episodes_marked: 0`.

### Tombstone Semantics

Only episodes in `pending`, `visible`, or `hidden` move to `delete_pending`.

Episodes already in `delete_pending` or `purged` are not changed and do not receive duplicate tombstone rows.

Use a rollback-safe D1 batch transaction. Do not rely on comparing counts after the batch has committed.

Algorithm:

1. Read the feed by `feed_id` without filtering `deleted_at`, so already-deleted feeds can return an idempotent response.
2. If `deleted_at IS NOT NULL`, return `deleted:false, episodes_marked:0`.
3. Read `candidate_count = COUNT(*)` for episodes in `pending`, `visible`, or `hidden`.
4. Execute one `env.DB.batch` containing these statements in order:
   - Insert tombstones using `INSERT INTO tombstone_changes ... SELECT ... FROM episodes WHERE feed_id = ? AND status IN (...)`.
   - Assert the previous statement changed exactly `candidate_count` rows. Implement the assertion as a statement that intentionally violates a NOT NULL/CHECK constraint only when `changes() <> ?`, so D1 rolls back the whole batch on mismatch.
   - Update the same episode predicate to `delete_pending`, set `deleted_at`, `purge_after`, and `updated_at`.
   - Assert the previous statement changed exactly `candidate_count` rows using the same constraint-failure assertion helper.
   - Update the feed row with `WHERE feed_id = ? AND deleted_at IS NULL`, setting `deleted_at`, `enabled=0`, `include_in_opml=0`, `public_path=NULL`, and `updated_at`.
   - Assert the feed update changed exactly one row.

This gives all-or-nothing behavior for feed deletion. If tombstone insertion fails, if a concurrent change makes the candidate count stale, or if the feed was concurrently deleted, the batch fails and no feed/episode/tombstone partial mutation remains. Return 409 for concurrency assertion failures and 500 for unexpected D1 failures.

The fake D1 transaction helper must simulate these assertions and rollback when any assertion or tombstone insert fails.

### Public And Admin Read Surfaces

Deleted feeds should be hidden from:

- `/api/nas/config.toml`
- `/api/admin/feeds`
- `/api/admin/subscriptions`
- public OPML at `/opml/<token>`

Deleted feed public RSS should return HTTP 410 Gone when requested by its old feed token hash. This is why `feed_token_hash` stays in the DB even though `public_path` becomes `NULL`.

### NAS Write Surfaces

Stale NAS writes for deleted feeds must not recreate remote content.

Update these endpoints to treat deleted feeds as not found:

- `POST /api/nas/feed-metadata/upsert`
- `POST /api/nas/episodes/upsert`

Use `WHERE feed_id = ? AND deleted_at IS NULL` or equivalent checks. The response should remain 404 `feed not found` so the NAS client treats the stale job like a non-existent remote feed rather than a retryable server error.

### Admin Mutation Surfaces

Do not allow config/status edits to resurrect a deleted feed:

- `POST /api/admin/feeds/upsert` on an existing deleted `feed_id` returns 409 `feed is deleted`.
- `POST /api/admin/feeds/status` on a deleted feed returns 404 `feed not found`.

Episode-level admin actions must not move deleted-feed episodes out of the tombstone set. If a feed row exists and `deleted_at IS NOT NULL`, `POST /api/admin/episodes/status` returns 404 `feed not found` before applying hide/delete/restore. This prevents a restore from turning `delete_pending` back into `visible`, which would make `cursor=0` tombstone snapshots forget that episode.

`GET /api/admin/episodes?feed_id=<deleted>` should also return 404. The dashboard will not expose deleted feeds, and first-version deleted-feed episode inspection is not a goal.

### Dashboard

Add a Delete button to each feed row.

Behavior:

- Button is next to existing Copy/Edit actions.
- Use `window.confirm` with the feed id and clear wording that this removes the feed from subscriptions and marks remote episodes for delayed deletion.
- On confirm, call `POST /api/admin/feeds/delete`.
- On success, if the deleted feed was selected, clear `state.selectedFeedID` before calling `loadDashboard()`. The existing `loadDashboard()` behavior may select the first remaining feed after refresh; this is acceptable and becomes the intended behavior.
- On failure, show the existing dashboard error message area.

Dashboard source-level tests must assert these markers:

- `feedDelete: "/api/admin/feeds/delete"`.
- a feed-row Delete button with danger styling.
- `window.confirm` text that includes the feed id.
- `postJSON(paths.feedDelete, { feed_id: feedID })`.
- selected feed clearing before refresh.
- `await loadDashboard()` after success.
- `showError(error)` on failure.

## Implementation Tasks

### Task 1: Schema And Types

- Add `cloudflare/worker/migrations/0003_feed_deletion.sql`.
- Add `deleted_at` to feed row TypeScript interfaces that read or fake feed rows need.
- Update schema tests to assert the migration.

Verify:

- `npm run check -- --run cloudflare/worker/test/schema.test.ts` if supported; otherwise full Worker tests.

### Task 2: Worker Delete API

- Add a small parser for `{ feed_id }`.
- Add SQL helpers for feed soft-delete, feed-delete tombstone insert, and bulk episode delete-pending update.
- Add `handleAdminFeedDelete`.
- Wire `/api/admin/feeds/delete`.
- Make the operation idempotent for already deleted rows.

Verify:

- Tests for auth/method inherited route behavior.
- Tests for missing feed, idempotent already-deleted feed, successful delete with mixed episode statuses, and rollback behavior when tombstone insert or assertion fails.

### Task 3: Read And Write Surface Guards

- Exclude `deleted_at IS NULL` from NAS TOML, admin feed list, admin subscriptions, and OPML.
- Public RSS returns 410 for deleted feeds.
- NAS metadata/episode upsert reject deleted feeds as 404.
- Admin feed upsert/status and episode status actions do not resurrect deleted feeds.

Verify:

- Existing disabled-feed behavior remains unchanged.
- New deleted-feed tests cover each listed surface.
- `cursor=0` still returns deleted-feed episode tombstones after attempted admin episode actions.

### Task 4: Dashboard Delete Control

- Add `feedDelete` path.
- Add row button and delete handler.
- Refresh data after success.
- Keep existing edit form behavior intact.

Verify:

- Dashboard source marker tests pass.
- Existing dashboard tests still pass.

### Task 5: Fake D1 And Transaction Semantics

- Add `deleted_at` to fake feed data.
- Teach fake D1 to filter deleted feeds when queries ask for `deleted_at IS NULL`.
- Implement fake feed-delete tombstone insert and episode update.
- Preserve rollback via the existing `batch` staging flow.

Verify:

- New Worker tests exercise real fake-D1 state transitions, not just SQL strings.

### Task 6: Quality Gate And Commit

Run:

```bash
npm --prefix cloudflare/worker run check
npm --prefix cloudflare/worker run d1:check
npm --prefix cloudflare/worker run wrangler:check
go test ./...
git diff --check
```

Ask sub-agents to review implementation for:

- Hard-delete/cascade risk.
- Tombstone count mismatch or duplicate tombstone risk.
- Deleted feed resurfacing in NAS/OPML/admin/RSS.
- Dashboard path or payload mistakes.
- Test gaps.

Only commit after review is PASS or all blocking findings are fixed.

## Success Criteria

- Deleting a feed never physically removes rows needed for tombstone snapshots.
- Existing public RSS URL for a deleted feed returns 410.
- Deleted feed is absent from NAS config, admin feed list, admin subscriptions, and OPML.
- Existing episodes for the deleted feed become `delete_pending` unless already `delete_pending`/`purged`.
- One delete tombstone is created for each newly marked episode.
- Stale NAS metadata/episode upserts cannot recreate deleted feed content.
- Dashboard exposes feed deletion.
- Full Worker checks, D1 dry run, Wrangler check, Go tests, and diff whitespace check pass.

## Rollback Plan

- Revert this phase commit.
- If migration was applied in an environment, leave `deleted_at` column unused; older code ignores it.
- Existing delayed purge/tombstone behavior remains compatible because this phase only adds a nullable column and new filtering.
