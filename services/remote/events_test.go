package remote

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

func TestEventRecorderRecordsSequencesAndCounters(t *testing.T) {
	reporter := &fakeEventReporter{}
	now := fixedEventClock()
	recorder := NewEventRecorder(EventRecorderConfig{
		RunID:     "run-1",
		StartedAt: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC),
		Reporter:  reporter,
		Now:       now.Now,
	})

	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventFeedUpdateFinished})
	now.Advance(time.Second)
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventError, Type: model.RemoteEventDownloadFailed, ErrorDetail: "boom"})
	err := recorder.Flush(context.Background(), model.RemoteSyncRunRunning)

	require.NoError(t, err)
	require.Len(t, reporter.batches, 1)
	batch := reporter.batches[0]
	require.Len(t, batch.Events, 2)
	assert.Equal(t, 1, batch.Events[0].Sequence)
	assert.Equal(t, 2, batch.Events[1].Sequence)
	assert.Equal(t, model.RemoteEventInfo, batch.Events[0].Level)
	assert.Equal(t, 1, batch.Run.FeedsUpdated)
	assert.Equal(t, 1, batch.Run.ErrorsCount)
	assert.Equal(t, model.RemoteSyncRunPartial, recorder.FinalStatus())
}

func TestEventRecorderContinuesSequenceAfterSuccessfulFlush(t *testing.T) {
	reporter := &fakeEventReporter{}
	recorder := NewEventRecorder(EventRecorderConfig{RunID: "run-1", Reporter: reporter})
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunStarted})
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))

	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunFinished})
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunSuccess))

	require.Len(t, reporter.batches, 2)
	assert.Equal(t, 1, reporter.batches[0].Events[0].Sequence)
	assert.Equal(t, 2, reporter.batches[1].Events[0].Sequence)
}

func TestEventRecorderFlushesAtMostOneHundredEventsPerBatch(t *testing.T) {
	reporter := &fakeEventReporter{}
	recorder := NewEventRecorder(EventRecorderConfig{RunID: "run-1", Reporter: reporter})
	for i := 0; i < 101; i++ {
		recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunStarted})
	}

	err := recorder.Flush(context.Background(), model.RemoteSyncRunRunning)

	require.NoError(t, err)
	require.Len(t, reporter.batches, 2)
	assert.Len(t, reporter.batches[0].Events, 100)
	assert.Len(t, reporter.batches[1].Events, 1)
}

func TestEventRecorderKeepsPendingEventsWhenFlushFails(t *testing.T) {
	wantErr := errors.New("worker unavailable")
	reporter := &fakeEventReporter{err: wantErr}
	recorder := NewEventRecorder(EventRecorderConfig{RunID: "run-1", Reporter: reporter})
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunStarted})

	err := recorder.Flush(context.Background(), model.RemoteSyncRunRunning)

	require.ErrorIs(t, err, wantErr)
	assert.Equal(t, 1, recorder.PendingCount())
	reporter.err = nil
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	require.Len(t, reporter.batches, 2)
	assert.Equal(t, 1, reporter.batches[1].Events[0].Sequence)
}

func TestEventRecorderSerializesConcurrentFlushes(t *testing.T) {
	reporter := &fakeEventReporter{block: make(chan struct{})}
	recorder := NewEventRecorder(EventRecorderConfig{RunID: "run-1", Reporter: reporter})
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunStarted})

	var wg sync.WaitGroup
	wg.Add(2)
	errs := make([]error, 2)
	go func() {
		defer wg.Done()
		errs[0] = recorder.Flush(context.Background(), model.RemoteSyncRunRunning)
	}()
	reporter.WaitForCall(t)
	go func() {
		defer wg.Done()
		errs[1] = recorder.Flush(context.Background(), model.RemoteSyncRunRunning)
	}()
	close(reporter.block)
	wg.Wait()

	require.NoError(t, errs[0])
	require.NoError(t, errs[1])
	assert.Len(t, reporter.batches, 1)
}

func TestEventRecorderSkipsRunningFlushWithNoPendingEvents(t *testing.T) {
	reporter := &fakeEventReporter{}
	recorder := NewEventRecorder(EventRecorderConfig{RunID: "run-1", Reporter: reporter})

	err := recorder.Flush(context.Background(), model.RemoteSyncRunRunning)

	require.NoError(t, err)
	assert.Empty(t, reporter.batches)
}

