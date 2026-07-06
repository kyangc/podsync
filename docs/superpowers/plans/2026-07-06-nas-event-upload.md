# NAS Event Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 5B NAS-side key event collection and upload to the Worker `/api/nas/events/batch` API.

**Architecture:** Keep event upload best-effort and non-blocking for this slice. A runtime event recorder owns one process/run id, assigns monotonic event sequences, redacts configured secrets, keeps failed events pending in memory, and posts batches through the existing remote NAS client. Update, R2 publish, tombstone sync, remote config refresh, headless runs, and graceful shutdown record only the Phase 5 key events.

**Tech Stack:** Go, existing `services/remote.NASClient`, existing Badger-backed runtime, Logrus, unit tests with `httptest` and small fakes.

---

## Scope Boundaries

This phase may modify:

- `pkg/model/remote.go`
- `services/remote/client.go`
- `services/remote/client_test.go`
- `services/remote/redact.go`
- `services/remote/redact_test.go`
- `services/remote/events.go`
- `services/remote/events_test.go`
- `services/remote/processor.go`
- `services/remote/processor_test.go`
- `services/remote/tombstone.go`
- `services/remote/tombstone_test.go`
- `services/update/updater.go`
- `services/update/updater_test.go`
- `cmd/podsync/main.go`
- `cmd/podsync/remote_events.go`
- `cmd/podsync/remote_events_test.go`
- `docs/superpowers/plans/2026-07-06-nas-event-upload.md`

This phase must not implement:

- Worker API/schema changes; Phase 5A already added `/api/nas/events/batch`.
- Durable event outbox in Badger or files.
- Dashboard status panels.
- Retention cron or R2 raw log uploads.
- Feed create/edit/delete UI.
- Any cookie, token, or header upload.
- Changes to Docker, CI, live Cloudflare resources, or NAS deployment files.

Durable event outbox remains a later Phase 5C candidate. This phase still retries while the current podsync process is alive: failed flushes keep pending events in memory for the next flush. Local podcast generation must never fail because event upload failed.

---

## Acceptance Criteria

- `remote.enabled=false` does not create an event recorder, does not post HTTP, and keeps current local behavior.
- `remote.enabled=true` with `remote.base_url` and `remote.token` creates one run-scoped event recorder.
- The recorder emits `sync_run_started` at startup and `sync_run_finished` on headless completion or graceful shutdown.
- Remote config resolution emits:
  - `remote_config_fetched` when remote TOML is accepted.
  - `remote_config_fallback_used` when cache or local fallback is used.
  - `remote_config_invalid` when remote config resolution/refresh returns an error.
- Feed update emits `feed_update_started`, `feed_update_finished`, and `feed_update_failed`.
- Download flow emits `episode_discovered`, `episode_download_finished`, and `episode_download_failed`.
- R2/Worker publish flow emits `episode_upload_finished`, `episode_upload_failed`, `episode_report_finished`, and `episode_report_failed`.
- Tombstone sync emits `tombstone_fetched`, `tombstone_applied`, and `tombstone_apply_failed`.
- All emitted event types are from the Worker whitelist in Phase 5A.
- Event sequences are monotonic per run and are not reused after successful flush.
- A failed flush keeps the same pending events for retry and preserves sequence values for idempotency.
- Batches sent to Worker contain at most 100 events.
- Messages and error details are truncated to Worker limits and redact configured secrets.
- Client HTTP errors redact `remote.token`, authorization/cookie headers, and common sensitive query/field shapes.
- Event upload errors are logged as warnings and do not make local update/download/publish/tombstone flows fail.

---

## Event Contracts

Add Go types matching Phase 5A JSON:

```go
type RemoteSyncRunStatus string

const (
	RemoteSyncRunRunning RemoteSyncRunStatus = "running"
	RemoteSyncRunSuccess RemoteSyncRunStatus = "success"
	RemoteSyncRunPartial RemoteSyncRunStatus = "partial"
	RemoteSyncRunFailed  RemoteSyncRunStatus = "failed"
)

type RemoteEventLevel string

const (
	RemoteEventDebug RemoteEventLevel = "debug"
	RemoteEventInfo  RemoteEventLevel = "info"
	RemoteEventWarn  RemoteEventLevel = "warn"
	RemoteEventError RemoteEventLevel = "error"
)

type RemoteEventType string

const (
	RemoteEventSyncRunStarted        RemoteEventType = "sync_run_started"
	RemoteEventSyncRunFinished       RemoteEventType = "sync_run_finished"
	RemoteEventConfigFetched         RemoteEventType = "remote_config_fetched"
	RemoteEventConfigFallbackUsed    RemoteEventType = "remote_config_fallback_used"
	RemoteEventConfigInvalid         RemoteEventType = "remote_config_invalid"
	RemoteEventFeedUpdateStarted     RemoteEventType = "feed_update_started"
	RemoteEventFeedUpdateFinished    RemoteEventType = "feed_update_finished"
	RemoteEventFeedUpdateFailed      RemoteEventType = "feed_update_failed"
	RemoteEventEpisodeDiscovered     RemoteEventType = "episode_discovered"
	RemoteEventDownloadFinished      RemoteEventType = "episode_download_finished"
	RemoteEventDownloadFailed        RemoteEventType = "episode_download_failed"
	RemoteEventUploadFinished        RemoteEventType = "episode_upload_finished"
	RemoteEventUploadFailed          RemoteEventType = "episode_upload_failed"
	RemoteEventReportFinished        RemoteEventType = "episode_report_finished"
	RemoteEventReportFailed          RemoteEventType = "episode_report_failed"
	RemoteEventTombstoneFetched      RemoteEventType = "tombstone_fetched"
	RemoteEventTombstoneApplied      RemoteEventType = "tombstone_applied"
	RemoteEventTombstoneApplyFailed  RemoteEventType = "tombstone_apply_failed"
)
```

