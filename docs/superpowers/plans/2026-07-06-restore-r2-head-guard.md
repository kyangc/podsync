# Restore R2 Head Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the remote episode restore path so `delete_pending` episodes with an R2 asset are restored only when the Worker can confirm the R2 object still exists.

**Architecture:** Keep this as a small Cloudflare Worker correctness slice. The admin restore API already owns episode state transitions and tombstone writes. Before changing `delete_pending -> visible`, check the current episode's `r2_key`; when present, call `env.MEDIA_BUCKET.head(r2_key)`. If the object is missing or the bucket binding is unavailable, do not update D1 and do not write a restore tombstone.

**Tech Stack:** Cloudflare Worker TypeScript, D1, R2 binding, existing Vitest fake D1/admin action tests.

---

## Scope Boundaries

This phase may modify:

- `cloudflare/worker/src/db.ts`
- `cloudflare/worker/src/index.ts`
- `cloudflare/worker/test/fake-d1.ts`
- `cloudflare/worker/test/admin-actions.test.ts`
- `docs/superpowers/plans/2026-07-06-restore-r2-head-guard.md`

This phase must not implement:

- Feed delete.
- Dashboard UI changes.
- NAS tombstone/outbox changes.
- R2 purge cron changes.
- Episode delete scheduling changes.
- D1 schema migrations.
- R2 key generation or upload behavior.
- Live Cloudflare deploy or NAS restart.

---

## Assumptions

- `delete_pending` with a non-empty `r2_key` should restore only if the R2 object is still present.
- `delete_pending` with a blank or null `r2_key` can keep existing restore behavior. This can happen for episodes deleted before a successful remote upload; restoring them should allow future NAS publishing attempts rather than requiring a nonexistent object.
- Blank `r2_key` means `null` or exactly `""`. Valid upserted R2 keys are already non-empty; whitespace-only legacy data is out of scope for this guard.
- Hidden episodes keep existing restore behavior and do not require R2 HEAD.
- `purged` remains non-restorable.
- If `MEDIA_BUCKET` is missing while a non-empty `r2_key` must be verified, the safe behavior is to reject restore instead of making the episode visible.
- The restore update must conditionally match the exact state that was validated before mutation. HEAD success alone is not enough because the episode can race from `hidden` to `delete_pending`, or its `r2_key` can change, between the initial read and D1 update.

---

## Acceptance Criteria

- `selectEpisodeAdminRow` includes `r2_key`.
- Restoring a `hidden` episode remains unchanged:
  - no R2 HEAD required.
  - status becomes `visible`.
  - one restore tombstone is written.
- Restoring a `delete_pending` episode with `r2_key = null` or `""` remains allowed.
- Restoring a `delete_pending` episode with a non-empty `r2_key`:
  - calls `MEDIA_BUCKET.head(r2_key)` before D1 mutation.
  - succeeds only if HEAD returns an object.
  - returns `409` with body `media object not found` when HEAD returns `null`.
  - returns `503` with body `media bucket unavailable` when the `MEDIA_BUCKET` binding is unavailable.
  - returns `502` with body `media object check failed` when HEAD throws.
  - does not update episode status or write tombstone on any HEAD failure.
- Restore D1 mutation is conditional on the validated row:
  - hidden restore updates only if current status is still `hidden`.
  - `delete_pending` restore with null/blank `r2_key` updates only if current status is still `delete_pending` and `r2_key` is still null/blank.
  - `delete_pending` restore with non-empty `r2_key` updates only if current status is still `delete_pending` and `r2_key` is still the same key that was HEAD-verified.
- Repeated restore on already visible episodes remains idempotent and does not HEAD.
- Existing hide/delete behavior is unchanged.
- Tests and checks pass.

---

## Implementation Tasks

### Task 1: Extend Admin Episode Row

**Files:**

- Modify: `cloudflare/worker/src/db.ts`
- Modify: `cloudflare/worker/src/index.ts`

- [x] Add `r2_key: string | null` to `EpisodeAdminRow`.
- [x] Update `selectEpisodeAdminRow()` SQL to select `r2_key`.
- [x] Ensure fake D1 returns full episode rows for that query. Prefer `SELECT feed_id, local_episode_id, status, r2_key` so the existing fake full-row path works; if using `SELECT status, r2_key`, update fake D1 explicitly.

### Task 2: Add Restore Guard