func TestEventRecorderFlushesFinalSummaryWithNoPendingEvents(t *testing.T) {
	reporter := &fakeEventReporter{}
	recorder := NewEventRecorder(EventRecorderConfig{RunID: "run-1", Reporter: reporter})

	err := recorder.Flush(context.Background(), model.RemoteSyncRunSuccess)

	require.NoError(t, err)
	require.Len(t, reporter.batches, 1)
	assert.Empty(t, reporter.batches[0].Events)
	assert.NotNil(t, reporter.batches[0].Run.FinishedAt)
}

func TestEventRecorderFinalSummarySerializesEmptyEventsArray(t *testing.T) {
	reporter := &jsonEventReporter{}
	recorder := NewEventRecorder(EventRecorderConfig{RunID: "run-1", Reporter: reporter})

	err := recorder.Flush(context.Background(), model.RemoteSyncRunSuccess)

	require.NoError(t, err)
	assert.Contains(t, string(reporter.body), `"events":[]`)
}

func TestEventRecorderRedactsAndTruncatesEventStrings(t *testing.T) {
	reporter := &fakeEventReporter{}
	recorder := NewEventRecorder(EventRecorderConfig{
		RunID:      "run-1",
		Reporter:   reporter,
		Redactions: []string{"secret-token"},
	})
	recorder.RecordRemoteEvent(model.RemoteEventDraft{
		Type:        model.RemoteEventDownloadFailed,
		Message:     strings.Repeat("界", 600) + " secret-token",
		ErrorCode:   strings.Repeat("c", 140),
		ErrorDetail: `Authorization: Bearer secret-token Cookie: SESSDATA=abc https://example.com/?token=secret api_key=secret {"asset_token":"abc"}`,
	})

	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	event := reporter.batches[0].Events[0]
	assert.LessOrEqual(t, len([]rune(event.Message)), maxRemoteEventMessage)
	assert.LessOrEqual(t, len([]rune(event.ErrorCode)), maxRemoteEventCode)
	assert.LessOrEqual(t, len([]rune(event.ErrorDetail)), maxRemoteEventDetail)
	assert.NotContains(t, event.Message, "secret-token")
	assert.NotContains(t, event.ErrorDetail, "secret-token")
	assert.NotContains(t, event.ErrorDetail, "SESSDATA=abc")
	assert.NotContains(t, event.ErrorDetail, "token=secret")
	assert.NotContains(t, event.ErrorDetail, "api_key=secret")
	assert.NotContains(t, event.ErrorDetail, `"asset_token":"abc"`)
	assert.Contains(t, event.ErrorDetail, "[redacted]")
}

func TestEventRecorderUsesRFC3339SecondResolution(t *testing.T) {
	reporter := &fakeEventReporter{}
	now := fixedEventClockAt(time.Date(2026, 7, 6, 12, 0, 0, 123456789, time.UTC))
	recorder := NewEventRecorder(EventRecorderConfig{
		RunID:     "run-1",
		StartedAt: now.Now(),
		Reporter:  reporter,
		Now:       now.Now,
	})
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunStarted})

	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	now.Advance(5 * time.Second)
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunSuccess))

	require.Len(t, reporter.batches, 2)
	assert.Equal(t, "2026-07-06T12:00:00Z", reporter.batches[0].Run.StartedAt)
	assert.Nil(t, reporter.batches[0].Run.FinishedAt)
	assert.Equal(t, "2026-07-06T12:00:00Z", reporter.batches[0].Events[0].EventTime)
	require.NotNil(t, reporter.batches[1].Run.FinishedAt)
	assert.Equal(t, "2026-07-06T12:00:05Z", *reporter.batches[1].Run.FinishedAt)
}

