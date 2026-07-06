# R2 Publisher Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 3B R2 publishing for queued remote publish tasks: upload local media to R2 with Put/Head verification and update the local outbox retry state, without calling Cloudflare episode upsert yet.

**Architecture:** Keep R2 publishing independent from the existing `pkg/fs.Storage` write path. A new `services/remote` package reads storage-relative media files from local storage only, builds stable R2 object keys, uploads with an R2 S3 API client using PutObject/HeadObject, and advances Badger outbox task state. `cmd/podsync` starts a small serial polling worker only when remote mode is enabled, R2 config is complete, and local storage is active.

**Tech Stack:** Go 1.25, existing Badger DB, existing AWS SDK v1 S3 client, existing `github.com/gabriel-vasile/mimetype`, standard `crypto/rand`, standard `os` file reading.

---

## Scope Boundaries

This phase may modify:

- `pkg/model/remote.go`
- `pkg/db/remote_outbox.go`
- `pkg/db/remote_outbox_test.go`
- `services/remote/r2_key.go`
- `services/remote/r2_key_test.go`
- `services/remote/media_store.go`
- `services/remote/media_store_test.go`
- `services/remote/publisher.go`
- `services/remote/publisher_test.go`
- `services/remote/processor.go`
- `services/remote/processor_test.go`
- `cmd/podsync/remote_publish.go`
- `cmd/podsync/remote_publish_test.go`
- `cmd/podsync/main.go`
- `docs/superpowers/plans/2026-07-06-r2-publisher-retry.md`

This phase must not modify:

- `cloudflare/worker/**`
- Worker `episodes/upsert`
- Worker RSS item rendering
- dashboard mutation
- tombstone pull/apply
- NAS live config
- GitHub Actions
- Dockerfile

This phase intentionally does not call Cloudflare NAS APIs, does not expose R2 URLs, does not render remote RSS items, and does not delete R2 objects. Phase 3C will use successfully uploaded tasks to upsert episode metadata and make Worker RSS show items.

---

## Acceptance Criteria

- Remote disabled or incomplete R2 config does not start the R2 publish worker.
- R2 publish worker starts only for `remote.enabled=true`, complete `[r2]`, and `storage.type="local"`.
- R2 publisher is independent from `pkg/fs.Storage`; it uses the local storage root to open media by `RemotePublishTask.MediaPath`.
- Local media path opening rejects absolute paths and `..` traversal.
- R2 object key uses configured `r2.prefix` or default `audio`, plus sanitized feed/episode path segments and a persisted asset token.
- Asset token and R2 key are generated once and persisted before upload; retries reuse the same key.
- Upload uses PutObject then HeadObject, and HeadObject `ContentLength` must equal the task size.
- MIME type is detected from local media bytes and persisted as `MimeType`.
- Tasks are processed serially; one task failure does not stop later due tasks.
- Retryable R2 failures keep the task retryable, increment attempts, preserve the R2 key, record last error, and set next attempt using: attempts 1-3 immediate, attempt 4 = 1h, then 2h/4h/8h/16h/24h max.
- Missing local media is marked terminal `failed` and will not be selected as due again.
- Successful upload marks the task `succeeded` with `CompletedAt`, `R2Key`, `AssetToken`, and `MimeType`.
- No Cloudflare episode upsert, Worker RSS rendering, tombstone, dashboard, Docker, CI, or NAS config changes are implemented.

---

### Task 1: Outbox Asset Fields And Retry State

**Files:**

- Modify: `pkg/model/remote.go`
- Modify: `pkg/db/remote_outbox.go`
- Modify: `pkg/db/remote_outbox_test.go`

- [ ] **Step 1.1: Extend remote publish task model**

Add fields to `pkg/model/remote.go`:

```go
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
	R2Key          string              `json:"r2_key"`
	AssetToken     string              `json:"asset_token"`
	MimeType       string              `json:"mime_type"`
	CompletedAt    time.Time           `json:"completed_at"`
	CreatedAt      time.Time           `json:"created_at"`
	UpdatedAt      time.Time           `json:"updated_at"`
}
```

Keep existing statuses:

- `pending`: queued or retryable.
- `succeeded`: uploaded and verified in R2.
- `failed`: terminal local failure, such as missing media.

- [ ] **Step 1.2: Add retry backoff helper**