Phase 5A Worker accepts additional future event types such as `r2_probe_failed`, `remote_api_failed`, `cookie_profile_missing`, and `cookie_profile_invalid`. Do not add Go constants or emitters for those future types in this Phase 5B commit; they belong to later dedicated instrumentation work.

JSON structs:

```go
type RemoteSyncRun struct {
	ID                 string              `json:"id"`
	StartedAt          string              `json:"started_at"`
	FinishedAt         *string             `json:"finished_at"`
	Status             RemoteSyncRunStatus `json:"status"`
	FeedsUpdated       int                 `json:"feeds_updated"`
	EpisodesDownloaded int                 `json:"episodes_downloaded"`
	EpisodesUploaded   int                 `json:"episodes_uploaded"`
	ErrorsCount        int                 `json:"errors_count"`
}

type RemoteEventDraft struct {
	Level          RemoteEventLevel `json:"-"`
	Type           RemoteEventType  `json:"-"`
	FeedID         string           `json:"-"`
	LocalEpisodeID string           `json:"-"`
	Message        string           `json:"-"`
	ErrorCode      string           `json:"-"`
	ErrorDetail    string           `json:"-"`
}

type RemoteEvent struct {
	Sequence       int              `json:"sequence"`
	EventTime      string           `json:"event_time"`
	Level          RemoteEventLevel `json:"level"`
	Type           RemoteEventType  `json:"type"`
	FeedID         string           `json:"feed_id,omitempty"`
	LocalEpisodeID string           `json:"local_episode_id,omitempty"`
	Message        string           `json:"message,omitempty"`
	ErrorCode      string           `json:"error_code,omitempty"`
	ErrorDetail    string           `json:"error_detail,omitempty"`
}

type RemoteEventBatch struct {
	Run    RemoteSyncRun `json:"run"`
	Events []RemoteEvent `json:"events"`
}

type RemoteEventBatchResult struct {
	OK              bool   `json:"ok"`
	RunID           string `json:"run_id"`
	AcceptedEvents  int    `json:"accepted_events"`
	InsertedEvents  int    `json:"inserted_events"`
	DuplicateEvents int    `json:"duplicate_events"`
}
```

The recorder uses `time.RFC3339` with UTC second resolution. Do not use `time.RFC3339Nano`; Phase 5A intentionally rejects fractional seconds.

---

## Task 1: Model Types And NAS Client

**Files:**

- Modify: `pkg/model/remote.go`
- Modify: `services/remote/client.go`
- Modify: `services/remote/client_test.go`
- Create: `services/remote/redact.go`
- Create: `services/remote/redact_test.go`

- [ ] **Step 1.1: Add shared redaction helper**

Create `services/remote/redact.go`:

```go
package remote

import (
	"regexp"
	"strings"
)

var sensitiveTextPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+`),
	regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`(?i)((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+`),
	regexp.MustCompile(`(?i)([?&](?:access_token|token|api_key|key|secret|session|sessdata|bili_jct|buvid3|dedeuserid|sid|asset_token)=)[^&\s]+`),
	regexp.MustCompile(`(?i)((?:access_token|token|api[_-]?key|key|secret|session|sessdata|bili_jct|buvid3|dedeuserid|sid|asset_token)\s*[:=]\s*)[^\s,;&]+`),
}