func TestEventRecorderRotatesRunningRunAfterMaxDuration(t *testing.T) {
	reporter := &fakeEventReporter{}
	now := fixedEventClock()
	recorder := NewEventRecorder(EventRecorderConfig{
		RunID:          "run-1",
		StartedAt:      now.Now(),
		Reporter:       reporter,
		Now:            now.Now,
		MaxRunDuration: time.Hour,
	})

	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventFeedUpdateFinished})
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))

	now.Advance(time.Hour)
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventError, Type: model.RemoteEventDownloadFailed, ErrorDetail: "network failed"})
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))

	require.Len(t, reporter.batches, 3)
	assert.Equal(t, "run-1", reporter.batches[0].Run.ID)
	assert.Equal(t, model.RemoteSyncRunRunning, reporter.batches[0].Run.Status)
	assert.Equal(t, 1, reporter.batches[0].Run.FeedsUpdated)
	assert.Equal(t, "run-1", reporter.batches[1].Run.ID)
	assert.Equal(t, model.RemoteSyncRunPartial, reporter.batches[1].Run.Status)
	require.NotNil(t, reporter.batches[1].Run.FinishedAt)
	assert.Equal(t, 1, reporter.batches[1].Run.ErrorsCount)
	assert.NotEqual(t, "run-1", reporter.batches[2].Run.ID)
	assert.Equal(t, model.RemoteSyncRunRunning, reporter.batches[2].Run.Status)
	assert.Equal(t, 0, reporter.batches[2].Run.ErrorsCount)
	require.Len(t, reporter.batches[2].Events, 1)
	assert.Equal(t, 1, reporter.batches[2].Events[0].Sequence)
	assert.Equal(t, model.RemoteEventSyncRunStarted, reporter.batches[2].Events[0].Type)
}

func TestNilEventRecorderIsNoop(t *testing.T) {
	var recorder *EventRecorder

	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunStarted})

	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	assert.Equal(t, model.RemoteSyncRunSuccess, recorder.FinalStatus())
	assert.Zero(t, recorder.PendingCount())
	assert.Nil(t, NewEventRecorder(EventRecorderConfig{}))
}

type fakeEventReporter struct {
	mu      sync.Mutex
	batches []*model.RemoteEventBatch
	err     error
	block   chan struct{}
	called  chan struct{}
}

type jsonEventReporter struct {
	body []byte
}

func (f *jsonEventReporter) PostEventBatch(_ context.Context, batch *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error) {
	body, err := json.Marshal(batch)
	if err != nil {
		return nil, err
	}
	f.body = body
	return &model.RemoteEventBatchResult{
		OK:             true,
		RunID:          batch.Run.ID,
		AcceptedEvents: len(batch.Events),
		InsertedEvents: len(batch.Events),
	}, nil
}

func (f *fakeEventReporter) PostEventBatch(_ context.Context, batch *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error) {
	f.mu.Lock()
	if f.called == nil {
		f.called = make(chan struct{})
	}
	select {
	case <-f.called:
	default:
		close(f.called)
	}
	f.mu.Unlock()
	if f.block != nil {
		<-f.block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches = append(f.batches, cloneEventBatch(batch))
	if f.err != nil {
		return nil, f.err
	}
	return &model.RemoteEventBatchResult{
		OK:             true,
		RunID:          batch.Run.ID,
		AcceptedEvents: len(batch.Events),
		InsertedEvents: len(batch.Events),
	}, nil
}

func (f *fakeEventReporter) WaitForCall(t *testing.T) {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		f.mu.Lock()
		called := f.called
		f.mu.Unlock()
		if called != nil {
			select {
			case <-called:
				return
			case <-deadline:
				t.Fatal("timed out waiting for reporter call")
			}
		}
		select {
		case <-time.After(time.Millisecond):
		case <-deadline:
			t.Fatal("timed out waiting for reporter call")
		}
	}
}

func cloneEventBatch(batch *model.RemoteEventBatch) *model.RemoteEventBatch {
	if batch == nil {
		return nil
	}
	clone := *batch
	clone.Events = append([]model.RemoteEvent(nil), batch.Events...)
	return &clone
}

type eventClock struct {
	mu  sync.Mutex
	now time.Time
}

func fixedEventClock() *eventClock {
	return fixedEventClockAt(time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC))
}

func fixedEventClockAt(now time.Time) *eventClock {
	return &eventClock{now: now}
}

func (c *eventClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *eventClock) Advance(duration time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(duration)
}
