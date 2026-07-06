package remote

import (
	"context"
	"errors"
	"fmt"
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
	Events  EventSink
	Limit   int
	Now     func() time.Time
}

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
			s.recordEvent(model.RemoteEventDraft{
				Level:       model.RemoteEventError,
				Type:        model.RemoteEventTombstoneApplyFailed,
				ErrorCode:   "tombstone_sync_failed",
				ErrorDetail: err.Error(),
			})
			return err
		}
		s.recordEvent(model.RemoteEventDraft{
			Level:   model.RemoteEventInfo,
			Type:    model.RemoteEventTombstoneFetched,
			Message: fmt.Sprintf("changes=%d", len(batch.Changes)),
		})
		if batch.HasMore && batch.NextCursor <= cursor {
			err := errors.New("remote tombstone page did not advance cursor")
			s.recordEvent(model.RemoteEventDraft{
				Level:       model.RemoteEventError,
				Type:        model.RemoteEventTombstoneApplyFailed,
				ErrorCode:   "tombstone_sync_failed",
				ErrorDetail: err.Error(),
			})
			return err
		}
		if err := s.Store.ApplyRemoteTombstones(ctx, batch, s.now()); err != nil {
			s.recordEvent(model.RemoteEventDraft{
				Level:       model.RemoteEventError,
				Type:        model.RemoteEventTombstoneApplyFailed,
				ErrorCode:   "tombstone_sync_failed",
				ErrorDetail: err.Error(),
			})
			return err
		}
		s.recordEvent(model.RemoteEventDraft{
			Level:   model.RemoteEventInfo,
			Type:    model.RemoteEventTombstoneApplied,
			Message: fmt.Sprintf("next_cursor=%d", batch.NextCursor),
		})
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

func (s *TombstoneSyncer) recordEvent(event model.RemoteEventDraft) {
	if s != nil && s.Events != nil {
		s.Events.RecordRemoteEvent(event)
	}
}
