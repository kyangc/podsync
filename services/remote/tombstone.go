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