**Files:**

- Modify: `cloudflare/worker/src/index.ts`

- [x] Add helper `restoreRequiresR2Head(episode, action)` or equivalent.
- [x] Add helper for blank R2 keys:
  - `r2_key === null`
  - `r2_key.trim() === ""`
- [x] Add helper `verifyRestorableR2Object(env, episode)`:
  - no-op for non-restore actions.
  - no-op for statuses other than `delete_pending`.
  - no-op for missing/blank `r2_key`.
  - return `503` if `env.MEDIA_BUCKET` is missing.
  - call `env.MEDIA_BUCKET.head(r2_key)`.
  - return `409` if HEAD returns `null`.
  - return `502` if HEAD throws.
  - return `null` on success.
- [x] Call the guard after transition validation and before `env.DB.batch`.
- [x] Change restore update SQL so it pins the validated current row:
  - hidden restore: `status = 'hidden'`.
  - delete-pending restore with non-empty key: `status = 'delete_pending' AND r2_key = ?`.
  - delete-pending restore with null/blank key: `status = 'delete_pending' AND (r2_key IS NULL OR r2_key = '')`.
- [x] Bind the validated `r2_key` only after a successful HEAD when HEAD is required.
- [x] Update fake D1 to enforce the new restore `r2_key` predicates so key-race tests are meaningful.
- [x] Keep the existing generic hide/delete update predicates unchanged.
- [x] Do not write tombstones when the guard rejects restore.
- [x] If the conditional update loses the race, keep returning the existing concurrent-change `409` path and do not write a restore tombstone.

### Task 3: Tests

**Files:**

- Modify: `cloudflare/worker/test/admin-actions.test.ts`
- Modify: `cloudflare/worker/test/fake-d1.ts`

- [x] Add a small fake R2 bucket with `head()` support.
- [x] Update the existing `delete_pending` restore success test to pass a bucket and assert HEAD was called.
- [x] Add `delete_pending` restore tests for `r2_key: null` and `r2_key: ""`:
  - no bucket required.
  - no HEAD called.
  - restore succeeds and writes one tombstone.
- [x] Add missing-object test:
  - HEAD returns `null`.
  - response is `409`.
  - response body is `media object not found`.
  - episode remains `delete_pending`.
  - no tombstone is written.
- [x] Add missing-bucket test:
  - response is `503`.
  - response body is `media bucket unavailable`.
  - episode remains `delete_pending`.
  - no tombstone is written.
- [x] Add head-error test:
  - HEAD throws.
  - response is `502`.
  - response body is `media object check failed`.
  - episode remains `delete_pending`.
  - no tombstone is written.
- [x] Add or adjust a hidden restore test proving hidden restore does not require bucket.
- [x] Add race/no-mutation tests using `beforeEpisodeStatusUpdate`:
  - read as `hidden`, change to `delete_pending` before update, assert `409`, status remains `delete_pending`, no tombstone.
  - read as `delete_pending`, HEAD old key succeeds, change `r2_key` before update, assert `409`, status remains `delete_pending`, no tombstone.
- [x] Keep existing hide/delete/repeated restore tests intact.

### Task 4: Verification

- [x] Run `cd cloudflare/worker && npm run check`.
- [x] Run `cd cloudflare/worker && npm run d1:check`.
- [x] Run `cd cloudflare/worker && npm run wrangler:check`.
- [x] Run `go test ./...`.
- [x] Run `git diff --check`.
- [x] Spawn implementation review sub-agents after tests pass and address blockers.

---

## Review Gates

Plan review should verify:

- The phase only guards restore and does not widen into feed delete or dashboard work.
- The status codes and failure behavior are explicit.
- The missing/blank `r2_key` behavior is deliberate and does not block future publishing retries.
- Tests cover success and failure without relying on real R2.

Implementation review should verify:

- D1 mutation and tombstone insert happen only after successful HEAD when HEAD is required.
- The guard does not affect hidden restore, repeated visible restore, hide, or delete.
- R2 errors are not swallowed into a successful restore.
- Tests assert no status/tombstone mutation on guard failures.

---

## Rollback Plan

If this guard causes unexpected admin restore failures, revert this phase commit. Existing feed config, dashboard, episode hide/delete, tombstone sync, remote publish, RSS/OPML, event ingestion, and scheduled purge remain independently usable.
