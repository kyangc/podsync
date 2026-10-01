package remote

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/db"
	"github.com/mxpv/podsync/pkg/model"
)

func TestDurableEventRecorderRecoversFailedFinalFlush(t *testing.T) {
	config := &db.Config{Dir: t.TempDir()}
	database, err := db.NewBadger(config)
	require.NoError(t, err)
	clock := fixedEventClock()
	failedReporter := &fakeEventReporter{err: errors.New("worker unavailable")}
	recorder, err := NewDurableEventRecorder(EventRecorderConfig{
		RunID: "old-run", StartedAt: clock.Now(), Now: clock.Now, Reporter: failedReporter, Store: database,
	})
	require.NoError(t, err)
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunStarted})
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventDownloadFinished})
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunFinished})
	require.Error(t, recorder.Flush(context.Background(), model.RemoteSyncRunSuccess))
	require.Len(t, failedReporter.batches, 1)
	want := failedReporter.batches[0]
	require.NoError(t, database.Close())

	database, err = db.NewBadger(config)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })
	clock.Advance(time.Minute)
	reporter := &fakeEventReporter{}
	recorder, err = NewDurableEventRecorder(EventRecorderConfig{
		RunID: "new-run", StartedAt: clock.Now(), Now: clock.Now, Reporter: reporter, Store: database,
	})
	require.NoError(t, err)
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventSyncRunStarted})
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	require.Len(t, reporter.batches, 2)
	assert.Equal(t, want, reporter.batches[0])
	assert.Equal(t, 1, reporter.batches[0].Run.EpisodesDownloaded)
}

func TestDurableEventRecorderClosesPreviouslyAcknowledgedRunningRun(t *testing.T) {
	database, err := db.NewBadger(&db.Config{Dir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })
	clock := fixedEventClock()
	recorder, err := NewDurableEventRecorder(EventRecorderConfig{
		RunID: "old-run", StartedAt: clock.Now(), Now: clock.Now, Reporter: &fakeEventReporter{}, Store: database,
	})
	require.NoError(t, err)
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventFeedUpdateFinished})
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	clock.Advance(time.Minute)
	reporter := &fakeEventReporter{}
	recorder, err = NewDurableEventRecorder(EventRecorderConfig{
		RunID: "new-run", StartedAt: clock.Now(), Now: clock.Now, Reporter: reporter, Store: database,
	})
	require.NoError(t, err)
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	require.Len(t, reporter.batches, 1)
	batch := reporter.batches[0]
	assert.Equal(t, model.RemoteSyncRunFailed, batch.Run.Status)
	assert.Equal(t, 1, batch.Run.FeedsUpdated)
	require.NotNil(t, batch.Run.FinishedAt)
	require.Len(t, batch.Events, 1)
	assert.Equal(t, 2, batch.Events[0].Sequence)
	assert.Equal(t, model.RemoteEventSyncRunFinished, batch.Events[0].Type)
}

func TestDurableEventRecorderRetainsEventsWhenLocalAcknowledgementFails(t *testing.T) {
	database, err := db.NewBadger(&db.Config{Dir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })
	store := &failingEventRunStore{EventRunStore: database}
	wantErr := errors.New("disk unavailable")
	reporter := eventReporterFunc(func(_ context.Context, _ *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error) {
		store.saveError = wantErr
		return &model.RemoteEventBatchResult{OK: true}, nil
	})
	recorder, err := NewDurableEventRecorder(EventRecorderConfig{RunID: "old-run", Reporter: reporter, Store: store})
	require.NoError(t, err)
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventFeedUpdateFinished})
	require.ErrorIs(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning), wantErr)
	assert.Equal(t, 1, recorder.PendingCount())
	states, err := database.PendingRemoteEventRuns(context.Background())
	require.NoError(t, err)
	require.Len(t, states, 1)
	require.Len(t, states[0].Events, 1)
	assert.Equal(t, 1, states[0].Events[0].Sequence)

	store.saveError = nil
	recoveredReporter := &fakeEventReporter{}
	recorder, err = NewDurableEventRecorder(EventRecorderConfig{RunID: "new-run", Reporter: recoveredReporter, Store: store})
	require.NoError(t, err)
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	require.Len(t, recoveredReporter.batches, 1)
	assert.Equal(t, "old-run", recoveredReporter.batches[0].Run.ID)
	assert.Equal(t, 1, recoveredReporter.batches[0].Events[0].Sequence)
	assert.Equal(t, 1, recoveredReporter.batches[0].Run.FeedsUpdated)
}

func TestDurableEventRecorderRetainsFinalSummaryWhenDeletionFails(t *testing.T) {
	database, err := db.NewBadger(&db.Config{Dir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })
	wantErr := errors.New("disk unavailable")
	store := &failingEventRunStore{EventRunStore: database, deleteError: wantErr}
	recorder, err := NewDurableEventRecorder(EventRecorderConfig{RunID: "old-run", Reporter: &fakeEventReporter{}, Store: store})
	require.NoError(t, err)
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventDownloadFinished})
	require.ErrorIs(t, recorder.Flush(context.Background(), model.RemoteSyncRunSuccess), wantErr)
	states, err := database.PendingRemoteEventRuns(context.Background())
	require.NoError(t, err)
	require.Len(t, states, 1)
	assert.Empty(t, states[0].Events)
	assert.Equal(t, model.RemoteSyncRunSuccess, states[0].Run.Status)
	store.deleteError = nil
	reporter := &fakeEventReporter{}
	recorder, err = NewDurableEventRecorder(EventRecorderConfig{RunID: "new-run", Reporter: reporter, Store: store})
	require.NoError(t, err)
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	require.Len(t, reporter.batches, 1)
	assert.Empty(t, reporter.batches[0].Events)
	assert.Equal(t, 1, reporter.batches[0].Run.EpisodesDownloaded)
	assert.Equal(t, states[0].Run.FinishedAt, reporter.batches[0].Run.FinishedAt)
}

