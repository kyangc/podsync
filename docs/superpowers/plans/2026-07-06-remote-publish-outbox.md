# Remote Publish Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Phase 3A local remote-publish outbox so newly downloaded episodes enqueue durable publish tasks when remote mode is enabled, without changing local XML/OPML success semantics.

**Architecture:** Keep the outbox local and DB-backed by adding remote publish task records to the existing Badger database. `services/update.Manager` receives an optional outbox interface; when absent, local-only behavior is unchanged. Download success and already-present media enqueue idempotent publish tasks, but enqueue failures are logged and never fail the local feed update.

**Tech Stack:** Go 1.25, existing Badger database, existing `model.Episode`, existing updater/download flow, standard `time` and `encoding/base64`.

---

## Scope Boundaries

This phase may modify:

- `pkg/model/remote.go`
- `pkg/db/badger.go`
- `pkg/db/remote_outbox.go`
- `pkg/db/remote_outbox_test.go`
- `services/update/updater.go`
- `services/update/updater_test.go`
- `cmd/podsync/main.go`
- `cmd/podsync/remote_publish.go`
- `cmd/podsync/remote_publish_test.go`
- `.gitignore` only if the existing root `db` ignore pattern blocks new `pkg/db` source files; narrow it to `/db`
- `docs/superpowers/plans/2026-07-06-remote-publish-outbox.md`

This phase must not modify:

- `cloudflare/worker/**`
- R2 client/upload code
- Worker `episodes/upsert`
- RSS item rendering from D1 episodes
- tombstone pull/apply
- dashboard mutation
- NAS live config
- GitHub Actions
- Dockerfile

This phase intentionally does not upload files, generate R2 object keys, call Cloudflare APIs, scan historical downloaded episodes, or retry outbox tasks. It only creates durable pending tasks for episodes that pass through the current download success path after the feature is enabled.

Phase 3A records the storage-relative `media_path` and size only; it does not try to open media bytes. Phase 3B must explicitly choose a reader strategy before upload work starts: either restrict remote publish upload to `storage.type = "local"` or add a storage read seam that supports the active backend. Do not silently assume S3-backed media can be read through `fs.Storage.Open`, because the current S3 storage implementation does not support serving/opening files.

---

## Acceptance Criteria

- Local-only config and `remote.enabled=false` do not create or use a remote publish outbox.
- `remote.enabled=true` wires the existing Badger database as the outbox.
- A newly downloaded episode enqueues exactly one pending remote publish task after local storage write and local DB `EpisodeDownloaded` update succeed.
- An episode whose media file already exists and is marked downloaded also enqueues a pending task.
- Existing already-downloaded episodes that are skipped by `fetchEpisodes` are not scanned or enqueued.
- Enqueue failures are logged as warnings and do not fail `Manager.Update`, local XML, or OPML generation.
- Enqueue is idempotent by `feed_id + local_episode_id`; repeated enqueue refreshes media path/size but does not duplicate tasks or reset retry state.
- The task stores enough local information for Phase 3B to upload later: feed id, local episode id, media path, size, title, source URL, published time, status, attempts, next attempt time, timestamps.
- Phase 3A does not validate `storage.type`; it only records media paths. Phase 3B must define local vs S3 upload-read behavior before it reads media bytes.
- The updater only depends on a small `RemotePublishOutbox` interface, not on Badger directly.
- No R2/outbox worker loop/upsert/tombstone behavior is implemented in this phase.

---

### Task 1: Remote Publish Task Model

**Files:**

- Create: `pkg/model/remote.go`
- Test indirectly through `pkg/db/remote_outbox_test.go`

- [ ] **Step 1.1: Add remote task model**

Create `pkg/model/remote.go`:

```go
package model

import (
	"encoding/base64"
	"time"
)

type RemotePublishStatus string

const (
	RemotePublishPending   = RemotePublishStatus("pending")
	RemotePublishSucceeded = RemotePublishStatus("succeeded")
	RemotePublishFailed    = RemotePublishStatus("failed")
)

type RemotePublishTask struct {
	ID             string              `json:"id"`
	FeedID         string              `json:"feed_id"`
	LocalEpisodeID string              `json:"local_episode_id"`
	MediaPath      string              `json:"media_path"`
	Size           int64               `json:"size"`
	Title          string              `json:"title"`
	SourceURL      string              `json:"source_url"`
	PublishedAt    time.Time           `json:"published_at"`
	Status         RemotePublishStatus `json:"status"`
	Attempts       int                 `json:"attempts"`
	NextAttemptAt  time.Time           `json:"next_attempt_at"`
	LastError      string              `json:"last_error"`
	CreatedAt      time.Time           `json:"created_at"`
	UpdatedAt      time.Time           `json:"updated_at"`
}

func RemotePublishTaskID(feedID, localEpisodeID string) string {
	feedPart := base64.RawURLEncoding.EncodeToString([]byte(feedID))
	episodePart := base64.RawURLEncoding.EncodeToString([]byte(localEpisodeID))
	return "publish_episode:" + feedPart + ":" + episodePart
}
```

