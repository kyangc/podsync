# NAS Tombstone Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NAS Podsync pull remote tombstones, persist the cursor atomically, and stop remote outbox tasks from publishing hidden/deleted episodes.

**Architecture:** Keep this phase Go/NAS-side only and reuse the existing remote control-plane API from Phase 4A. The NAS client fetches `/api/nas/tombstones`, Badger persists the cursor plus per-episode tombstone markers, and the remote publish outbox consults those markers before enqueueing, listing, or preparing tasks. Tombstone sync is best-effort: failures log warnings and retry later, without breaking local podcast generation.

**Tech Stack:** Go, BadgerDB, existing `services/remote` NAS client and processor, existing `cmd/podsync` remote wiring, table-driven tests with `testify`.

---

## Scope Boundaries

This phase may modify:

- `pkg/model/errors.go`
- `pkg/model/remote.go`
- `pkg/db/badger.go`
- `pkg/db/remote_outbox.go`
- `pkg/db/remote_outbox_test.go`
- `pkg/db/remote_tombstone.go`
- `pkg/db/remote_tombstone_test.go`
- `services/remote/client.go`
- `services/remote/client_test.go`
- `services/remote/processor.go`
- `services/remote/processor_test.go`
- `services/remote/tombstone.go`
- `services/remote/tombstone_test.go`
- `cmd/podsync/main.go`
- `cmd/podsync/remote_publish_test.go`
- `cmd/podsync/remote_tombstone.go`
- `cmd/podsync/remote_tombstone_test.go`
- `docs/superpowers/plans/2026-07-06-nas-tombstone-sync.md`

This phase must not implement:

- Cloudflare Worker API changes
- R2 delete/purge cron
- dashboard HTML/UI
- OPML listing
- event/sync-run logging
- feed delete
- local NAS mp3/XML/OPML deletion
- Docker, CI, NAS live deployment, or production config changes

---

## Acceptance Criteria

- `NASClient.FetchTombstones` calls `GET /api/nas/tombstones?cursor=<cursor>&limit=<limit>` with Bearer auth, validates the JSON response, redacts tokens in error messages, and rejects malformed status/action/cursor data.
- Badger stores a tombstone cursor at `remote/tombstone/cursor` and only advances it after applying the full batch in the same write transaction.
- Badger stores tombstone markers by stable identity `feed_id + local_episode_id`, using the same encoded task id shape as remote publish tasks.
- Tombstone statuses `hidden`, `delete_pending`, and `purged` create/update local tombstone markers.
- Restore/visible changes remove local tombstone markers.
- A tombstoned episode is not newly enqueued into the remote publish outbox.
- Existing pending remote publish tasks for a newly tombstoned episode are marked failed with `model.ErrRemoteEpisodeTombstoned`.
- Due-task listing skips tombstoned tasks as a defensive guard.
- If a task is fetched due and then tombstoned before prepare, prepare marks it failed and the processor does not upload it.
- If a tombstone is restored and a later feed update enqueues the same episode again, a task previously failed only because of `model.ErrRemoteEpisodeTombstoned` is reset to pending.
- A `TombstoneSyncer` pulls pages until `has_more=false`, advances cursor only after each page is applied, and rejects `has_more=true` responses that do not advance `next_cursor`.
- `cmd/podsync` builds tombstone sync when `[remote]` is enabled and `base_url/token` are present, independent of R2 config completeness.
- Startup/headless flow syncs tombstones before feed updates and remote publishing.
- Long-running flow runs a periodic tombstone sync loop and also syncs after accepted remote config refresh before enqueueing refreshed feed updates.
- Local-only and `remote.enabled=false` behavior remains unchanged.

---

## Design Decisions

- Tombstones only affect the remote/R2 publishing surface in this phase. They do not delete local NAS media files, local XML, or local OPML.
- Local tombstone markers are durable Badger records, not in-memory maps, so a container restart cannot republish hidden/deleted episodes.
- The cursor is advanced in the same Badger transaction that applies changes. If Badger fails midway, the cursor is not advanced.
- The outbox does not create a new failed task when enqueue is called for an already tombstoned episode. It simply no-ops. Existing pending tasks are failed when tombstones are applied or when prepare detects a race.
- Restore removes the marker. A later enqueue resets a task that failed solely with `model.ErrRemoteEpisodeTombstoned`; other failed tasks stay failed, preserving existing semantics.

---

## Task 1: Model Types And NAS Tombstone Client

**Files:**

- Modify: `pkg/model/errors.go`
- Modify: `pkg/model/remote.go`
- Modify: `services/remote/client.go`
- Modify: `services/remote/client_test.go`

- [x] **Step 1.1: Add model error and tombstone types**

Add to `pkg/model/errors.go`:

```go
ErrRemoteEpisodeTombstoned = errors.New("remote episode tombstoned")
```

Add to `pkg/model/remote.go`:

```go
type RemoteEpisodeStatus string

const (
	RemoteEpisodeStatusPending       = RemoteEpisodeStatus("pending")
	RemoteEpisodeStatusVisible       = RemoteEpisodeStatus("visible")
	RemoteEpisodeStatusHidden        = RemoteEpisodeStatus("hidden")
	RemoteEpisodeStatusDeletePending = RemoteEpisodeStatus("delete_pending")
	RemoteEpisodeStatusPurged        = RemoteEpisodeStatus("purged")
)

type RemoteTombstoneAction string

const (
	RemoteTombstoneActionHide    = RemoteTombstoneAction("hide")
	RemoteTombstoneActionDelete  = RemoteTombstoneAction("delete")
	RemoteTombstoneActionPurge   = RemoteTombstoneAction("purge")
	RemoteTombstoneActionRestore = RemoteTombstoneAction("restore")
)

type RemoteTombstoneChange struct {
	Sequence       int64                 `json:"sequence"`
	FeedID         string                `json:"feed_id"`
	LocalEpisodeID string                `json:"local_episode_id"`
	Status         RemoteEpisodeStatus   `json:"status"`
	Action         RemoteTombstoneAction `json:"action"`
	CreatedAt      string                `json:"created_at"`
}

type RemoteTombstoneBatch struct {
	Cursor     int64                   `json:"cursor"`
	NextCursor int64                   `json:"next_cursor"`
	HasMore    bool                    `json:"has_more"`
	Changes    []RemoteTombstoneChange `json:"changes"`
}

func (s RemoteEpisodeStatus) IsTombstoned() bool {
	return s == RemoteEpisodeStatusHidden ||
		s == RemoteEpisodeStatusDeletePending ||
		s == RemoteEpisodeStatusPurged
}

func (s RemoteEpisodeStatus) IsValidTombstoneResponseStatus() bool {
	return s == RemoteEpisodeStatusVisible || s.IsTombstoned()
}

func (a RemoteTombstoneAction) IsValid() bool {
	return a == RemoteTombstoneActionHide ||
		a == RemoteTombstoneActionDelete ||
		a == RemoteTombstoneActionPurge ||
		a == RemoteTombstoneActionRestore
}

func (c RemoteTombstoneChange) HasConsistentStatusAction() bool {
	switch c.Status {
	case RemoteEpisodeStatusVisible:
		return c.Action == RemoteTombstoneActionRestore
	case RemoteEpisodeStatusHidden:
		return c.Action == RemoteTombstoneActionHide
	case RemoteEpisodeStatusDeletePending:
		return c.Action == RemoteTombstoneActionDelete
	case RemoteEpisodeStatusPurged:
		return c.Action == RemoteTombstoneActionPurge
	default:
		return false
	}
}
```

- [x] **Step 1.2: Add tombstone fetcher interface and URL builder**

In `services/remote/client.go`, add:

```go
type TombstoneFetcher interface {
	FetchTombstones(ctx context.Context, cursor int64, limit int) (*model.RemoteTombstoneBatch, error)
}

func (c *NASClient) tombstonesURL(cursor int64, limit int) string {
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/nas/tombstones"
	query := endpoint.Query()
	query.Set("cursor", fmt.Sprintf("%d", cursor))
	if limit > 0 {
		query.Set("limit", fmt.Sprintf("%d", limit))
	}
	endpoint.RawQuery = query.Encode()
	endpoint.Fragment = ""
	return endpoint.String()
}
```

- [x] **Step 1.3: Add tombstone response validation**

In `services/remote/client.go`, add:

```go
func validateTombstoneBatch(batch *model.RemoteTombstoneBatch, requestedCursor int64) error {
	if batch == nil {
		return errors.New("tombstone response is empty")
	}
	if batch.Cursor != requestedCursor {
		return fmt.Errorf("tombstone response cursor mismatch: got %d want %d", batch.Cursor, requestedCursor)
	}
	if batch.NextCursor < batch.Cursor {
		return fmt.Errorf("tombstone next_cursor moved backwards: got %d cursor %d", batch.NextCursor, batch.Cursor)
	}
	var previous int64
	var lastPositiveSequence int64
	for i, change := range batch.Changes {
		if change.Sequence < 0 {
			return fmt.Errorf("tombstone change %d has invalid sequence", i)
		}
		if requestedCursor > 0 {
			if change.Sequence <= requestedCursor {
				return fmt.Errorf("tombstone change %d sequence did not advance cursor", i)
			}
			if previous > 0 && change.Sequence <= previous {
				return fmt.Errorf("tombstone changes are not strictly increasing at index %d", i)
			}
			lastPositiveSequence = change.Sequence
			previous = change.Sequence
		} else if change.Sequence > 0 {
			if previous > 0 && change.Sequence <= previous {
				return fmt.Errorf("tombstone changes are not strictly increasing at index %d", i)
			}
			previous = change.Sequence
		}
		if strings.TrimSpace(change.FeedID) == "" {
			return fmt.Errorf("tombstone change %d feed_id is required", i)
		}
		if strings.TrimSpace(change.LocalEpisodeID) == "" {
			return fmt.Errorf("tombstone change %d local_episode_id is required", i)
		}
		if !change.Status.IsValidTombstoneResponseStatus() {
			return fmt.Errorf("tombstone change %d status is invalid", i)
		}
		if !change.Action.IsValid() {
			return fmt.Errorf("tombstone change %d action is invalid", i)
		}
		if !change.HasConsistentStatusAction() {
			return fmt.Errorf("tombstone change %d status/action mismatch", i)
		}
	}
	if requestedCursor > 0 {
		if lastPositiveSequence == 0 {
			if batch.HasMore {
				return errors.New("tombstone page has_more without an advancing row")
			}
			if batch.NextCursor != requestedCursor {
				return fmt.Errorf("empty tombstone page advanced cursor: got %d want %d", batch.NextCursor, requestedCursor)
			}
			return nil
		}
		if batch.NextCursor != lastPositiveSequence {
			return fmt.Errorf("tombstone next_cursor mismatch: got %d want %d", batch.NextCursor, lastPositiveSequence)
		}
	}
	return nil
}
```