func TestDurableEventRecorderDoesNotUploadUntilLocalPersistenceRecovers(t *testing.T) {
	database, err := db.NewBadger(&db.Config{Dir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })
	wantErr := errors.New("disk unavailable")
	store := &failingEventRunStore{EventRunStore: database, saveError: wantErr}
	reporter := &fakeEventReporter{}
	recorder, err := NewDurableEventRecorder(EventRecorderConfig{RunID: "run", Reporter: reporter, Store: store})
	require.NoError(t, err)
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventFeedUpdateFinished})
	require.ErrorIs(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning), wantErr)
	assert.Empty(t, reporter.batches)
	assert.Equal(t, 1, recorder.PendingCount())
	store.saveError = nil
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	require.Len(t, reporter.batches, 1)
	assert.Equal(t, 1, reporter.batches[0].Events[0].Sequence)
	assert.Equal(t, 1, reporter.batches[0].Run.FeedsUpdated)
}

func TestDurableEventRecorderResumesPartiallyAcknowledgedRecovery(t *testing.T) {
	config := &db.Config{Dir: t.TempDir()}
	database, err := db.NewBadger(config)
	require.NoError(t, err)
	recorder, err := NewDurableEventRecorder(EventRecorderConfig{
		RunID: "old-run", Reporter: &fakeEventReporter{err: errors.New("offline")}, Store: database,
	})
	require.NoError(t, err)
	for index := 0; index < 101; index++ {
		recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventFeedUpdateFinished})
	}
	require.Error(t, recorder.Flush(context.Background(), model.RemoteSyncRunSuccess))
	require.NoError(t, database.Close())
	database, err = db.NewBadger(config)
	require.NoError(t, err)
	calls := 0
	recoveryReporter := eventReporterFunc(func(_ context.Context, batch *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("offline again")
		}
		assert.Len(t, batch.Events, 100)
		return &model.RemoteEventBatchResult{OK: true}, nil
	})
	recorder, err = NewDurableEventRecorder(EventRecorderConfig{RunID: "middle-run", Reporter: recoveryReporter, Store: database})
	require.NoError(t, err)
	require.Error(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	states, err := database.PendingRemoteEventRuns(context.Background())
	require.NoError(t, err)
	require.Len(t, states, 1)
	require.Len(t, states[0].Events, 1)
	assert.Equal(t, 101, states[0].Events[0].Sequence)
	require.NoError(t, database.Close())
	database, err = db.NewBadger(config)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })
	reporter := &fakeEventReporter{}
	recorder, err = NewDurableEventRecorder(EventRecorderConfig{RunID: "new-run", Reporter: reporter, Store: database})
	require.NoError(t, err)
	require.NoError(t, recorder.Flush(context.Background(), model.RemoteSyncRunRunning))
	require.Len(t, reporter.batches, 1)
	require.Len(t, reporter.batches[0].Events, 1)
	assert.Equal(t, 101, reporter.batches[0].Events[0].Sequence)
	assert.Equal(t, 101, reporter.batches[0].Run.FeedsUpdated)
}

func TestEventRecorderKeepsEventsRecordedDuringRotation(t *testing.T) {
	clock := fixedEventClock()
	entered := make(chan struct{})
	release := make(chan struct{})
	batches := make([]*model.RemoteEventBatch, 0)
	reporter := eventReporterFunc(func(_ context.Context, batch *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error) {
		batches = append(batches, cloneEventBatch(batch))
		if len(batches) == 1 {
			close(entered)
			<-release
		}
		return &model.RemoteEventBatchResult{OK: true}, nil
	})
	recorder := NewEventRecorder(EventRecorderConfig{
		RunID: "old-run", StartedAt: clock.Now(), Now: clock.Now, Reporter: reporter, MaxRunDuration: time.Hour,
	})
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventFeedUpdateFinished})
	clock.Advance(time.Hour)
	finished := make(chan error, 1)
	go func() { finished <- recorder.Flush(context.Background(), model.RemoteSyncRunRunning) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("rotation did not reach reporter")
	}
	recorder.RecordRemoteEvent(model.RemoteEventDraft{Type: model.RemoteEventFeedUpdateFinished})
	close(release)
	require.NoError(t, <-finished)
	require.Len(t, batches, 3)
	assert.Equal(t, "old-run", batches[1].Run.ID)
	assert.Equal(t, 2, batches[1].Run.FeedsUpdated)
	assert.Equal(t, 2, batches[1].Events[0].Sequence)
	assert.Equal(t, model.RemoteEventSyncRunStarted, batches[2].Events[0].Type)
	assert.Equal(t, 1, batches[2].Events[0].Sequence)
}

type failingEventRunStore struct {
	EventRunStore
	saveError   error
	deleteError error
}

func (store *failingEventRunStore) SaveRemoteEventRun(ctx context.Context, state *model.RemoteEventRunState) error {
	if store.saveError != nil {
		return store.saveError
	}
	return store.EventRunStore.SaveRemoteEventRun(ctx, state)
}

func (store *failingEventRunStore) DeleteRemoteEventRun(ctx context.Context, runID string) error {
	if store.deleteError != nil {
		return store.deleteError
	}
	return store.EventRunStore.DeleteRemoteEventRun(ctx, runID)
}

type eventReporterFunc func(context.Context, *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error)

func (reporter eventReporterFunc) PostEventBatch(ctx context.Context, batch *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error) {
	return reporter(ctx, batch)
}