Add to `pkg/model/remote.go`:

```go
func RemotePublishNextAttempt(now time.Time, attempts int) time.Time {
	if attempts <= 3 {
		return now
	}
	if attempts >= 9 {
		return now.Add(24 * time.Hour)
	}
	hours := 1 << (attempts - 4)
	return now.Add(time.Duration(hours) * time.Hour)
}
```

The helper caps before shifting, so very high attempt counts cannot overflow and always stay at 24h.

- [ ] **Step 1.3: Add outbox transition methods**

In `pkg/db/remote_outbox.go`, add:

```go
func (b *Badger) DueRemotePublishTasks(_ context.Context, now time.Time, limit int) ([]*model.RemotePublishTask, error)
func (b *Badger) PrepareRemotePublishAttempt(_ context.Context, id string, r2Key string, assetToken string, mimeType string, now time.Time) (*model.RemotePublishTask, error)
func (b *Badger) CompleteRemotePublishTask(_ context.Context, id string, now time.Time) error
func (b *Badger) RetryRemotePublishTask(_ context.Context, id string, cause error, now time.Time) error
func (b *Badger) DeferRemotePublishTask(_ context.Context, id string, cause error, now time.Time) error
func (b *Badger) FailRemotePublishTask(_ context.Context, id string, cause error, now time.Time) error
```

Semantics:

- `EnqueueRemotePublishTask` keeps its existing idempotent behavior for existing tasks: refresh `MediaPath`, `Size`, `Title`, `SourceURL`, `PublishedAt`, and `UpdatedAt`, but preserve `Status`, `Attempts`, `NextAttemptAt`, `LastError`, `R2Key`, `AssetToken`, `MimeType`, and `CompletedAt`. Phase 3B does not attempt to detect or republish a same-ID episode whose local media was regenerated after a successful remote upload.
- `DueRemotePublishTasks` returns only `Status == pending` and `NextAttemptAt.IsZero() || !NextAttemptAt.After(now)`. If `limit <= 0`, use `1`. Collect into a slice inside the Badger read transaction and return after the transaction closes.
- `PrepareRemotePublishAttempt` must only operate on pending tasks. It sets `R2Key`, `AssetToken`, `MimeType`, increments `Attempts`, clears `LastError`, sets `UpdatedAt`, and returns the updated task. If the task is not pending, return `model.ErrNotFound` or a clear error and do not upload.
- `CompleteRemotePublishTask` sets `Status=succeeded`, clears `LastError`, sets `CompletedAt` and `UpdatedAt`.
- `RetryRemotePublishTask` keeps `Status=pending`, stores `LastError`, sets `NextAttemptAt = model.RemotePublishNextAttempt(now, task.Attempts)`, and updates `UpdatedAt`. It must not clear `R2Key`, `AssetToken`, or `MimeType`.
- `DeferRemotePublishTask` is for retryable pre-upload errors before `PrepareRemotePublishAttempt`; it must only operate on pending tasks, increment `Attempts`, store `LastError`, set `NextAttemptAt = model.RemotePublishNextAttempt(now, task.Attempts)`, update `UpdatedAt`, and not create `R2Key`, `AssetToken`, or `MimeType`.
- `FailRemotePublishTask` sets `Status=failed`, stores `LastError`, clears `NextAttemptAt`, and updates `UpdatedAt`.

- [ ] **Step 1.4: Add DB retry state tests**

Add tests to `pkg/db/remote_outbox_test.go`:

```go
func TestBadger_DueRemotePublishTasksReturnsPendingDueTasks(t *testing.T)
func TestBadger_PrepareRemotePublishAttemptPersistsAssetAndIncrementsAttempts(t *testing.T)
func TestBadger_PrepareRemotePublishAttemptRejectsNonPendingTask(t *testing.T)
func TestBadger_RetryRemotePublishTaskSchedulesBackoff(t *testing.T)
func TestBadger_DeferRemotePublishTaskRecordsBackoff(t *testing.T)
func TestBadger_FailRemotePublishTaskMarksTerminalFailure(t *testing.T)
func TestBadger_CompleteRemotePublishTaskMarksSucceeded(t *testing.T)
func TestBadger_EnqueueRemotePublishTaskPreservesRemoteAssetState(t *testing.T)
func TestRemotePublishNextAttempt(t *testing.T)
```