`RemotePublishFailed` is a local retry status placeholder for Phase 3B. Phase 3A should only create `pending` tasks and preserve any existing status.

- [ ] **Step 1.2: Run model compile check**

Run:

```bash
go test ./pkg/model ./pkg/db
```

Expected: PASS.

---

### Task 2: Badger-Backed Remote Publish Outbox

**Files:**

- Modify: `pkg/db/badger.go`
- Create: `pkg/db/remote_outbox.go`
- Create: `pkg/db/remote_outbox_test.go`

- [ ] **Step 2.1: Add Badger key constants**

In `pkg/db/badger.go`, extend the existing const block:

```go
remotePublishTaskPrefix = "remote/publish/"
remotePublishTaskPath   = "remote/publish/%s"
```

Keep these as internal Badger paths. Do not add them to `db.Storage`; the outbox is an optional capability, not part of every test fake.

- [ ] **Step 2.2: Implement enqueue/get/walk helpers**

Create `pkg/db/remote_outbox.go`:

```go
package db

import (
	"context"
	"time"

	"github.com/dgraph-io/badger"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

func (b *Badger) EnqueueRemotePublishTask(_ context.Context, task *model.RemotePublishTask) error {
	if task.FeedID == "" {
		return errors.New("remote publish task feed_id is required")
	}
	if task.LocalEpisodeID == "" {
		return errors.New("remote publish task local_episode_id is required")
	}
	if task.MediaPath == "" {
		return errors.New("remote publish task media_path is required")
	}

	now := time.Now().UTC()
	task.ID = model.RemotePublishTaskID(task.FeedID, task.LocalEpisodeID)
	if task.Status == "" {
		task.Status = model.RemotePublishPending
	}
	if task.NextAttemptAt.IsZero() {
		task.NextAttemptAt = now
	}
	if task.CreatedAt.IsZero() {
		task.CreatedAt = now
	}
	task.UpdatedAt = now

	key := b.getKey(remotePublishTaskPath, task.ID)
	return b.db.Update(func(txn *badger.Txn) error {
		var existing model.RemotePublishTask
		err := b.getObj(txn, key, &existing)
		switch err {
		case nil:
			existing.MediaPath = task.MediaPath
			existing.Size = task.Size
			existing.Title = task.Title
			existing.SourceURL = task.SourceURL
			existing.PublishedAt = task.PublishedAt
			existing.UpdatedAt = now
			return b.setObj(txn, key, &existing, true)
		case model.ErrNotFound:
			return b.setObj(txn, key, task, false)
		default:
			return err
		}
	})
}

func (b *Badger) GetRemotePublishTask(_ context.Context, id string) (*model.RemotePublishTask, error) {
	var task model.RemotePublishTask
	err := b.db.View(func(txn *badger.Txn) error {
		return b.getObj(txn, b.getKey(remotePublishTaskPath, id), &task)
	})
	return &task, err
}

func (b *Badger) WalkRemotePublishTasks(_ context.Context, status model.RemotePublishStatus, cb func(*model.RemotePublishTask) error) error {
	return b.db.View(func(txn *badger.Txn) error {
		opts := badger.DefaultIteratorOptions
		opts.Prefix = b.getKey(remotePublishTaskPrefix)
		opts.PrefetchValues = true
		return b.iterator(txn, opts, func(item *badger.Item) error {
			task := &model.RemotePublishTask{}
			if err := b.unmarshalObj(item, task); err != nil {
				return err
			}
			if status != "" && task.Status != status {
				return nil
			}
			return cb(task)
		})
	})
}
```

The idempotent update intentionally preserves `Status`, `Attempts`, `NextAttemptAt`, `LastError`, and any future R2 fields instead of resetting retry state.

- [ ] **Step 2.3: Add Badger outbox tests**

Create `pkg/db/remote_outbox_test.go` with these tests:

```go
func TestBadger_EnqueueRemotePublishTaskCreatesPendingTask(t *testing.T)
func TestBadger_EnqueueRemotePublishTaskIsIdempotent(t *testing.T)
func TestRemotePublishTaskIDEscapesDelimiters(t *testing.T)
func TestBadger_WalkRemotePublishTasksFiltersByStatus(t *testing.T)
func TestBadger_EnqueueRemotePublishTaskValidatesRequiredFields(t *testing.T)
```

Use this helper shape:

```go
func newRemotePublishTask(feedID, episodeID string) *model.RemotePublishTask {
	return &model.RemotePublishTask{
		FeedID:         feedID,
		LocalEpisodeID: episodeID,
		MediaPath:      feedID + "/" + episodeID + ".mp3",
		Size:           123,
		Title:          "Episode " + episodeID,
		SourceURL:      "https://example.com/" + episodeID,
		PublishedAt:    time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC),
	}
}
```

Required assertions:

- created task has `ID == model.RemotePublishTaskID(feedID, episodeID)`.
- created task has `Status == model.RemotePublishPending`.
- created task has non-zero `CreatedAt`, `UpdatedAt`, and `NextAttemptAt`.
- repeated enqueue with the same feed/episode changes `MediaPath` and `Size`.
- repeated enqueue preserves an existing `Status`, `Attempts`, `NextAttemptAt`, and `LastError`.
- `RemotePublishTaskID("feed/with:delimiters", "episode/with:delimiters")` returns a deterministic string with exactly two `:` delimiters after the `publish_episode` prefix.
- walk with `model.RemotePublishPending` returns only pending tasks.
- missing `FeedID`, `LocalEpisodeID`, or `MediaPath` returns an error containing that field name.

- [ ] **Step 2.4: Run DB tests**

Run:

```bash
go test ./pkg/db -run 'TestBadger_EnqueueRemotePublishTask|TestBadger_WalkRemotePublishTasks|TestRemotePublishTaskID'
```

Expected: PASS.

---

### Task 3: Updater Enqueue Hook

**Files:**

- Modify: `services/update/updater.go`
- Modify: `services/update/updater_test.go`

- [ ] **Step 3.1: Add optional outbox interface and updater option**

In `services/update/updater.go`, add:

```go
type RemotePublishOutbox interface {
	EnqueueRemotePublishTask(ctx context.Context, task *model.RemotePublishTask) error
}

type Option func(*Manager)

func WithRemotePublishOutbox(outbox RemotePublishOutbox) Option {
	return func(u *Manager) {
		u.remotePublishOutbox = outbox
	}
}
```

Add `remotePublishOutbox RemotePublishOutbox` to `Manager`.

Change `NewUpdater` signature to:

```go
func NewUpdater(
	feeds map[string]*feed.Config,
	keys map[model.Provider]feed.KeyProvider,
	hostname string,
	downloader Downloader,
	db db.Storage,
	fs fs.Storage,
	options ...Option,
) (*Manager, error) {
	manager := &Manager{
		hostname:   hostname,
		downloader: downloader,
		db:         db,
		fs:         fs,
		feeds:      feeds,
		keys:       keys,
	}
	for _, option := range options {
		option(manager)
	}
	return manager, nil
}
```

Existing callers without options must continue compiling.

- [ ] **Step 3.2: Add enqueue helper**

Add this helper in `services/update/updater.go`:

```go
func (u *Manager) enqueueRemotePublishTask(ctx context.Context, feedConfig *feed.Config, episode *model.Episode, mediaPath string, size int64) error {
	if u.remotePublishOutbox == nil {
		return nil
	}
	return u.remotePublishOutbox.EnqueueRemotePublishTask(ctx, &model.RemotePublishTask{
		FeedID:         feedConfig.ID,
		LocalEpisodeID: episode.ID,
		MediaPath:      mediaPath,
		Size:           size,
		Title:          episode.Title,
		SourceURL:      episode.VideoURL,
		PublishedAt:    episode.PubDate,
	})
}
```

This helper is intentionally small. Phase 3B will consume tasks and generate/upload R2 objects.

- [ ] **Step 3.3: Enqueue after already-existing media is marked downloaded**

In `downloadEpisodes`, inside the `if err == nil` branch where storage already has the media:

```go
mediaPath := fmt.Sprintf("%s/%s", feedID, episodeName)
size, err := u.fs.Size(ctx, mediaPath)
```

