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
		runID = fmt.Sprintf("%s-%d", startedAt.UTC().Format("20060102T150405Z"), os.Getpid())
	}
	batchSize := cfg.BatchSize
	if batchSize <= 0 || batchSize > defaultEventBatchSize {
		batchSize = defaultEventBatchSize
	}
	return &EventRecorder{
		runID:        runID,
		startedAt:    startedAt.UTC(),
		reporter:     cfg.Reporter,
		now:          now,
		redactions:   cfg.Redactions,
		nextSequence: 1,
		batchSize:    batchSize,
	}
}

func (r *EventRecorder) RecordRemoteEvent(event model.RemoteEventDraft) {
	if r == nil {
		return
	}
	level := event.Level
	if level == "" {
		level = model.RemoteEventInfo
	}
	recorded := model.RemoteEvent{
		EventTime:      r.now().UTC().Format(time.RFC3339),
		Level:          level,
		Type:           event.Type,
		FeedID:         sanitizeEventString(event.FeedID, maxRemoteEventCode, r.redactions),
		LocalEpisodeID: sanitizeEventString(event.LocalEpisodeID, maxRemoteEventCode, r.redactions),
		Message:        sanitizeEventString(event.Message, maxRemoteEventMessage, r.redactions),
		ErrorCode:      sanitizeEventString(event.ErrorCode, maxRemoteEventCode, r.redactions),
		ErrorDetail:    sanitizeEventString(event.ErrorDetail, maxRemoteEventDetail, r.redactions),
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
}

func (r *EventRecorder) Flush(ctx context.Context, status model.RemoteSyncRunStatus) error {
	if r == nil {
		return nil
	}
	r.flushMu.Lock()
	defer r.flushMu.Unlock()

	final := status != model.RemoteSyncRunRunning
	for {
		batch, sequences, empty, err := r.nextBatch(status, final)
		if err != nil {
			return err
		}
		if empty && !final {
			return nil
		}
		if _, err := r.reporter.PostEventBatch(ctx, batch); err != nil {
			return err
		}
		if empty {
			return nil
		}
		if err := r.removeSentPrefix(sequences); err != nil {
			return err
		}
		if r.PendingCount() == 0 {
			return nil
		}
	}
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

func (r *EventRecorder) nextBatch(status model.RemoteSyncRunStatus, final bool) (*model.RemoteEventBatch, []int, bool, error) {
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
	finishedAt := (*string)(nil)
	if final {
		value := r.now().UTC().Format(time.RFC3339)
		finishedAt = &value
	}
	return &model.RemoteEventBatch{
		Run: model.RemoteSyncRun{
			ID:                 r.runID,
			StartedAt:          r.startedAt.UTC().Format(time.RFC3339),
			FinishedAt:         finishedAt,
			Status:             status,
			FeedsUpdated:       r.feedsUpdated,
			EpisodesDownloaded: r.episodesDownloaded,
			EpisodesUploaded:   r.episodesUploaded,
			ErrorsCount:        r.errorsCount,
		},
		Events: events,
	}, sequences, len(events) == 0, nil
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
	r.pending = append([]model.RemoteEvent(nil), r.pending[len(sequences):]...)
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