Required assertions:

- due query excludes succeeded, failed, and future `NextAttemptAt`.
- due query respects limit.
- prepare increments attempts from 0 to 1 and persists `R2Key`, `AssetToken`, `MimeType`.
- retry after attempts 1-3 returns immediate `NextAttemptAt == now`; attempts 4, 5, 6, 7, 8, and 9+ return `now + 1h`, `2h`, `4h`, `8h`, `16h`, and capped `24h`; a very high attempt count such as 100 also stays capped at `24h`.
- defer increments attempts, records `LastError`, schedules backoff using the incremented attempt count, and does not create remote asset fields.
- fail terminal changes status to failed and future due query does not return it.
- complete changes status to succeeded and sets `CompletedAt`.
- re-enqueue of an existing pending or succeeded task refreshes local metadata but preserves remote asset fields and status.

- [ ] **Step 1.5: Run DB tests**

Run:

```bash
go test ./pkg/model ./pkg/db -run 'TestBadger_DueRemotePublishTasks|TestBadger_PrepareRemotePublishAttempt|TestBadger_RetryRemotePublishTask|TestBadger_DeferRemotePublishTask|TestBadger_FailRemotePublishTask|TestBadger_CompleteRemotePublishTask|TestBadger_EnqueueRemotePublishTaskPreservesRemoteAssetState|TestRemotePublishNextAttempt'
```

Expected: PASS.

---

### Task 2: R2 Key And Local Media Reader

**Files:**

- Create: `services/remote/r2_key.go`
- Create: `services/remote/r2_key_test.go`
- Create: `services/remote/media_store.go`
- Create: `services/remote/media_store_test.go`

- [ ] **Step 2.1: Add R2 key builder**

Create `services/remote/r2_key.go`:

```go
package remote

import (
	"crypto/rand"
	"encoding/base32"
	"path"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/mxpv/podsync/pkg/model"
)

const defaultR2Prefix = "audio"

func NewAssetToken() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf[:]))
}

func BuildR2Key(prefix string, task *model.RemotePublishTask, assetToken string) string {
	cleanPrefix := sanitizeR2Prefix(prefix)
	if cleanPrefix == "" {
		cleanPrefix = defaultR2Prefix
	}
	feedID := sanitizeR2Segment(task.FeedID)
	if feedID == "" {
		feedID = "feed"
	}
	episodeID := sanitizeR2Segment(task.LocalEpisodeID)
	if episodeID == "" {
		episodeID = "episode"
	}
	ext := strings.ToLower(filepath.Ext(task.MediaPath))
	if ext == "" {
		ext = ".bin"
	}
	return cleanPrefix + "/" + feedID + "/" + episodeID + "-" + assetToken + ext
}

func sanitizeR2Prefix(value string) string {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, "/")
	cleanParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if clean := sanitizeR2Segment(part); clean != "" {
			cleanParts = append(cleanParts, clean)
		}
	}
	return path.Join(cleanParts...)
}

func sanitizeR2Segment(value string) string {
	value = strings.TrimSpace(value)
	var b strings.Builder
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('_')
	}
	return strings.Trim(b.String(), "._-")
}
```

This keeps object keys readable while preventing accidental path separators in feed/episode segments. The configured prefix may contain path separators, but each prefix segment is sanitized independently.

- [ ] **Step 2.2: Add local media store**

Create `services/remote/media_store.go`:

```go
package remote

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type ReadSeekCloser interface {
	io.Reader
	io.Seeker
	io.Closer
}

var ErrUnsafeMediaPath = errors.New("media path escapes local storage root")

type LocalMediaStore struct {
	Root string
}

func (s LocalMediaStore) Open(name string) (ReadSeekCloser, error) {
	clean := filepath.Clean(name)
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return nil, ErrUnsafeMediaPath
	}
	return os.Open(filepath.Join(s.Root, clean))
}
```

Phase 3B supports local storage only. Do not call `fs.Storage.Open`, and do not try to make S3-backed media readable here.

- [ ] **Step 2.3: Add key/media tests**

Add tests:

```go
func TestBuildR2KeyUsesPrefixAndSanitizedSegments(t *testing.T)
func TestBuildR2KeyDefaultsPrefixAndExtension(t *testing.T)
func TestBuildR2KeyDoesNotMutateEpisodeIdentity(t *testing.T)
func TestBuildR2KeyFallsBackEmptySegments(t *testing.T)
func TestNewAssetTokenReturnsURLSafeToken(t *testing.T)
func TestLocalMediaStoreOpenReadsRelativeFile(t *testing.T)
func TestLocalMediaStoreRejectsEscapingPath(t *testing.T)
```

Required assertions:

- `BuildR2Key("audio", feedID="feed/one", episodeID="BV:1", token="abc", mediaPath="feed/ep.mp3")` returns `audio/feed_one/BV_1-abc.mp3`.
- `BuildR2Key("podcasts/audio", ...)` keeps the prefix as `podcasts/audio/...` while still sanitizing each prefix segment.
- when `LocalEpisodeID` contains path separators or punctuation, only the R2 key segment is sanitized; `task.LocalEpisodeID` remains unchanged for future tombstone/upsert identity.
- if sanitized feed or episode segments are empty, the key falls back to `feed` or `episode` rather than producing empty path segments.
- empty prefix becomes `audio`.
- extensionless media path becomes `.bin`.
- token contains only lower-case base32 characters and has non-zero length.
- local reader rejects `/abs`, `../x`, and `a/../../x`.

- [ ] **Step 2.4: Run service tests**

Run:

```bash
go test ./services/remote -run 'TestBuildR2Key|TestNewAssetToken|TestLocalMediaStore'
```

Expected: PASS.

---

### Task 3: R2 Put/Head Publisher

**Files:**

- Create: `services/remote/publisher.go`
- Create: `services/remote/publisher_test.go`

- [ ] **Step 3.1: Add R2 publisher**

Create `services/remote/publisher.go`:

```go
package remote

import (
	"context"
	"io"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/credentials"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/aws/aws-sdk-go/service/s3/s3iface"
	"github.com/gabriel-vasile/mimetype"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

type R2Config struct {
	Endpoint        string
	Bucket          string
	Prefix          string
	AccessKeyID     string
	SecretAccessKey string
}

type R2Publisher struct {
	api    s3iface.S3API
	bucket string
}

func NewR2Publisher(cfg R2Config) (*R2Publisher, error) {
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, errors.New("r2 endpoint, bucket, access key id, and secret access key are required")
	}
	awsCfg := aws.NewConfig().
		WithEndpoint(cfg.Endpoint).
		WithRegion("auto").
		WithS3ForcePathStyle(true).
		WithCredentials(credentials.NewStaticCredentials(cfg.AccessKeyID, cfg.SecretAccessKey, ""))
	sess, err := session.NewSession(awsCfg)
	if err != nil {
		return nil, err
	}
	return &R2Publisher{api: s3.New(sess), bucket: cfg.Bucket}, nil
}

func NewR2PublisherWithAPI(api s3iface.S3API, bucket string) *R2Publisher {
	return &R2Publisher{api: api, bucket: bucket}
}

func DetectMimeType(reader io.ReadSeeker) (string, error) {
	var buf [512]byte
	n, err := reader.Read(buf[:])
	if err != nil && err != io.EOF {
		return "", err
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return mimetype.Detect(buf[:n]).String(), nil
}

func (p *R2Publisher) Upload(ctx context.Context, task *model.RemotePublishTask, reader io.ReadSeeker) error {
	if task.R2Key == "" {
		return errors.New("remote publish task r2_key is required")
	}
	if task.MimeType == "" {
		return errors.New("remote publish task mime_type is required")
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, err := p.api.PutObjectWithContext(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(p.bucket),
		Key:           aws.String(task.R2Key),
		Body:          reader,
		ContentLength: aws.Int64(task.Size),
		ContentType:   aws.String(task.MimeType),
	})
	if err != nil {
		return err
	}
	head, err := p.api.HeadObjectWithContext(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(task.R2Key),
	})
	if err != nil {
		return err
	}
	if head.ContentLength == nil || *head.ContentLength != task.Size {
		return errors.Errorf("r2 object size mismatch: got %d want %d", aws.Int64Value(head.ContentLength), task.Size)
	}
	return nil
}
```

Use PutObject and HeadObject only. Do not use the existing `pkg/fs.S3` storage wrapper or `s3manager`.

- [ ] **Step 3.2: Add publisher tests**