After `UpdateEpisode` succeeds:

```go
if err := u.enqueueRemotePublishTask(ctx, feedConfig, episode, mediaPath, size); err != nil {
	logger.WithError(err).Warn("failed to enqueue remote publish task")
}
```

Do not return this error.

- [ ] **Step 3.4: Enqueue after newly downloaded media is marked downloaded**

In the successful download branch, use a single `mediaPath` variable:

```go
mediaPath := fmt.Sprintf("%s/%s", feedID, episodeName)
fileSize, err := u.fs.Create(ctx, mediaPath, tempFile)
```

After `UpdateEpisode` sets `Size` and `EpisodeDownloaded`:

```go
if err := u.enqueueRemotePublishTask(ctx, feedConfig, episode, mediaPath, fileSize); err != nil {
	logger.WithError(err).Warn("failed to enqueue remote publish task")
}
```

Do not enqueue before the local DB says the episode is downloaded.

- [ ] **Step 3.5: Add updater hook tests**

In `services/update/updater_test.go`, add small test doubles:

```go
type recordingRemoteOutbox struct {
	tasks []*model.RemotePublishTask
	err   error
	calls int
}

func (r *recordingRemoteOutbox) EnqueueRemotePublishTask(_ context.Context, task *model.RemotePublishTask) error {
	r.calls++
	if r.err != nil {
		return r.err
	}
	r.tasks = append(r.tasks, task)
	return nil
}
```

Add unit tests for the helper:

```go
func TestEnqueueRemotePublishTaskNoopsWithoutOutbox(t *testing.T)
func TestEnqueueRemotePublishTaskRecordsEpisodeMetadata(t *testing.T)
func TestEnqueueRemotePublishTaskReturnsOutboxError(t *testing.T)
```

Required assertions:

- nil outbox returns nil.
- recorded task includes feed id, episode id, media path, size, title, source URL, and pub date.
- returned outbox error is preserved by the helper.

Add focused `downloadEpisodes` tests for the real hook points. These tests should use minimal fakes inside `services/update/updater_test.go`, not a full provider/build/update integration:

```go
type hookDB struct {
	updated bool
	fail    error
}

func (h *hookDB) UpdateEpisode(feedID string, episodeID string, cb func(*model.Episode) error) error {
	if h.fail != nil {
		return h.fail
	}
	episode := &model.Episode{ID: episodeID}
	if err := cb(episode); err != nil {
		return err
	}
	h.updated = episode.Status == model.EpisodeDownloaded
	return nil
}
```

`hookDB` must implement the remaining `db.Storage` methods with small stubs returning `errors.New("not implemented")`, because `downloadEpisodes` only needs `UpdateEpisode` in these tests.

```go
type hookFS struct {
	existingSize int64
	createdPath  string
}

func (h *hookFS) Size(_ context.Context, name string) (int64, error) {
	if h.existingSize > 0 {
		return h.existingSize, nil
	}
	return 0, os.ErrNotExist
}

func (h *hookFS) Create(_ context.Context, name string, reader io.Reader) (int64, error) {
	h.createdPath = name
	written, err := io.Copy(io.Discard, reader)
	return written, err
}
```

`hookFS` must implement `Open` and `Delete` with small stubs to satisfy `fs.Storage`.

```go
type hookDownloader struct {
	body string
}

func (h hookDownloader) Download(context.Context, *feed.Config, *model.Episode) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader(h.body)), nil
}

func (h hookDownloader) PlaylistMetadata(context.Context, string) (ytdl.PlaylistMetadata, error) {
	return ytdl.PlaylistMetadata{}, nil
}
```

Add:

```go
func TestDownloadEpisodesEnqueuesAfterExistingMediaMarkedDownloaded(t *testing.T)
func TestDownloadEpisodesEnqueuesAfterNewDownloadMarkedDownloaded(t *testing.T)
func TestDownloadEpisodesIgnoresRemotePublishEnqueueError(t *testing.T)
func TestDownloadEpisodesDoesNotEnqueueWhenLocalUpdateFails(t *testing.T)
```

Required assertions:

- existing-media branch calls `EnqueueRemotePublishTask` once with `MediaPath == "<feed_id>/<episode_name>"` and the existing size.
- new-download branch calls `EnqueueRemotePublishTask` once with `MediaPath == "<feed_id>/<episode_name>"` and the bytes written by `fs.Create`.
- fake outbox may assert `hookDB.updated == true` inside `EnqueueRemotePublishTask`, proving enqueue happens after the local DB marks the episode downloaded.
- enqueue error returns nil from `downloadEpisodes`.
- local `UpdateEpisode` failure returns an error and does not enqueue.

