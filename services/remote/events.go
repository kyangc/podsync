package remote

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/model"
)

const (
	defaultEventBatchSize = 100
	maxRemoteEventMessage = 512
	maxRemoteEventCode    = 128
	maxRemoteEventDetail  = 2048
)

type EventSink interface {
	RecordRemoteEvent(event model.RemoteEventDraft)
}

type EventRunStore interface {
	SaveRemoteEventRun(context.Context, *model.RemoteEventRunState) error
	PendingRemoteEventRuns(context.Context) ([]*model.RemoteEventRunState, error)
	DeleteRemoteEventRun(context.Context, string) error
}

type EventRecorder struct {
	flushMu            sync.Mutex
	mu                 sync.Mutex
	runID              string
	startedAt          time.Time
	maxRunDuration     time.Duration
	reporter           EventBatchReporter
	store              EventRunStore
	recovered          []*model.RemoteEventRunState
	status             model.RemoteSyncRunStatus
	finishedAt         *string
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
	RunID          string
	StartedAt      time.Time
	Reporter       EventBatchReporter
	Now            func() time.Time
	Redactions     []string
	BatchSize      int
	MaxRunDuration time.Duration
	Store          EventRunStore
}

func NewEventRecorder(cfg EventRecorderConfig) *EventRecorder {
	if cfg.Reporter == nil {
		return nil
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	startedAt := cfg.StartedAt
	if startedAt.IsZero() {
		startedAt = now().UTC()
	}
	runID := strings.TrimSpace(cfg.RunID)
	if runID == "" {
		runID = defaultRemoteRunID(startedAt)
	}
	batchSize := cfg.BatchSize
	if batchSize <= 0 || batchSize > defaultEventBatchSize {
		batchSize = defaultEventBatchSize
	}
	return &EventRecorder{
		runID:          runID,
		startedAt:      startedAt.UTC(),
		maxRunDuration: cfg.MaxRunDuration,
		reporter:       cfg.Reporter,
		store:          cfg.Store,
		status:         model.RemoteSyncRunRunning,
		now:            now,
		redactions:     cfg.Redactions,
		nextSequence:   1,
		batchSize:      batchSize,
	}
}

func NewDurableEventRecorder(cfg EventRecorderConfig) (*EventRecorder, error) {
	recorder := NewEventRecorder(cfg)
	if recorder == nil || cfg.Store == nil {
		return recorder, nil
	}
	states, err := cfg.Store.PendingRemoteEventRuns(context.Background())
	if err != nil {
		return nil, err
	}
	for _, state := range states {
		if err := validateEventRunState(state); err != nil {
			return nil, err
		}
		if state.Run.ID == recorder.runID {
			return nil, errors.New("remote event run identity already exists")
		}
		if state.Run.Status == model.RemoteSyncRunRunning {
			finishedAt := recorder.now().UTC().Format(time.RFC3339)
			state.Run.FinishedAt = &finishedAt
			state.Run.Status = model.RemoteSyncRunFailed
			if state.Run.ErrorsCount > 0 {
				state.Run.Status = model.RemoteSyncRunPartial
			}
			state.Events = append(state.Events, model.RemoteEvent{
				Sequence: state.NextSequence, EventTime: finishedAt,
				Level: model.RemoteEventWarn, Type: model.RemoteEventSyncRunFinished,
				Message: "previous process stopped before its final event report",
			})
			state.NextSequence++
			if err := cfg.Store.SaveRemoteEventRun(context.Background(), state); err != nil {
				return nil, err
			}
		}
	}
	recorder.recovered = states
	return recorder, nil
}

func validateEventRunState(state *model.RemoteEventRunState) error {
	if state == nil || state.Run.ID == "" || state.NextSequence < 1 {
		return errors.New("invalid remote event run state")
	}
	if _, err := time.Parse(time.RFC3339, state.Run.StartedAt); err != nil {
		return errors.New("invalid remote event run start time")
	}
	switch state.Run.Status {
	case model.RemoteSyncRunRunning:
	case model.RemoteSyncRunSuccess, model.RemoteSyncRunPartial, model.RemoteSyncRunFailed:
		if state.Run.FinishedAt == nil {
			return errors.New("finished remote event run is missing its finish time")
		}
	default:
		return errors.New("invalid remote event run status")
	}
	previous := 0
	for _, event := range state.Events {
		if event.Sequence <= previous || event.Sequence >= state.NextSequence {
			return errors.New("invalid remote event run sequence")
		}
		previous = event.Sequence
	}
	return nil
}

func defaultRemoteRunID(startedAt time.Time) string {
	return fmt.Sprintf("%s-%d", startedAt.UTC().Format("20060102T150405Z"), os.Getpid())
}

func (r *EventRecorder) RecordRemoteEvent(event model.RemoteEventDraft) {
	if r == nil {
		return
	}
	level := event.Level
	if level == "" {
		level = model.RemoteEventInfo
	}
	var errorDetail string
	if event.Type == model.RemoteEventDownloadFailed {
		errorDetail = summarizeDownloadError(event.ErrorDetail, r.redactions)
	} else {
		errorDetail = sanitizeEventString(event.ErrorDetail, maxRemoteEventDetail, r.redactions)
	}
	recorded := model.RemoteEvent{
		EventTime:      r.now().UTC().Format(time.RFC3339),
		Level:          level,
		Type:           event.Type,
		FeedID:         sanitizeEventString(event.FeedID, maxRemoteEventCode, r.redactions),
		LocalEpisodeID: sanitizeEventString(event.LocalEpisodeID, maxRemoteEventCode, r.redactions),
		Message:        sanitizeEventString(event.Message, maxRemoteEventMessage, r.redactions),
		ErrorCode:      sanitizeEventString(event.ErrorCode, maxRemoteEventCode, r.redactions),
		ErrorDetail:    errorDetail,
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	recorded.Sequence = r.nextSequence
	r.nextSequence++
	r.pending = append(r.pending, recorded)
	if level == model.RemoteEventError {
		r.errorsCount++
	}
	switch event.Type {
	case model.RemoteEventFeedUpdateFinished:
		r.feedsUpdated++
	case model.RemoteEventDownloadFinished:
		r.episodesDownloaded++
	case model.RemoteEventUploadFinished:
		r.episodesUploaded++
	}
	if err := r.persistLocked(); err != nil {
		log.WithError(err).Warn("failed to persist remote event")
	}
}

func (r *EventRecorder) Flush(ctx context.Context, status model.RemoteSyncRunStatus) error {
	if r == nil {
		return nil
	}
	r.flushMu.Lock()
	defer r.flushMu.Unlock()
	if err := r.flushRecovered(ctx); err != nil {
		return err
	}

	if status == model.RemoteSyncRunRunning && r.shouldRotateRun() {
		for {
			if err := r.flushCurrentRun(ctx, r.FinalStatus()); err != nil {
				return err
			}
			started, err := r.startNewRun(r.now().UTC())
			if err != nil {
				return err
			}
			if started {
				break
			}
		}
	}
	return r.flushCurrentRun(ctx, status)
}

func (r *EventRecorder) flushCurrentRun(ctx context.Context, status model.RemoteSyncRunStatus) error {
	final := status != model.RemoteSyncRunRunning
	r.mu.Lock()
	r.status = status
	if final && r.finishedAt == nil {
		finishedAt := r.now().UTC().Format(time.RFC3339)
		r.finishedAt = &finishedAt
	}
	err := r.persistLocked()
	r.mu.Unlock()
	if err != nil {
		return err
	}
	for {
		batch, sequences, empty := r.nextBatch()
		if empty && !final {
			return nil
		}
		if _, err := r.reporter.PostEventBatch(ctx, batch); err != nil {
			return err
		}
		if err := r.removeSentPrefix(sequences); err != nil {
			return err
		}
		complete, err := r.completeFlush(ctx, final)
		if err != nil {
			return err
		}
		if complete {
			return nil
		}
	}
}

func (recorder *EventRecorder) flushRecovered(ctx context.Context) error {
	for len(recorder.recovered) > 0 {
		state := recorder.recovered[0]
		limit := recorder.batchSize
		if len(state.Events) < limit {
			limit = len(state.Events)
		}
		batch := &model.RemoteEventBatch{
			Run: state.Run, Events: append([]model.RemoteEvent{}, state.Events[:limit]...),
		}
		if _, err := recorder.reporter.PostEventBatch(ctx, batch); err != nil {
			return err
		}
		if limit == len(state.Events) {
			if err := recorder.store.DeleteRemoteEventRun(ctx, state.Run.ID); err != nil {
				return err
			}
			recorder.recovered = recorder.recovered[1:]
			continue
		}
		next := *state
		next.Events = append([]model.RemoteEvent{}, state.Events[limit:]...)
		if err := recorder.store.SaveRemoteEventRun(ctx, &next); err != nil {
			return err
		}
		recorder.recovered[0] = &next
	}
	return nil
}

func (recorder *EventRecorder) completeFlush(ctx context.Context, final bool) (bool, error) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if len(recorder.pending) > 0 {
		return false, nil
	}
	if final && recorder.store != nil {
		if err := recorder.store.DeleteRemoteEventRun(ctx, recorder.runID); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (r *EventRecorder) shouldRotateRun() bool {
	if r.maxRunDuration <= 0 {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.startedAt.IsZero() && !r.now().UTC().Before(r.startedAt.Add(r.maxRunDuration))
}

func (r *EventRecorder) startNewRun(startedAt time.Time) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.pending) > 0 {
		return false, nil
	}
	r.runID = defaultRemoteRunID(startedAt)
	r.startedAt = startedAt.UTC()
	r.status = model.RemoteSyncRunRunning
	r.finishedAt = nil
	r.nextSequence = 2
	r.pending = []model.RemoteEvent{{
		Sequence: 1, EventTime: startedAt.UTC().Format(time.RFC3339),
		Level: model.RemoteEventInfo, Type: model.RemoteEventSyncRunStarted,
	}}
	r.feedsUpdated = 0
	r.episodesDownloaded = 0
	r.episodesUploaded = 0
	r.errorsCount = 0
	return true, r.persistLocked()
}

func (r *EventRecorder) FinalStatus() model.RemoteSyncRunStatus {
	if r == nil {
		return model.RemoteSyncRunSuccess
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.errorsCount > 0 {
		return model.RemoteSyncRunPartial
	}
	return model.RemoteSyncRunSuccess
}

func (r *EventRecorder) PendingCount() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
}

func (r *EventRecorder) nextBatch() (*model.RemoteEventBatch, []int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	limit := r.batchSize
	if len(r.pending) < limit {
		limit = len(r.pending)
	}
	events := append(make([]model.RemoteEvent, 0, limit), r.pending[:limit]...)
	sequences := make([]int, len(events))
	for i, event := range events {
		sequences[i] = event.Sequence
	}
	return &model.RemoteEventBatch{
		Run:    r.runLocked(),
		Events: events,
	}, sequences, len(events) == 0
}

func (recorder *EventRecorder) runLocked() model.RemoteSyncRun {
	return model.RemoteSyncRun{
		ID: recorder.runID, StartedAt: recorder.startedAt.UTC().Format(time.RFC3339),
		FinishedAt: recorder.finishedAt, Status: recorder.status,
		FeedsUpdated: recorder.feedsUpdated, EpisodesDownloaded: recorder.episodesDownloaded,
		EpisodesUploaded: recorder.episodesUploaded, ErrorsCount: recorder.errorsCount,
	}
}

func (recorder *EventRecorder) persistLocked() error {
	if recorder.store == nil {
		return nil
	}
	return recorder.store.SaveRemoteEventRun(context.Background(), &model.RemoteEventRunState{
		Run: recorder.runLocked(), NextSequence: recorder.nextSequence,
		Events: append([]model.RemoteEvent{}, recorder.pending...),
	})
}

func (r *EventRecorder) removeSentPrefix(sequences []int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(sequences) > len(r.pending) {
		return errors.New("event recorder pending prefix changed")
	}
	for i, sequence := range sequences {
		if r.pending[i].Sequence != sequence {
			return errors.New("event recorder pending prefix changed")
		}
	}
	previous := r.pending
	r.pending = append([]model.RemoteEvent(nil), r.pending[len(sequences):]...)
	if err := r.persistLocked(); err != nil {
		r.pending = previous
		return err
	}
	return nil
}

func sanitizeEventString(value string, limit int, redactions []string) string {
	value = strings.TrimSpace(value)
	value = scrubSensitiveText(value, redactions)
	return truncateRunes(value, limit)
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 || utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