Create `services/remote/publisher_test.go` with a tiny mock `s3iface.S3API`:

```go
type mockR2API struct {
	s3iface.S3API
	objects map[string]mockObject
	failPut bool
	headSize *int64
}
```

Tests:

```go
func TestDetectMimeTypeResetsReader(t *testing.T)
func TestR2PublisherUploadPutsAndHeadsObject(t *testing.T)
func TestR2PublisherUploadRejectsSizeMismatch(t *testing.T)
func TestR2PublisherUploadRequiresKeyAndMimeType(t *testing.T)
func TestNewR2PublisherRequiresConfig(t *testing.T)
```

Required assertions:

- uploaded object key, content type, content length, and body bytes match the task/file.
- upload performs HeadObject after PutObject.
- size mismatch returns an error containing `size mismatch`.
- missing key or MIME returns an error before PutObject.
- `DetectMimeType` leaves reader seek position at 0.

- [ ] **Step 3.3: Run publisher tests**

Run:

```bash
go test ./services/remote -run 'TestDetectMimeType|TestR2Publisher|TestNewR2Publisher'
```

Expected: PASS.

---

### Task 4: Serial Processor And Main Wiring

**Files:**

- Create: `services/remote/processor.go`
- Create: `services/remote/processor_test.go`
- Modify: `cmd/podsync/remote_publish.go`
- Modify: `cmd/podsync/remote_publish_test.go`
- Modify: `cmd/podsync/main.go`

- [ ] **Step 4.1: Add processor**

Create `services/remote/processor.go`:

```go
package remote

import (
	"context"
	"errors"
	"io"
	"os"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/model"
)

type Outbox interface {
	DueRemotePublishTasks(ctx context.Context, now time.Time, limit int) ([]*model.RemotePublishTask, error)
	PrepareRemotePublishAttempt(ctx context.Context, id string, r2Key string, assetToken string, mimeType string, now time.Time) (*model.RemotePublishTask, error)
	CompleteRemotePublishTask(ctx context.Context, id string, now time.Time) error
	RetryRemotePublishTask(ctx context.Context, id string, cause error, now time.Time) error
	DeferRemotePublishTask(ctx context.Context, id string, cause error, now time.Time) error
	FailRemotePublishTask(ctx context.Context, id string, cause error, now time.Time) error
}

type Publisher interface {
	Upload(ctx context.Context, task *model.RemotePublishTask, reader io.ReadSeeker) error
}

type MediaStore interface {
	Open(name string) (ReadSeekCloser, error)
}

type Processor struct {
	Outbox    Outbox
	Publisher Publisher
	Store     MediaStore
	Prefix    string
	Limit     int
	Now       func() time.Time
}
```

Add:

```go
func (p *Processor) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now().UTC()
}

func (p *Processor) ProcessDue(ctx context.Context) error {
	now := p.now()
	limit := p.Limit
	if limit <= 0 {
		limit = 1
	}
	tasks, err := p.Outbox.DueRemotePublishTasks(ctx, now, limit)
	if err != nil {
		return err
	}
	for _, task := range tasks {
		if err := p.processOne(ctx, task, now); err != nil {
			log.WithError(err).WithField("task_id", task.ID).Warn("remote publish task failed")
		}
	}
	return nil
}
```

`processOne` semantics:

- Open media by `task.MediaPath`. If `errors.Is(err, os.ErrNotExist)` or `errors.Is(err, ErrUnsafeMediaPath)`, call `FailRemotePublishTask` and continue. These are terminal local task errors.
- Generate `assetToken` only when task has none.
- Build `r2Key` only when task has none.
- Detect MIME type from file.
- Other pre-upload local I/O, token generation, or MIME detection errors call `DeferRemotePublishTask` to record `LastError`, increment attempts, and keep the task pending for a later polling cycle without creating remote asset state.
- Call `PrepareRemotePublishAttempt` before upload and use its returned task for upload.
- On upload error, call `RetryRemotePublishTask`.
- On upload success, call `CompleteRemotePublishTask`.
- Always close the local file.

Do not return per-task errors from `ProcessDue`; log them and continue to the next due task. Return only due-query errors.

- [ ] **Step 4.2: Add processor tests**

Create `services/remote/processor_test.go` with fake outbox, publisher, and a temp local media store.