This validation allows cursor-zero snapshot rows with `sequence=0` and deterministic feed/id ordering. Cursor-zero snapshots may advance `next_cursor` to the Worker high-watermark even though snapshot rows have `sequence=0`. Incremental rows from the Worker must have positive strictly increasing sequence values, and an incremental response cannot advance `next_cursor` beyond the last returned sequence.

- [x] **Step 1.4: Implement `FetchTombstones`**

Add to `services/remote/client.go`:

```go
func (c *NASClient) FetchTombstones(ctx context.Context, cursor int64, limit int) (*model.RemoteTombstoneBatch, error) {
	if cursor < 0 {
		return nil, errors.New("tombstone cursor must be non-negative")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.tombstonesURL(cursor, limit), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(readLimitedString(resp.Body, maxNASClientErrorBody))
		message = strings.ReplaceAll(message, c.token, "[redacted]")
		if message == "" {
			return nil, fmt.Errorf("tombstones returned HTTP %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("tombstones returned HTTP %d: %s", resp.StatusCode, message)
	}

	var batch model.RemoteTombstoneBatch
	if err := json.NewDecoder(resp.Body).Decode(&batch); err != nil {
		return nil, err
	}
	if err := validateTombstoneBatch(&batch, cursor); err != nil {
		return nil, err
	}
	return &batch, nil
}
```

- [x] **Step 1.5: Add NAS client tombstone tests**

Extend `services/remote/client_test.go` with tests:

```go
func TestNASClientFetchTombstonesSendsExpectedRequest(t *testing.T)
func TestNASClientFetchTombstonesUsesDefaultLimitWhenZero(t *testing.T)
func TestNASClientFetchTombstonesClearsBaseURLQuery(t *testing.T)
func TestNASClientFetchTombstonesRejectsCursorMismatch(t *testing.T)
func TestNASClientFetchTombstonesRejectsBackwardCursor(t *testing.T)
func TestNASClientFetchTombstonesRejectsInvalidChange(t *testing.T)
func TestNASClientFetchTombstonesRejectsMismatchedStatusAction(t *testing.T)
func TestNASClientFetchTombstonesRejectsUnorderedIncrementalSequence(t *testing.T)
func TestNASClientFetchTombstonesRejectsIncrementalCursorJump(t *testing.T)
func TestNASClientFetchTombstonesAllowsCursorZeroSnapshotSequence(t *testing.T)
func TestNASClientFetchTombstonesRedactsTokenInErrors(t *testing.T)
```

Use `httptest.Server` and assert:

- method is `GET`
- path is `/api/nas/tombstones`
- `Authorization` is `Bearer secret`
- `Accept` is `application/json`
- `cursor=7&limit=100` is sent when called with `(7, 100)`
- no `limit` query is sent when called with `limit=0`
- stale query params on `remote.base_url` are not forwarded to `/api/nas/tombstones`

- [x] **Step 1.6: Verify client slice**

Run:

```bash
go test ./services/remote -run 'TestNASClientFetchTombstones'
```

Expected: PASS.

---

## Task 2: Badger Tombstone Store And Outbox Guards

**Files:**

- Modify: `pkg/db/badger.go`
- Modify: `pkg/db/remote_outbox.go`
- Modify: `pkg/db/remote_outbox_test.go`
- Create: `pkg/db/remote_tombstone.go`
- Create: `pkg/db/remote_tombstone_test.go`

- [x] **Step 2.1: Add Badger key constants**

Add to `pkg/db/badger.go` constants:

```go
remoteTombstoneCursorPath  = "remote/tombstone/cursor"
remoteTombstoneEpisodePath = "remote/tombstone/episode/%s"
```

- [x] **Step 2.2: Create tombstone store implementation**

Create `pkg/db/remote_tombstone.go`:

```go
package db

import (
	"context"
	"strings"
	"time"

	"github.com/dgraph-io/badger"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

type remoteTombstoneCursor struct {
	Value     int64     `json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
}