Do not build a full provider/update/XML/OPML integration test in this phase; these branch-level tests plus helper and Badger tests prove the new hook without over-coupling to provider internals.

- [ ] **Step 3.6: Run updater tests**

Run:

```bash
go test ./services/update -run 'TestEnqueueRemotePublishTask|TestDownloadEpisodes|TestProviderKey|TestSetFeeds|TestFeedSnapshot|TestFeedReturnsCurrentFeed'
```

Expected: PASS.

---

### Task 4: Wire Outbox In Main Only When Remote Is Enabled

**Files:**

- Modify: `cmd/podsync/main.go`
- Test: `cmd/podsync/remote_publish_test.go`

- [ ] **Step 4.1: Add testable update option helper**

Create `cmd/podsync/remote_publish.go`:

```go
package main

import "github.com/mxpv/podsync/services/update"

func remotePublishOptions(cfg *Config, outbox update.RemotePublishOutbox) []update.Option {
	if !cfg.Remote.Enabled {
		return nil
	}
	return []update.Option{update.WithRemotePublishOutbox(outbox)}
}
```

This seam only decides whether the updater receives an outbox option. It must not initialize R2, start a worker, or inspect feed contents.

- [ ] **Step 4.2: Pass Badger as outbox in remote mode**

In `cmd/podsync/main.go`, before `update.NewUpdater`:

```go
updateOptions := remotePublishOptions(cfg, database)
```

Then change updater construction:

```go
manager, err := update.NewUpdater(activeFeeds, keys, cfg.Server.Hostname, downloader, database, storage, updateOptions...)
```

This keeps local-only and `remote.enabled=false` behavior unchanged.

- [ ] **Step 4.3: Add remote publish option tests**

Create `cmd/podsync/remote_publish_test.go`:

```go
func TestRemotePublishOptionsDisabledWhenRemoteOff(t *testing.T) {
	options := remotePublishOptions(&Config{}, nil)
	require.Empty(t, options)
}

func TestRemotePublishOptionsEnabledWhenRemoteOn(t *testing.T) {
	options := remotePublishOptions(&Config{Remote: RemoteConfig{Enabled: true}}, nil)
	require.Len(t, options, 1)
}
```

The disabled test is the explicit Phase 0/3A guard that local-only and `remote.enabled=false` do not wire an outbox.

- [ ] **Step 4.4: Run main package tests**

Run:

```bash
go test ./cmd/podsync ./services/update ./pkg/db
```

Expected: PASS.

---

### Task 5: Phase 3A Quality Gate And Commit

**Files:**

- All files touched in Tasks 1-4

- [ ] **Step 5.1: Run full Go gate**

Run:

```bash
go test ./...
go test -race ./services/update ./pkg/db ./cmd/podsync
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS.

- [ ] **Step 5.2: Worker regression scope check**

Because Phase 3A must not touch Worker code, run:

```bash
git diff -- cloudflare/worker
```

Expected: no output.

If Worker files are accidentally changed, revert those Phase 3A changes before review.

- [ ] **Step 5.3: Diff scope review**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- Only Go model/db/update/main files, this plan file, and the `.gitignore` root `/db` narrowing if needed changed.
- No `cloudflare/worker/**`, Dockerfile, GitHub Actions, or NAS live config changes.
- No R2 client, Worker upsert, tombstone, or dashboard implementation.

- [ ] **Step 5.4: Sub-agent implementation review**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify Phase 3A from docs/remote-control-plane.md is implemented and no Phase 3B/3C work leaked in:
  DB-backed outbox, enqueue only after local media success, no historical scan,
  remote disabled no-op, enqueue failure does not fail local update, idempotent by feed_id + local_episode_id.

Quality reviewer:
  Review Badger key/id design, idempotency preserving retry fields, optional updater interface,
  local update error isolation, tests, race safety, and scope discipline.
```

Expected: no blocking or important findings. Fix and re-review any blocking or important findings before commit.

- [ ] **Step 5.5: Commit Phase 3A**

Commit after all gates and reviews pass:

```bash
git add pkg/model pkg/db services/update cmd/podsync docs/superpowers/plans/2026-07-06-remote-publish-outbox.md
git commit -m "feat: enqueue remote publish tasks"
```

Do not push unless explicitly requested.