Tests:

```go
func TestProcessorUploadsDueTaskAndMarksSucceeded(t *testing.T)
func TestProcessorRetriesUploadFailure(t *testing.T)
func TestProcessorMarksMissingMediaAsFailed(t *testing.T)
func TestProcessorMarksUnsafeMediaPathAsFailed(t *testing.T)
func TestProcessorRecordsOpenErrorAsRetryable(t *testing.T)
func TestProcessorRecordsMimeDetectionErrorAsRetryable(t *testing.T)
func TestProcessorRecordsPreUploadErrorInBadger(t *testing.T)
func TestProcessorContinuesAfterTaskFailure(t *testing.T)
func TestProcessorReusesPersistedR2Key(t *testing.T)
func TestProcessorWithBadgerLocalStoreAndMockPublisher(t *testing.T)
```

Required assertions:

- success path calls prepare once, upload once, complete once.
- prepared task has non-empty `R2Key`, `AssetToken`, and `MimeType`.
- upload failure calls retry and does not complete.
- missing media calls terminal fail and does not upload.
- absolute and traversal media paths call terminal fail and do not upload.
- non-terminal local open errors and MIME detection errors call defer and do not upload.
- real Badger integration verifies a pre-upload error persists pending status, incremented attempts, `LastError`, and `NextAttemptAt`.
- if first task upload fails, second task still uploads.
- if task already has `R2Key` and `AssetToken`, processor reuses them.
- integration-style test enqueues one task in real Badger, reads a temp local media file, uses a mock publisher, runs `ProcessDue`, and verifies the persisted task is `succeeded` with asset fields set.

- [ ] **Step 4.3: Add cmd wiring helper**

Modify `cmd/podsync/remote_publish.go`:

Import the new service package with an explicit alias:

```go
import remotepublish "github.com/mxpv/podsync/services/remote"
```

```go
const defaultRemotePublishInterval = 5 * time.Minute
const defaultRemotePublishBatchSize = 10

type remotePublishProcessor interface {
	ProcessDue(ctx context.Context) error
}

type remotePublisherFactory func(remotepublish.R2Config) (remotepublish.Publisher, error)

func remotePublishEnabled(cfg *Config) bool {
	return cfg.Remote.Enabled &&
		cfg.Storage.Type == "local" &&
		cfg.R2.Endpoint != "" &&
		cfg.R2.Bucket != "" &&
		cfg.R2.AccessKeyID != "" &&
		cfg.R2.SecretAccessKey != ""
}

func remoteR2Config(cfg *Config) remotepublish.R2Config {
	return remotepublish.R2Config{
		Endpoint:        cfg.R2.Endpoint,
		Bucket:          cfg.R2.Bucket,
		Prefix:          cfg.R2.Prefix,
		AccessKeyID:     cfg.R2.AccessKeyID,
		SecretAccessKey: cfg.R2.SecretAccessKey,
	}
}

func newRemoteR2Publisher(cfg remotepublish.R2Config) (remotepublish.Publisher, error) {
	return remotepublish.NewR2Publisher(cfg)
}

func buildRemoteProcessor(cfg *Config, outbox remotepublish.Outbox, newPublisher remotePublisherFactory) (remotePublishProcessor, error) {
	if !remotePublishEnabled(cfg) {
		return nil, nil
	}
	publisher, err := newPublisher(remoteR2Config(cfg))
	if err != nil {
		return nil, err
	}
	return &remotepublish.Processor{
		Outbox:    outbox,
		Publisher: publisher,
		Store:     remotepublish.LocalMediaStore{Root: cfg.Storage.Local.DataDir},
		Prefix:    cfg.R2.Prefix,
		Limit:     defaultRemotePublishBatchSize,
	}, nil
}

func processRemotePublishOnce(ctx context.Context, processor remotePublishProcessor) {
	if processor == nil {
		return
	}
	if err := processor.ProcessDue(ctx); err != nil {
		log.WithError(err).Warn("remote publish processing failed")
	}
}

func runRemotePublishLoop(ctx context.Context, processor remotePublishProcessor, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		processRemotePublishOnce(ctx, processor)
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
```

Keep `remotePublishOptions` unchanged except imports may move. `remotepublish` is imported in `remote_publish.go`; `main.go` should call these helpers instead of importing the service package directly.