var quotedSensitiveFieldPattern = regexp.MustCompile(`(?i)("(?:access_token|token|api[_-]?key|key|secret|session|sessdata|bili_jct|buvid3|dedeuserid|sid|asset_token)"\s*:\s*")[^"]+(")`)
```

Apply the quoted field replacement separately so the closing quote is preserved:

```go
func scrubSensitiveText(value string, redactions []string) string {
	for _, secret := range redactions {
		secret = strings.TrimSpace(secret)
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	for _, pattern := range sensitiveTextPatterns {
		value = pattern.ReplaceAllString(value, `${1}[redacted]`)
	}
	value = quotedSensitiveFieldPattern.ReplaceAllString(value, `${1}[redacted]${2}`)
	return value
}

```

Create `services/remote/redact_test.go`:

```go
func TestScrubSensitiveTextRedactsConfiguredSecrets(t *testing.T)
func TestScrubSensitiveTextRedactsAuthorizationAndCookieHeaders(t *testing.T)
func TestScrubSensitiveTextRedactsSensitiveQueryAndFieldShapes(t *testing.T)
```

The tests must cover:

- exact configured secret replacement.
- `Authorization: Bearer secret-token`.
- `Cookie: SESSDATA=abc; bili_jct=def`.
- `Set-Cookie: SESSDATA=abc`.
- `https://example.com/path?token=secret&safe=1`.
- `api_key=secret`, `secret: value`, `session=value`, and `asset_token=value`.
- JSON/object-ish fields: `"token":"secret"`, `"api_key": "secret"`, `"SESSDATA":"abc"`, and `"asset_token":"abc"`. Assert exact redacted output keeps valid quoting, e.g. `"token":"[redacted]"`.

- [ ] **Step 1.2: Add Go event model types**

Add the contracts from the "Event Contracts" section to `pkg/model/remote.go` below the tombstone types and above `RemotePublishTask`.

- [ ] **Step 1.3: Add client interface and method**

Add to `services/remote/client.go`:

```go
type EventBatchReporter interface {
	PostEventBatch(ctx context.Context, batch *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error)
}
```

Add to `NASClient`:

```go
func (c *NASClient) PostEventBatch(ctx context.Context, batch *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error) {
	if batch == nil {
		return nil, nonRetryable("remote event batch is required")
	}
	body, err := json.Marshal(batch)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.eventsBatchURL(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(readLimitedString(resp.Body, maxNASClientErrorBody))
		message = scrubSensitiveText(message, []string{c.token})
		var responseErr error
		if message == "" {
			responseErr = fmt.Errorf("event batch returned HTTP %d", resp.StatusCode)
		} else {
			responseErr = fmt.Errorf("event batch returned HTTP %d: %s", resp.StatusCode, message)
		}
		if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusNotFound {
			return nil, &NonRetryableError{err: responseErr}
		}
		return nil, responseErr
	}

	var result model.RemoteEventBatchResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if result.RunID == "" {
		return nil, errors.New("event batch response run_id is required")
	}
	return &result, nil
}

func (c *NASClient) eventsBatchURL() string {
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/nas/events/batch"
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	return endpoint.String()
}
```

Also replace the existing `strings.ReplaceAll(message, c.token, "[redacted]")` calls in `UpsertEpisode` and `FetchTombstones` with `scrubSensitiveText(message, []string{c.token})`, so all remote client HTTP error bodies share the same redaction behavior.

- [ ] **Step 1.4: Add client tests**

Append tests to `services/remote/client_test.go`:

```go
func TestNASClientPostEventBatchPostsExpectedPayload(t *testing.T)
func TestNASClientPostEventBatchClearsBaseURLQuery(t *testing.T)
func TestNASClientPostEventBatchRejectsNilBatch(t *testing.T)
func TestNASClientPostEventBatchRejectsNon2xx(t *testing.T)
func TestNASClientPostEventBatchMarksValidationHTTPStatusNonRetryable(t *testing.T)
func TestNASClientPostEventBatchRedactsTokenInErrors(t *testing.T)
func TestNASClientPostEventBatchRedactsHeadersAndQuerySecretsInErrors(t *testing.T)
func TestNASClientPostEventBatchRejectsMissingRunIDResponse(t *testing.T)
```

The happy-path test must assert:

- Method is `POST`.
- Path is `/api/nas/events/batch`.
- Headers include `Authorization: Bearer secret`, `Content-Type: application/json`, and `Accept: application/json`.
- Payload has `run.id`, `run.status`, and first event `type`.
- Response decodes `run_id`, `accepted_events`, `inserted_events`, and `duplicate_events`.

- [ ] **Step 1.5: Verify client slice**

Run:

```bash
go test ./services/remote
```

Expected: PASS.

---

## Task 2: Runtime Event Recorder

**Files:**

- Create: `services/remote/events.go`
- Create: `services/remote/events_test.go`

- [ ] **Step 2.1: Implement recorder**

Create `services/remote/events.go` with:

```go
package remote

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/mxpv/podsync/pkg/model"
)

const (
	defaultEventBatchSize  = 100
	maxRemoteEventMessage = 512
	maxRemoteEventCode    = 128
	maxRemoteEventDetail  = 2048
)

type EventSink interface {
	RecordRemoteEvent(event model.RemoteEventDraft)
}

type EventRecorder struct {
	flushMu            sync.Mutex
	mu                 sync.Mutex
	runID              string
	startedAt          time.Time
	reporter           EventBatchReporter
	now                func() time.Time
	redactions         []string
	nextSequence       int
	pending            []model.RemoteEvent
	feedsUpdated       int
	episodesDownloaded int
	episodesUploaded   int
	errorsCount        int
	batchSize          int
}

type EventRecorderConfig struct {
	RunID      string
	StartedAt  time.Time
	Reporter   EventBatchReporter
	Now        func() time.Time
	Redactions []string
	BatchSize  int
}
```

Methods:

```go
func NewEventRecorder(cfg EventRecorderConfig) *EventRecorder
func (r *EventRecorder) RecordRemoteEvent(event model.RemoteEventDraft)
func (r *EventRecorder) Flush(ctx context.Context, status model.RemoteSyncRunStatus) error
func (r *EventRecorder) FinalStatus() model.RemoteSyncRunStatus
func (r *EventRecorder) PendingCount() int
```

Implementation requirements:

- `NewEventRecorder` returns `nil` when `cfg.Reporter == nil`.
- Default `RunID` is `time.Now().UTC().Format("20060102T150405Z")` plus process id only when caller does not pass one. Keep generated id shorter than 128 chars.
- Default `StartedAt` is `now().UTC()`.
- Default `Now` is `time.Now().UTC`.
- `RecordRemoteEvent` is a no-op on nil receiver.
- `RecordRemoteEvent` assigns `Sequence = nextSequence`, starting at 1.
- `EventTime` uses `now().UTC().Format(time.RFC3339)`.
- Run `started_at` and `finished_at` also use `.UTC().Format(time.RFC3339)`. Do not use `time.RFC3339Nano` anywhere in event batches.
- Blank `Level` defaults to `info`.
- Message, error_code, and error_detail are redacted and truncated.
- Each `RemoteEventError` increments `errorsCount`.
- `feed_update_finished` increments `feedsUpdated`.
- `episode_download_finished` increments `episodesDownloaded`.
- `episode_upload_finished` increments `episodesUploaded`.
- `Flush(ctx, running)` sends batches with `finished_at` omitted.
- `Flush(ctx, success|partial|failed)` sends batches with `finished_at` set to flush time.
- `Flush` sends at most `batchSize` events per request.
- `Flush` must use `flushMu` to allow only one flush at a time. This is a correctness guard, not just a performance optimization: concurrent flushes must not copy the same pending prefix, double-post it, or delete events recorded by another goroutine.
- `Flush` must not hold `mu` while calling `reporter.PostEventBatch`; take a copy of the pending prefix under lock, unlock for HTTP, then relock to remove the successfully sent prefix. This keeps event upload from blocking local update/download paths that only need to record events.
- Before removing a successfully sent prefix, verify the pending prefix still has the same sequence values. If it does not, return an error and keep pending unchanged. With `flushMu` this should not normally happen, but the check prevents silent data loss if the implementation changes later.
- If a reporter call fails, keep the unsent chunk and all later pending events unchanged and return the error.
- If a reporter call succeeds, remove that chunk from pending and continue until pending is empty.
- If pending is empty and status is `running`, return without sending HTTP.
- If pending is empty and status is final, still send one empty event batch so the run summary can advance to final status.
- `FinalStatus` returns `partial` when `errorsCount > 0`, otherwise `success`.

Redaction helper:

```go
func sanitizeEventString(value string, limit int, redactions []string) string {
	value = strings.TrimSpace(value)
	value = scrubSensitiveText(value, redactions)
	return truncateRunes(value, limit)
}
```

`scrubSensitiveText` comes from `services/remote/redact.go`; do not duplicate regexes in `events.go`.

Use rune truncation rather than byte slicing so UTF-8 is not broken.

- [ ] **Step 2.2: Add recorder tests**

Create `services/remote/events_test.go` with fake reporter and tests:

```go
func TestEventRecorderRecordsSequencesAndCounters(t *testing.T)
func TestEventRecorderContinuesSequenceAfterSuccessfulFlush(t *testing.T)
func TestEventRecorderFlushesAtMostOneHundredEventsPerBatch(t *testing.T)
func TestEventRecorderKeepsPendingEventsWhenFlushFails(t *testing.T)
func TestEventRecorderSerializesConcurrentFlushes(t *testing.T)
func TestEventRecorderSkipsRunningFlushWithNoPendingEvents(t *testing.T)
func TestEventRecorderFlushesFinalSummaryWithNoPendingEvents(t *testing.T)
func TestEventRecorderRedactsAndTruncatesEventStrings(t *testing.T)
func TestEventRecorderUsesRFC3339SecondResolution(t *testing.T)
func TestNilEventRecorderIsNoop(t *testing.T)
```

Key assertions:

- First event sequence is `1`, second is `2`.
- After a successful flush, recording a new event uses the next sequence, not `1`.
- A 101-event flush creates two reporter calls.
- After first reporter failure, pending count remains unchanged.
- Retrying after failure reuses the same sequence values.
- `secret-token` in message/detail becomes `[redacted]`.
- `Authorization: Bearer secret-token`, `Cookie: SESSDATA=abc`, `https://example.com/?token=secret`, and `api_key=secret` are redacted even when the exact secret was not configured.
- Long message is at most 512 runes, long error detail at most 2048 runes.
- Event time, run started_at, and final finished_at do not contain fractional seconds. Running batches omit finished_at.

- [ ] **Step 2.3: Verify recorder slice**

Run:

```bash
go test ./services/remote
go test -race ./services/remote
```

Expected: PASS.

---

## Task 3: Instrument Update And Publish Flows

**Files:**

- Modify: `services/update/updater.go`
- Modify: `services/update/updater_test.go`
- Modify: `services/remote/processor.go`
- Modify: `services/remote/processor_test.go`
- Modify: `services/remote/tombstone.go`
- Modify: `services/remote/tombstone_test.go`

- [ ] **Step 3.1: Add optional event sink to updater**

In `services/update/updater.go`, import no new packages beyond existing model usage and add:

```go
type RemoteEventSink interface {
	RecordRemoteEvent(event model.RemoteEventDraft)
}

func WithRemoteEventSink(sink RemoteEventSink) Option {
	return func(u *Manager) {
		u.remoteEventSink = sink
	}
}
```

Add `remoteEventSink RemoteEventSink` to `Manager`.

Add helper:

```go
func (u *Manager) recordRemoteEvent(event model.RemoteEventDraft) {
	if u.remoteEventSink != nil {
		u.remoteEventSink.RecordRemoteEvent(event)
	}
}
```

Instrumentation in Task 3 must only call synchronous in-memory `RecordRemoteEvent`. Do not call `Flush`, do not perform HTTP, and do not add return values to these business paths. Event upload failures are handled only by `flushRemoteEventsOnce` in Task 4.

- [ ] **Step 3.2: Emit feed update events**

Change `Update` to use a named return:

```go
func (u *Manager) Update(ctx context.Context, feedConfig *feed.Config) (err error) {
	u.recordRemoteEvent(model.RemoteEventDraft{
		Level:  model.RemoteEventInfo,
		Type:   model.RemoteEventFeedUpdateStarted,
		FeedID: feedConfig.ID,
	})
	defer func() {
		if err != nil {
			u.recordRemoteEvent(model.RemoteEventDraft{
				Level:       model.RemoteEventError,
				Type:        model.RemoteEventFeedUpdateFailed,
				FeedID:      feedConfig.ID,
				ErrorCode:   "feed_update_failed",
				ErrorDetail: err.Error(),
			})
			return
		}
		u.recordRemoteEvent(model.RemoteEventDraft{
			Level:  model.RemoteEventInfo,
			Type:   model.RemoteEventFeedUpdateFinished,
			FeedID: feedConfig.ID,
		})
	}()
	// keep existing body and existing returned errors
}
```

Do not change the existing local update order.

- [ ] **Step 3.3: Emit episode discover/download events**

In `fetchEpisodes`, just before appending an episode to `downloadList`, record:

```go
u.recordRemoteEvent(model.RemoteEventDraft{
	Level:          model.RemoteEventInfo,
	Type:           model.RemoteEventEpisodeDiscovered,
	FeedID:         feedID,
	LocalEpisodeID: episode.ID,
	Message:        episode.Title,
})
```

In `downloadEpisodes`, when `u.downloader.Download` returns a non-429 error and before continuing, record:

```go
u.recordRemoteEvent(model.RemoteEventDraft{
	Level:          model.RemoteEventError,
	Type:           model.RemoteEventDownloadFailed,
	FeedID:         feedID,
	LocalEpisodeID: episode.ID,
	ErrorCode:      "download_failed",
	ErrorDetail:    err.Error(),
})
```

After local file status is successfully marked downloaded, record:

```go
u.recordRemoteEvent(model.RemoteEventDraft{
	Level:          model.RemoteEventInfo,
	Type:           model.RemoteEventDownloadFinished,
	FeedID:         feedID,
	LocalEpisodeID: episode.ID,
	Message:        episode.Title,
})
```

Do not emit a download-finished event for the "already exists on disk" fast path; that path did not download in this run.

- [ ] **Step 3.4: Extend updater tests**

In `services/update/updater_test.go`, add a small recording sink:

```go
type recordingEventSink struct {
	events []model.RemoteEventDraft
}

func (r *recordingEventSink) RecordRemoteEvent(event model.RemoteEventDraft) {
	r.events = append(r.events, event)
}
```

Add tests:

```go
func TestUpdateRecordsFeedUpdateFailureEvent(t *testing.T)
func TestUpdateRecordsFeedUpdateStartedAndFinishedEvents(t *testing.T)
func TestFetchEpisodesRecordsDiscoveredEvents(t *testing.T)
func TestDownloadEpisodesRecordsDownloadFinishedEvent(t *testing.T)
func TestDownloadEpisodesRecordsDownloadFailedEvent(t *testing.T)
func TestDownloadEpisodesDoesNotRecordFinishedForExistingMedia(t *testing.T)
```

Use existing `hookDB`, `hookFS`, and `hookDownloader` patterns where possible.
These tests must keep asserting the original success/error behavior of the local update/download path; adding an event sink must not change return values, DB status updates, or remote publish outbox enqueue behavior.
For the successful feed update test, use fakes that let `Update` complete and assert the first/last feed events are `feed_update_started` and `feed_update_finished`.

- [ ] **Step 3.5: Instrument remote processor**

In `services/remote/processor.go`, add:

```go
Events EventSink
```

to `Processor`.

Add helper:

```go
func (p *Processor) recordEvent(event model.RemoteEventDraft) {
	if p.Events != nil {
		p.Events.RecordRemoteEvent(event)
	}
}
```

Emit:

- `episode_upload_failed` when `Publisher.Upload` fails.
- `episode_upload_finished` immediately after `Publisher.Upload` succeeds.
- `episode_report_failed` when `Upserter.UpsertEpisode` fails.
- `episode_report_finished` immediately after `Upserter.UpsertEpisode` succeeds.

For upload/report failures, use `Level: error`, `ErrorCode: "episode_upload_failed"` or `"episode_report_failed"`, and `ErrorDetail: err.Error()`.

Do not change outbox retry/fail semantics.

- [ ] **Step 3.6: Extend processor tests**

In `services/remote/processor_test.go`, add event sink assertions to existing success/failure tests or add:

```go
func TestProcessorRecordsUploadAndReportFinishedEvents(t *testing.T)
func TestProcessorRecordsUploadFailedEvent(t *testing.T)
func TestProcessorRecordsReportFailedEvent(t *testing.T)
```

Assert `FeedID` and `LocalEpisodeID` match the task.
Keep the existing processor assertions for retry/complete/fail transitions intact in the event tests; event recording must not change outbox state.

- [ ] **Step 3.7: Instrument tombstone syncer**

In `services/remote/tombstone.go`, add:

```go
Events EventSink
```

to `TombstoneSyncer`, plus helper `recordEvent`.

Inside `SyncOnce`:

- After each successful fetch, record `tombstone_fetched` with message like `changes=<n>`.
- After each successful apply, record `tombstone_applied` with message like `next_cursor=<n>`.
- If fetch or apply returns an error, record `tombstone_apply_failed` with `Level: error`, `ErrorCode: "tombstone_sync_failed"`, and `ErrorDetail: err.Error()` before returning.

- [ ] **Step 3.8: Extend tombstone tests**

In `services/remote/tombstone_test.go`, add:

```go
func TestTombstoneSyncerRecordsFetchedAndAppliedEvents(t *testing.T)
func TestTombstoneSyncerRecordsFailedEvent(t *testing.T)
```

Keep the existing cursor/apply assertions intact in the event tests; event recording must not advance or roll back tombstone cursor state differently.

- [ ] **Step 3.9: Verify service instrumentation**

Run:

```bash
go test ./services/update ./services/remote
```

Expected: PASS.

---

## Task 4: Wire Main Runtime Event Upload

**Files:**

- Create: `cmd/podsync/remote_events.go`
- Create: `cmd/podsync/remote_events_test.go`
- Modify: `cmd/podsync/main.go`
- Modify: `cmd/podsync/remote_publish.go`
- Modify: `cmd/podsync/remote_tombstone.go`

- [ ] **Step 4.1: Add command-side event helpers**

Create `cmd/podsync/remote_events.go`:

```go
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/model"
	remotepublish "github.com/mxpv/podsync/services/remote"
)

const defaultRemoteEventInterval = 1 * time.Minute

type remoteEventRecorder interface {
	remotepublish.EventSink
	Flush(ctx context.Context, status model.RemoteSyncRunStatus) error
	FinalStatus() model.RemoteSyncRunStatus
}

type remoteEventReporterFactory func(baseURL string, token string) (remotepublish.EventBatchReporter, error)

func remoteEventReportingEnabled(cfg *Config) bool {
	return cfg.Remote.Enabled && cfg.Remote.BaseURL != "" && cfg.Remote.Token != ""
}

func newRemoteEventReporter(baseURL string, token string) (remotepublish.EventBatchReporter, error) {
	return remotepublish.NewNASClient(baseURL, token, nil)
}

func buildRemoteEventRecorder(cfg *Config, newReporter remoteEventReporterFactory) (remoteEventRecorder, error) {
	if !remoteEventReportingEnabled(cfg) {
		return nil, nil
	}
	reporter, err := newReporter(cfg.Remote.BaseURL, cfg.Remote.Token)
	if err != nil {
		return nil, err
	}
	started := time.Now().UTC()
	runID := fmt.Sprintf("%s-%d", started.Format("20060102T150405Z"), os.Getpid())
	return remotepublish.NewEventRecorder(remotepublish.EventRecorderConfig{
		RunID:      runID,
		StartedAt:  started,
		Reporter:   reporter,
		Redactions: collectRemoteEventRedactions(cfg),
	}), nil
}

func collectRemoteEventRedactions(cfg *Config) []string {
	if cfg == nil {
		return nil
	}
	values := []string{
		cfg.Remote.Token,
		cfg.R2.AccessKeyID,
		cfg.R2.SecretAccessKey,
	}
	for _, tokens := range cfg.Tokens {
		values = append(values, tokens...)
	}
	for _, profile := range cfg.CookieProfiles {
		values = append(values, profile.Path)
	}
	return values
}

func recordRemoteConfigEvent(events remoteEventRecorder, resolved resolvedFeeds, err error) {
	if events == nil {
		return
	}
	if err != nil {
		events.RecordRemoteEvent(model.RemoteEventDraft{
			Level:       model.RemoteEventError,
			Type:        model.RemoteEventConfigInvalid,
			ErrorCode:   "remote_config_invalid",
			ErrorDetail: err.Error(),
		})
	}
	switch resolved.Source {
	case remoteFeedSourceRemote:
		if err == nil {
			events.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventInfo, Type: model.RemoteEventConfigFetched})
		}
	case remoteFeedSourceCache, remoteFeedSourceLocalFallback:
		events.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventWarn, Type: model.RemoteEventConfigFallbackUsed, Message: string(resolved.Source)})
	}
}

func flushRemoteEventsOnce(ctx context.Context, events remoteEventRecorder, status model.RemoteSyncRunStatus) {
	if events == nil {
		return
	}
	if err := events.Flush(ctx, status); err != nil {
		log.WithError(err).Warn("remote event upload failed")
	}
}

func runRemoteEventLoop(ctx context.Context, events remoteEventRecorder, interval time.Duration) error {
	if events == nil {
		return nil
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			flushRemoteEventsOnce(ctx, events, model.RemoteSyncRunRunning)
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			events.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventInfo, Type: model.RemoteEventSyncRunFinished})
			flushRemoteEventsOnce(shutdownCtx, events, events.FinalStatus())
			return ctx.Err()
		}
	}
}
```

This intentionally allows two events for `err != nil` plus cache/local fallback: `remote_config_invalid` records the remote fetch/parse problem, while `remote_config_fallback_used` records the applied fallback. Do not emit `remote_config_fetched` when `err != nil`.

Do not read cookie files while collecting redactions. Cookie file contents are secrets and should never be opened by the event subsystem. Cookie/header-shaped text is handled by `scrubSensitiveText`.

- [ ] **Step 4.2: Add command helper tests**

Create `cmd/podsync/remote_events_test.go` with:

```go
func TestRemoteEventReportingDisabledWithoutRemote(t *testing.T)
func TestBuildRemoteEventRecorderDisabledDoesNotCallFactory(t *testing.T)
func TestBuildRemoteEventRecorderUsesRemoteBaseURLAndToken(t *testing.T)
func TestCollectRemoteEventRedactionsIncludesConfiguredSecrets(t *testing.T)
func TestRecordRemoteConfigEventMapsSources(t *testing.T)
func TestRecordRemoteConfigEventDoesNotEmitFetchedWhenErrorHasNoRemoteSource(t *testing.T)
func TestRecordRemoteLifecycleStartAndFinishEvents(t *testing.T)
func TestFlushRemoteEventsOnceSuppressesReporterError(t *testing.T)
func TestRunRemoteEventLoopFlushesFinalOnCancel(t *testing.T)
```

Use fake reporter/recorder instead of real HTTP where possible.

Specific expectations:

- Disabled remote config must leave the reporter factory uncalled.
- Redactions include `remote.token`, R2 access key, R2 secret key, every value from `cfg.Tokens`, and every cookie profile path.
- Cookie profile paths are redacted because they can reveal local secret storage layout, even though the event subsystem must not read cookie file contents.
- `recordRemoteConfigEvent` may emit both `remote_config_invalid` and `remote_config_fallback_used` when a remote fetch fails but cache/local fallback is applied. It must not emit `remote_config_fetched` unless `resolved.Source == remoteFeedSourceRemote`.
- Extract small helpers if needed so startup and headless/shutdown events can be tested without running the whole daemon. Tests must cover `sync_run_started` and `sync_run_finished` recording.
- `flushRemoteEventsOnce` must not return an error or panic when the recorder returns an upload error.
- The final cancel path uses a bounded context and records `sync_run_finished`.

- [ ] **Step 4.3: Wire recorder in main**

In `cmd/podsync/main.go`, after database/storage are created and before `resolveFeeds`, build:

```go
remoteEvents, err := buildRemoteEventRecorder(cfg, newRemoteEventReporter)
if err != nil {
	log.WithError(err).Warn("remote event reporting disabled")
}
if remoteEvents != nil {
	remoteEvents.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventInfo, Type: model.RemoteEventSyncRunStarted})
}
```

After initial `resolveFeeds`, call:

```go
recordRemoteConfigEvent(remoteEvents, resolved, err)
```

When building update manager:

```go
updateOptions := remotePublishOptions(cfg, database)
if remoteEvents != nil {
	updateOptions = append(updateOptions, update.WithRemoteEventSink(remoteEvents))
}
```

When building remote processor and tombstone syncer, pass `remoteEvents` through their builders.

In headless mode:

```go
if remoteEvents != nil {
	remoteEvents.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventInfo, Type: model.RemoteEventSyncRunFinished})
	eventFlushCtx, eventFlushCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer eventFlushCancel()
	flushRemoteEventsOnce(eventFlushCtx, remoteEvents, remoteEvents.FinalStatus())
}
```

Guard nil recorder before method calls.

Inside remote config refresh success/failure branch, call `recordRemoteConfigEvent(remoteEvents, resolved, err)`.

Start the event upload loop alongside remote publish/tombstone loops:

```go
if remoteEvents != nil {
	group.Go(func() error {
		return runRemoteEventLoop(ctx, remoteEvents, defaultRemoteEventInterval)
	})
}
```

- [ ] **Step 4.4: Update remote builder functions**

Change `cmd/podsync/remote_publish.go`:

```go
func buildRemoteProcessor(
	cfg *Config,
	outbox remotepublish.Outbox,
	newPublisher remotePublisherFactory,
	newUpserter remoteUpserterFactory,
	events remotepublish.EventSink,
) (remotePublishProcessor, error)
```

Set `Events: events` on `remotepublish.Processor`.

Change `cmd/podsync/remote_tombstone.go`:

```go
func buildRemoteTombstoneSyncer(
	cfg *Config,
	store remotepublish.TombstoneStore,
	newFetcher remoteTombstoneFetcherFactory,
	events remotepublish.EventSink,
) (remoteTombstoneSyncer, error)
```

Set `Events: events` on `remotepublish.TombstoneSyncer`.

Update tests in `cmd/podsync` for changed signatures if needed.

- [ ] **Step 4.5: Verify command wiring**

Run:

```bash
go test ./cmd/podsync
```

Expected: PASS.

---

## Task 5: Phase 5B Quality Gate And Commit

**Files:**

- All files touched in Tasks 1-4.

- [ ] **Step 5.1: Run Go verification**

Run:

```bash
go test ./...
go test -race ./services/remote ./cmd/podsync
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS.

- [ ] **Step 5.2: Run optional Worker verification**

This phase should not change Worker code. If Worker dependencies are available, run:

```bash
cd cloudflare/worker && npm run check
cd cloudflare/worker && npm run d1:check
cd cloudflare/worker && npm run wrangler:check
```

Expected: PASS. If dependencies or Cloudflare dry-run prerequisites are unavailable, record the exact blocker and keep `git diff -- cloudflare/worker` empty as the required scope gate.

- [ ] **Step 5.3: Check scope and whitespace**

Run:

```bash
git diff -- cloudflare/worker
git diff -- .github Dockerfile 'Dockerfile.*'
git diff --check
git status --short
```

Expected:

- Worker diff is empty.
- CI/Docker diff is empty.
- `git diff --check` has no output.
- Changed files match this plan.

Also run a whitelist sanity check over implemented Go constants and emitted event types: every emitted type must be one of the Phase 5B types listed in this plan and accepted by the Phase 5A Worker whitelist.

- [ ] **Step 5.4: Request implementation review**

Ask sub-agent reviewers:

```text
Review Phase 5B from docs/superpowers/plans/2026-07-06-nas-event-upload.md.
Confirm NAS key event upload is implemented only as a best-effort runtime queue:
client POST /api/nas/events/batch, event recorder sequence/redaction/truncation/batching,
update/download/publish/tombstone/config lifecycle instrumentation, main loop flush,
and no durable event outbox, dashboard UI, Worker API/schema, retention cron, Docker/CI,
or deployment changes.
Pay special attention to: event upload must not break local podcast generation, secrets must
not leak in event payloads or client errors, timestamps must be RFC3339 without fractional seconds,
and retry behavior must keep pending events in memory after failed flush.
```

Fix Critical/Important findings and rerun relevant tests before proceeding.

- [ ] **Step 5.5: Commit Phase 5B**

After review PASS and verification:

```bash
git add pkg/model services/remote services/update cmd/podsync docs/superpowers/plans/2026-07-06-nas-event-upload.md
git commit -m "feat: upload nas remote events"
```

Do not push unless the user asks.