type remoteTombstoneMarker struct {
	FeedID         string                      `json:"feed_id"`
	LocalEpisodeID string                      `json:"local_episode_id"`
	Status         model.RemoteEpisodeStatus   `json:"status"`
	Action         model.RemoteTombstoneAction `json:"action"`
	Sequence       int64                       `json:"sequence"`
	CreatedAt      string                      `json:"created_at"`
	AppliedAt      time.Time                   `json:"applied_at"`
}

func (b *Badger) GetRemoteTombstoneCursor(_ context.Context) (int64, error) {
	var cursor remoteTombstoneCursor
	err := b.db.View(func(txn *badger.Txn) error {
		return b.getObj(txn, b.getKey(remoteTombstoneCursorPath), &cursor)
	})
	if err == model.ErrNotFound {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return cursor.Value, nil
}

func (b *Badger) ApplyRemoteTombstones(_ context.Context, batch *model.RemoteTombstoneBatch, now time.Time) error {
	if batch == nil {
		return errors.New("remote tombstone batch is required")
	}
	return b.db.Update(func(txn *badger.Txn) error {
			current, err := b.getRemoteTombstoneCursor(txn)
			if err != nil {
				return err
			}
			if batch.Cursor != current {
				return errors.Errorf("remote tombstone cursor mismatch: got %d current %d", batch.Cursor, current)
			}
			if batch.NextCursor < current {
				return errors.Errorf("remote tombstone cursor moved backwards: got %d current %d", batch.NextCursor, current)
			}
			for _, change := range batch.Changes {
			if err := b.applyRemoteTombstoneChange(txn, change, now); err != nil {
				return err
			}
		}
		return b.setObj(txn, b.getKey(remoteTombstoneCursorPath), &remoteTombstoneCursor{
			Value:     batch.NextCursor,
			UpdatedAt: now,
		}, true)
	})
}

func (b *Badger) IsRemoteEpisodeTombstoned(_ context.Context, feedID, localEpisodeID string) (bool, error) {
	var marker remoteTombstoneMarker
	err := b.db.View(func(txn *badger.Txn) error {
		return b.getObj(txn, b.remoteTombstoneEpisodeKey(feedID, localEpisodeID), &marker)
	})
	if err == model.ErrNotFound {
		return false, nil
	}
	return err == nil, err
}

func (b *Badger) getRemoteTombstoneCursor(txn *badger.Txn) (int64, error) {
	var cursor remoteTombstoneCursor
	err := b.getObj(txn, b.getKey(remoteTombstoneCursorPath), &cursor)
	if err == model.ErrNotFound {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return cursor.Value, nil
}

func (b *Badger) applyRemoteTombstoneChange(txn *badger.Txn, change model.RemoteTombstoneChange, now time.Time) error {
	if strings.TrimSpace(change.FeedID) == "" || strings.TrimSpace(change.LocalEpisodeID) == "" {
		return errors.New("remote tombstone identity is required")
	}
	if !change.HasConsistentStatusAction() {
		return errors.Errorf("remote tombstone status/action mismatch: %s/%s", change.Status, change.Action)
	}
	key := b.remoteTombstoneEpisodeKey(change.FeedID, change.LocalEpisodeID)
	if change.Status == model.RemoteEpisodeStatusVisible && change.Action == model.RemoteTombstoneActionRestore {
		err := txn.Delete(key)
		if err == badger.ErrKeyNotFound {
			return nil
		}
		return err
	}
	if !change.Status.IsTombstoned() {
		return errors.Errorf("remote tombstone status is not tombstoned: %s", change.Status)
	}
	marker := remoteTombstoneMarker{
		FeedID:         change.FeedID,
		LocalEpisodeID: change.LocalEpisodeID,
		Status:         change.Status,
		Action:         change.Action,
		Sequence:       change.Sequence,
		CreatedAt:      change.CreatedAt,
		AppliedAt:      now,
	}
	if err := b.setObj(txn, key, &marker, true); err != nil {
		return err
	}
	return b.failPendingRemotePublishTask(txn, model.RemotePublishTaskID(change.FeedID, change.LocalEpisodeID), now)
}

func (b *Badger) remoteEpisodeTombstoned(txn *badger.Txn, feedID, localEpisodeID string) (bool, error) {
	var marker remoteTombstoneMarker
	err := b.getObj(txn, b.remoteTombstoneEpisodeKey(feedID, localEpisodeID), &marker)
	if err == model.ErrNotFound {
		return false, nil
	}
	return err == nil, err
}

func (b *Badger) remoteTombstoneEpisodeKey(feedID, localEpisodeID string) []byte {
	return b.getKey(remoteTombstoneEpisodePath, model.RemotePublishTaskID(feedID, localEpisodeID))
}
```

- [x] **Step 2.3: Add outbox helper to fail tombstoned pending tasks**

Add to `pkg/db/remote_outbox.go`:

```go
func (b *Badger) failPendingRemotePublishTask(txn *badger.Txn, id string, now time.Time) error {
	var task model.RemotePublishTask
	err := b.getRemotePublishTask(txn, id, &task)
	if err == model.ErrNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	if task.Status != model.RemotePublishPending {
		return nil
	}
	task.Status = model.RemotePublishFailed
	task.LastError = model.ErrRemoteEpisodeTombstoned.Error()
	task.NextAttemptAt = time.Time{}
	task.UpdatedAt = now
	return b.setObj(txn, b.getKey(remotePublishTaskPath, id), &task, true)
}
```

- [x] **Step 2.4: Make enqueue no-op for tombstoned episodes**

In `EnqueueRemotePublishTask`, inside the Badger update transaction before reading existing task:

```go
tombstoned, err := b.remoteEpisodeTombstoned(txn, task.FeedID, task.LocalEpisodeID)
if err != nil {
	return err
}
if tombstoned {
	return nil
}
```

When updating an existing task, reset only tombstone-failed tasks:

```go
if existing.Status == model.RemotePublishFailed && existing.LastError == model.ErrRemoteEpisodeTombstoned.Error() {
	existing.Status = model.RemotePublishPending
	existing.Attempts = 0
	existing.NextAttemptAt = now
	existing.LastError = ""
	existing.R2Key = ""
	existing.AssetToken = ""
	existing.MimeType = ""
	existing.ServerStatus = ""
	existing.UpsertedAt = time.Time{}
	existing.CompletedAt = time.Time{}
}
```

Keep all existing metadata update assignments after this reset block.

- [x] **Step 2.5: Guard due and prepare against tombstones**

In `DueRemotePublishTasks`, after checking pending status and due time:

```go
tombstoned, err := b.remoteEpisodeTombstoned(txn, task.FeedID, task.LocalEpisodeID)
if err != nil {
	return err
}
if tombstoned {
	return nil
}
```

In `PrepareRemotePublishAttempt`, after loading the task and before status check:

```go
tombstoned := false
err := b.db.Update(func(txn *badger.Txn) error {
	// existing load task code...
	isTombstoned, err := b.remoteEpisodeTombstoned(txn, task.FeedID, task.LocalEpisodeID)
	if err != nil {
		return err
	}
	if isTombstoned {
		if err := b.failPendingRemotePublishTask(txn, id, now); err != nil {
			return err
		}
		tombstoned = true
		return nil
	}
	// existing prepare code...
})
if err == nil && tombstoned {
	return &task, model.ErrRemoteEpisodeTombstoned
}
return &task, err
```

Do not return `model.ErrRemoteEpisodeTombstoned` from inside the Badger update transaction. Returning an error there rolls back the failed-task write. Commit the failed state first, then return the sentinel after the transaction succeeds.

The resulting tombstone branch replaces this unsafe shape:

```go
tombstoned, err := b.remoteEpisodeTombstoned(txn, task.FeedID, task.LocalEpisodeID)
if err != nil {
	return err
}
if tombstoned {
	if err := b.failPendingRemotePublishTask(txn, id, now); err != nil {
		return err
	}
	return model.ErrRemoteEpisodeTombstoned
}
```

- [x] **Step 2.6: Make terminal outbox mutations tombstone-aware**

In `pkg/db/remote_outbox.go`, add:

```go
func (b *Badger) keepRemotePublishTombstoned(txn *badger.Txn, task *model.RemotePublishTask, now time.Time) (bool, error) {
	tombstoned, err := b.remoteEpisodeTombstoned(txn, task.FeedID, task.LocalEpisodeID)
	if err != nil {
		return false, err
	}
	if !tombstoned {
		return false, nil
	}
	task.Status = model.RemotePublishFailed
	task.LastError = model.ErrRemoteEpisodeTombstoned.Error()
	task.NextAttemptAt = time.Time{}
	task.UpdatedAt = now
	return true, b.setObj(txn, b.getKey(remotePublishTaskPath, task.ID), task, true)
}
```

Use this helper at the start of `CompleteRemotePublishTask`, `RetryRemotePublishTask`, `DeferRemotePublishTask`, and `FailRemotePublishTask` after loading the task. The transaction must commit the tombstone failed state and then return `model.ErrRemoteEpisodeTombstoned` after commit:

```go
tombstoned := false
err := b.db.Update(func(txn *badger.Txn) error {
	var task model.RemotePublishTask
	if err := b.getRemotePublishTask(txn, id, &task); err != nil {
		return err
	}
	handled, err := b.keepRemotePublishTombstoned(txn, &task, now)
	if err != nil {
		return err
	}
	if handled {
		tombstoned = true
		return nil
	}
	// existing mutation body...
})
if err != nil {
	return err
}
if tombstoned {
	return model.ErrRemoteEpisodeTombstoned
}
return nil
```

This prevents stale processor work from overwriting a tombstone with `pending`, `succeeded`, or a different terminal error.

- [x] **Step 2.7: Add Badger tombstone tests**

Create `pkg/db/remote_tombstone_test.go` with:

```go
func TestBadgerRemoteTombstoneCursorDefaultsToZero(t *testing.T)
func TestBadgerApplyRemoteTombstonesStoresMarkerAndCursorAtomically(t *testing.T)
func TestBadgerApplyRemoteTombstonesRejectsBackwardCursor(t *testing.T)
func TestBadgerApplyRemoteTombstonesRejectsStaleOrGapCursor(t *testing.T)
func TestBadgerApplyRemoteTombstonesRollsBackInvalidMidBatchChange(t *testing.T)
func TestBadgerApplyRemoteTombstonesRestoreRemovesMarker(t *testing.T)
func TestBadgerApplyRemoteTombstonesFailsPendingPublishTask(t *testing.T)
```

Important assertions:

- Cursor defaults to `0`.
- Applying `NextCursor: 7` with one hidden change stores cursor `7`.
- `IsRemoteEpisodeTombstoned(feed, episode)` returns `true` after hidden/delete/purge.
- A restore batch with `Status: visible, Action: restore` removes marker and advances cursor.
- A pending task already in outbox becomes `RemotePublishFailed` with `LastError == model.ErrRemoteEpisodeTombstoned.Error()`.
- Backward cursor returns error and does not mutate cursor or marker.
- Stale/gap cursor returns error when `batch.Cursor != current`, before applying any change.
- Mid-batch invalid status/action returns error and rolls back earlier marker writes plus cursor advancement.

- [x] **Step 2.8: Extend remote outbox tests**

Add to `pkg/db/remote_outbox_test.go`:

```go
func TestBadgerEnqueueRemotePublishTaskSkipsTombstonedEpisode(t *testing.T)
func TestBadgerEnqueueRemotePublishTaskResetsRestoredTombstoneFailure(t *testing.T)
func TestBadgerDueRemotePublishTasksSkipsTombstonedEpisodes(t *testing.T)
func TestBadgerPrepareRemotePublishAttemptFailsTombstonedTask(t *testing.T)
func TestBadgerRemotePublishTerminalMutationsPreserveTombstone(t *testing.T)
```

Use `ApplyRemoteTombstones` in setup rather than writing markers directly.

- [x] **Step 2.9: Verify Badger slice**

Run:

```bash
go test ./pkg/db -run 'TestBadgerRemoteTombstone|TestBadgerApplyRemoteTombstones|TestBadgerEnqueueRemotePublishTask.*Tombstone|TestBadgerDueRemotePublishTasksSkipsTombstonedEpisodes|TestBadgerPrepareRemotePublishAttemptFailsTombstonedTask'
```

Expected: PASS.

---

## Task 3: Processor Tombstone Race Guard

**Files:**

- Modify: `services/remote/processor.go`
- Modify: `services/remote/processor_test.go`

- [x] **Step 3.1: Let processor treat prepare tombstone as handled**

In `services/remote/processor.go`, change the prepare error block:

```go
prepared, err := p.Outbox.PrepareRemotePublishAttempt(ctx, task.ID, r2Key, assetToken, mimeType, now)
if err != nil {
	if errors.Is(err, model.ErrRemoteEpisodeTombstoned) {
		return nil
	}
	return err
}
```

This depends on Task 2 making Badger persist the failed state inside `PrepareRemotePublishAttempt`.

- [x] **Step 3.2: Add processor race test**

Extend `services/remote/processor_test.go`:

```go
func TestProcessorDoesNotUploadWhenPrepareFindsTombstone(t *testing.T)
func TestProcessorPreservesTombstoneFailureWhenMediaMissingAfterDue(t *testing.T)
```

Use `fakeOutbox` with a new field:

```go
prepareErr error
```

Update fake `PrepareRemotePublishAttempt`:

```go
if o.prepareErr != nil {
	return nil, o.prepareErr
}
```

Test assertions:

- `processor.ProcessDue` returns nil.
- publisher uploads is empty.
- outbox completed/retried/deferred/failed are empty because Badger handles the terminal state in prepare.

- [x] **Step 3.3: Verify processor slice**

Run:

```bash
go test ./services/remote -run 'TestProcessorDoesNotUploadWhenPrepareFindsTombstone|TestProcessorUploadsDueTaskAndMarksSucceeded'
```

Expected: PASS.

---

## Task 4: Tombstone Syncer

**Files:**

- Create: `services/remote/tombstone.go`
- Create: `services/remote/tombstone_test.go`

- [x] **Step 4.1: Add syncer interfaces and struct**

Create `services/remote/tombstone.go`:

```go
package remote

import (
	"context"
	"errors"
	"time"

	"github.com/mxpv/podsync/pkg/model"
)

const defaultTombstoneLimit = 100

type TombstoneStore interface {
	GetRemoteTombstoneCursor(ctx context.Context) (int64, error)
	ApplyRemoteTombstones(ctx context.Context, batch *model.RemoteTombstoneBatch, now time.Time) error
}

type TombstoneSyncer struct {
	Fetcher TombstoneFetcher
	Store   TombstoneStore
	Limit   int
	Now     func() time.Time
}
```

- [x] **Step 4.2: Implement `SyncOnce`**

Add:

```go
func (s *TombstoneSyncer) SyncOnce(ctx context.Context) error {
	if s == nil || s.Fetcher == nil || s.Store == nil {
		return nil
	}
	limit := s.Limit
	if limit <= 0 {
		limit = defaultTombstoneLimit
	}
	cursor, err := s.Store.GetRemoteTombstoneCursor(ctx)
	if err != nil {
		return err
	}
	for {
		batch, err := s.Fetcher.FetchTombstones(ctx, cursor, limit)
		if err != nil {
			return err
		}
		if batch.HasMore && batch.NextCursor <= cursor {
			return errors.New("remote tombstone page did not advance cursor")
		}
		if err := s.Store.ApplyRemoteTombstones(ctx, batch, s.now()); err != nil {
			return err
		}
		cursor = batch.NextCursor
		if !batch.HasMore {
			return nil
		}
	}
}

func (s *TombstoneSyncer) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}
```

- [x] **Step 4.3: Add syncer tests**

Create `services/remote/tombstone_test.go` with:

```go
func TestTombstoneSyncerNoopsWhenDisabled(t *testing.T)
func TestTombstoneSyncerAppliesSinglePageAndAdvancesCursor(t *testing.T)
func TestTombstoneSyncerFetchesUntilHasMoreFalse(t *testing.T)
func TestTombstoneSyncerDoesNotAdvanceCursorWhenFetchFails(t *testing.T)
func TestTombstoneSyncerRejectsHasMoreWithoutCursorAdvance(t *testing.T)
```

Use fakes:

```go
type fakeTombstoneFetcher struct {
	batches []*model.RemoteTombstoneBatch
	err     error
	cursors []int64
	limits  []int
}

type fakeTombstoneStore struct {
	cursor  int64
	applied []*model.RemoteTombstoneBatch
	err     error
}
```

Ensure the failure test proves `ApplyRemoteTombstones` is not called when fetch fails.

- [x] **Step 4.4: Verify syncer slice**

Run:

```bash
go test ./services/remote -run 'TestTombstoneSyncer'
```

Expected: PASS.

---

## Task 5: Command Wiring

**Files:**

- Create: `cmd/podsync/remote_tombstone.go`
- Create: `cmd/podsync/remote_tombstone_test.go`
- Modify: `cmd/podsync/main.go`
- Modify: `cmd/podsync/remote_publish_test.go`

- [x] **Step 5.1: Add command-level tombstone wiring helpers**

Create `cmd/podsync/remote_tombstone.go`:

```go
package main

import (
	"context"
	"time"

	log "github.com/sirupsen/logrus"

	remotepublish "github.com/mxpv/podsync/services/remote"
)

const defaultRemoteTombstoneInterval = 5 * time.Minute

type remoteTombstoneSyncer interface {
	SyncOnce(ctx context.Context) error
}

type remoteTombstoneFetcherFactory func(baseURL string, token string) (remotepublish.TombstoneFetcher, error)

func remoteTombstoneSyncEnabled(cfg *Config) bool {
	return cfg.Remote.Enabled &&
		cfg.Remote.BaseURL != "" &&
		cfg.Remote.Token != ""
}

func newRemoteTombstoneFetcher(baseURL string, token string) (remotepublish.TombstoneFetcher, error) {
	return remotepublish.NewNASClient(baseURL, token, nil)
}

func buildRemoteTombstoneSyncer(cfg *Config, store remotepublish.TombstoneStore, newFetcher remoteTombstoneFetcherFactory) (remoteTombstoneSyncer, error) {
	if !remoteTombstoneSyncEnabled(cfg) {
		return nil, nil
	}
	fetcher, err := newFetcher(cfg.Remote.BaseURL, cfg.Remote.Token)
	if err != nil {
		return nil, err
	}
	return &remotepublish.TombstoneSyncer{
		Fetcher: fetcher,
		Store:   store,
	}, nil
}

func syncRemoteTombstonesOnce(ctx context.Context, syncer remoteTombstoneSyncer) {
	if syncer == nil {
		return
	}
	if err := syncer.SyncOnce(ctx); err != nil {
		log.WithError(err).Warn("remote tombstone sync failed")
	}
}

func runRemoteTombstoneLoop(ctx context.Context, syncer remoteTombstoneSyncer, interval time.Duration) error {
	if syncer == nil {
		return nil
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			syncRemoteTombstonesOnce(ctx, syncer)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
```

- [x] **Step 5.2: Wire startup and headless flow**

In `cmd/podsync/main.go`, after `remoteProcessor` is built and before headless feed updates:

```go
remoteTombstoneSyncer, err := buildRemoteTombstoneSyncer(cfg, database, newRemoteTombstoneFetcher)
if err != nil {
	log.WithError(err).Warn("remote tombstone sync disabled")
}
syncRemoteTombstonesOnce(ctx, remoteTombstoneSyncer)
```

Keep this before:

```go
if opts.Headless {
	for _, _feed := range activeFeeds {
```

- [x] **Step 5.3: Wire long-running loop**

In `cmd/podsync/main.go`, after starting the remote publish loop:

```go
if remoteTombstoneSyncer != nil {
	group.Go(func() error {
		return runRemoteTombstoneLoop(ctx, remoteTombstoneSyncer, defaultRemoteTombstoneInterval)
	})
}
```

This loop waits for the first tick because startup already performed one sync.

- [x] **Step 5.4: Sync after accepted remote config refresh before enqueue**

In the remote config refresh branch, after `entriesMu.Unlock()` and before `enqueueFeedUpdates(updates, feedsToQueue)`:

```go
syncRemoteTombstonesOnce(ctx, remoteTombstoneSyncer)
```

Do not hold `entriesMu` while syncing tombstones.

- [x] **Step 5.5: Add command wiring tests**

Create `cmd/podsync/remote_tombstone_test.go` with:

```go
func TestRemoteTombstoneSyncEnabledRequiresRemoteBaseURLAndToken(t *testing.T)
func TestBuildRemoteTombstoneSyncerSkipsDisabledConfig(t *testing.T)
func TestBuildRemoteTombstoneSyncerBuildsWithRemoteOnlyConfig(t *testing.T)
func TestSyncRemoteTombstonesOnceCallsSyncer(t *testing.T)
func TestSyncRemoteTombstonesOnceSwallowsError(t *testing.T)
func TestRunRemoteTombstoneLoopWaitsForTickAndStops(t *testing.T)
func TestRemoteStartupOrderingSyncsTombstonesBeforeHeadlessUpdateAndPublish(t *testing.T)
```

Use a fake syncer:

```go
type cmdFakeTombstoneSyncer struct {
	calls int
	err   error
}

func (s *cmdFakeTombstoneSyncer) SyncOnce(context.Context) error {
	s.calls++
	return s.err
}
```

For the loop test, use a short interval like `10 * time.Millisecond` and cancel after `calls == 1`.

For the startup-ordering test, add a tiny test-only helper in `remote_tombstone_test.go`:

```go
func recordRemoteStartupOrder(ctx context.Context, syncer remoteTombstoneSyncer, update func(), publish func()) []string {
	order := []string{}
	syncRemoteTombstonesOnce(ctx, syncer)
	order = append(order, "sync")
	update()
	order = append(order, "update")
	publish()
	order = append(order, "publish")
	return order
}
```

The test should assert `["sync", "update", "publish"]`. This mirrors the intended `main.go` placement: initial tombstone sync happens before headless feed updates and before `processRemotePublishOnce`.

- [x] **Step 5.6: Verify command slice**

Run:

```bash
go test ./cmd/podsync -run 'TestRemoteTombstone|TestBuildRemoteProcessor|TestProcessRemotePublishOnce|TestRunRemotePublishLoop'
```

Expected: PASS.

---

## Task 6: Phase 4B Quality Gate And Commit

- [x] **Step 6.1: Focused Go tests**

Run:

```bash
go test ./services/remote -run 'TestNASClientFetchTombstones|TestTombstoneSyncer|TestProcessorDoesNotUploadWhenPrepareFindsTombstone'
go test ./pkg/db -run 'TestBadgerRemoteTombstone|TestBadgerApplyRemoteTombstones|TestBadgerEnqueueRemotePublishTask.*Tombstone|TestBadgerDueRemotePublishTasksSkipsTombstonedEpisodes|TestBadgerPrepareRemotePublishAttemptFailsTombstonedTask'
go test ./cmd/podsync -run 'TestRemoteTombstone|TestBuildRemoteProcessor|TestProcessRemotePublishOnce|TestRunRemotePublishLoop'
```

Expected: PASS.

- [x] **Step 6.2: Full repo gate**

Run:

```bash
go test ./...
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
cd cloudflare/worker && npm run check
```

Expected: PASS.

- [x] **Step 6.3: Scope checks**

Run:

```bash
git diff -- cloudflare/worker .github Dockerfile 'Dockerfile.*'
git diff --check
git status --short --branch
git diff --stat
```

Expected:

- no Worker source changes
- no Docker/CI changes
- no R2 purge implementation
- no dashboard UI implementation
- Go NAS/client/db/outbox files plus this plan changed

- [x] **Step 6.4: Sub-agent implementation review**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify Phase 4B implements only NAS tombstone client/sync/cursor/outbox suppression and command wiring.
  Confirm it does not implement R2 purge, Worker changes, dashboard UI, local media/XML deletion, OPML, events, Docker/CI, or deployment.

Quality reviewer:
  Review Badger transaction boundaries, cursor advancement safety, outbox race handling, restore behavior,
  NAS client validation/redaction, command loop semantics, and test coverage.
```

Expected: no blocking or important findings. Fix and re-review any blocking or important findings before commit.

- [x] **Step 6.5: Commit Phase 4B**

Run:

```bash
git add pkg/model pkg/db services/remote cmd/podsync docs/superpowers/plans/2026-07-06-nas-tombstone-sync.md
git commit -m "feat: sync remote tombstones on nas"
```

Do not push unless explicitly requested.