- [ ] **Step 4.4: Start processor in main**

In `cmd/podsync/main.go`, after updater creation and before headless return:

```go
remoteProcessor, err := buildRemoteProcessor(cfg, database, newRemoteR2Publisher)
if err != nil {
	log.WithError(err).Warn("remote publish disabled")
} else if remoteProcessor == nil && cfg.Remote.Enabled {
	log.Warn("remote publish disabled: R2 requires local storage and complete [r2] config")
}
```

For `opts.Headless`, after the feed update loop and before return:

```go
processRemotePublishOnce(ctx, remoteProcessor)
```

For long-running mode, add a goroutine after scheduler setup:

```go
if remoteProcessor != nil {
	group.Go(func() error {
		return runRemotePublishLoop(ctx, remoteProcessor, defaultRemotePublishInterval)
	})
}
```

This intentionally polls instead of coupling downloader enqueue to immediate upload. Keep uploads serial inside `ProcessDue`; the batch size only controls how many due tasks are attempted per polling tick.

- [ ] **Step 4.5: Add cmd tests**

In `cmd/podsync/remote_publish_test.go`, add:

```go
func TestRemotePublishEnabledRequiresRemoteLocalStorageAndR2(t *testing.T)
func TestRemoteR2ConfigMapsFields(t *testing.T)
func TestBuildRemoteProcessorSkipsDisabledOrIncompleteConfig(t *testing.T)
func TestBuildRemoteProcessorBuildsLocalR2Processor(t *testing.T)
func TestProcessRemotePublishOnceCallsProcessor(t *testing.T)
func TestRunRemotePublishLoopProcessesImmediatelyAndStops(t *testing.T)
```

Required assertions:

- disabled when remote off.
- disabled when storage is s3.
- disabled when any required R2 field is empty.
- enabled when remote on, storage local, required R2 fields present.
- config mapping preserves endpoint, bucket, prefix, access key id, secret access key.
- build helper does not call publisher factory when remote publishing is disabled or incomplete.
- build helper calls publisher factory and returns a processor when config is complete.
- `processRemotePublishOnce` invokes `ProcessDue` for headless single-run behavior and tolerates nil.
- `runRemotePublishLoop` calls `ProcessDue` immediately before waiting for the first ticker interval and returns on context cancellation.

- [ ] **Step 4.6: Run processor/main tests**

Run:

```bash
go test ./services/remote ./cmd/podsync -run 'TestProcessor|TestRemotePublishEnabled|TestRemoteR2Config|TestRemotePublishOptions|TestBuildRemoteProcessor|TestProcessRemotePublishOnce|TestRunRemotePublishLoop'
```

Expected: PASS.

---

### Task 5: Phase 3B Quality Gate And Commit

**Files:**

- All files touched in Tasks 1-4

- [ ] **Step 5.1: Run full Go gate**

Run:

```bash
go test ./...
go test -race ./services/remote ./pkg/db ./cmd/podsync
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS.

- [ ] **Step 5.2: Scope checks**

Run:

```bash
git diff -- cloudflare/worker .github Dockerfile 'Dockerfile.*'
git diff --check
git status --short
git diff --stat
```

Expected:

- no Worker, CI, Docker, NAS live config changes.
- only model/db/remote service/cmd plan files changed.
- no Cloudflare episode upsert, RSS item rendering, tombstone, or dashboard implementation.

- [ ] **Step 5.3: Sub-agent implementation review**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify Phase 3B from docs/remote-control-plane.md is implemented:
  independent R2 publisher, Put/Head only, serial upload, size verification,
  local-only media reader, retry/backoff state, no Cloudflare upsert/RSS/tombstone scope creep.

Quality reviewer:
  Review AWS SDK usage, local path safety, R2 key stability, retry state transitions,
  Badger transaction boundaries, processor error isolation, tests, and main goroutine lifecycle.
```

Expected: no blocking or important findings. Fix and re-review any blocking or important findings before commit.

- [ ] **Step 5.4: Commit Phase 3B**

Commit after all gates and reviews pass:

```bash
git add pkg/model pkg/db services/remote cmd/podsync docs/superpowers/plans/2026-07-06-r2-publisher-retry.md
git commit -m "feat: publish remote media to r2"
```

Do not push unless explicitly requested.
