package remote

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

func TestTombstoneSyncerNoopsWhenDisabled(t *testing.T) {
	var nilSyncer *TombstoneSyncer
	require.NoError(t, nilSyncer.SyncOnce(context.Background()))

	require.NoError(t, (&TombstoneSyncer{}).SyncOnce(context.Background()))
}

func TestTombstoneSyncerAppliesSinglePageAndAdvancesCursor(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	fetcher := &fakeTombstoneFetcher{batches: []*model.RemoteTombstoneBatch{{Cursor: 5, NextCursor: 6}}}
	store := &fakeTombstoneStore{cursor: 5}
	syncer := &TombstoneSyncer{Fetcher: fetcher, Store: store, Now: func() time.Time { return now }}

	err := syncer.SyncOnce(context.Background())

	require.NoError(t, err)
	assert.Equal(t, []int64{5}, fetcher.cursors)
	assert.Equal(t, []int{defaultTombstoneLimit}, fetcher.limits)
	require.Len(t, store.applied, 1)
	assert.Equal(t, int64(6), store.cursor)
	assert.Equal(t, []time.Time{now}, store.appliedAt)
}

func TestTombstoneSyncerFetchesUntilHasMoreFalse(t *testing.T) {
	fetcher := &fakeTombstoneFetcher{batches: []*model.RemoteTombstoneBatch{
		{Cursor: 5, NextCursor: 6, HasMore: true},
		{Cursor: 6, NextCursor: 7, HasMore: false},
	}}
	store := &fakeTombstoneStore{cursor: 5}
	syncer := &TombstoneSyncer{Fetcher: fetcher, Store: store, Limit: 2}

	err := syncer.SyncOnce(context.Background())

	require.NoError(t, err)
	assert.Equal(t, []int64{5, 6}, fetcher.cursors)
	assert.Equal(t, []int{2, 2}, fetcher.limits)
	require.Len(t, store.applied, 2)
	assert.Equal(t, int64(7), store.cursor)
}

func TestTombstoneSyncerDoesNotAdvanceCursorWhenFetchFails(t *testing.T) {
	fetchErr := errors.New("worker unavailable")
	fetcher := &fakeTombstoneFetcher{err: fetchErr}
	store := &fakeTombstoneStore{cursor: 5}
	syncer := &TombstoneSyncer{Fetcher: fetcher, Store: store}

	err := syncer.SyncOnce(context.Background())

	require.ErrorIs(t, err, fetchErr)
	assert.Equal(t, int64(5), store.cursor)
	assert.Empty(t, store.applied)
}

func TestTombstoneSyncerRejectsHasMoreWithoutCursorAdvance(t *testing.T) {
	fetcher := &fakeTombstoneFetcher{batches: []*model.RemoteTombstoneBatch{{Cursor: 5, NextCursor: 5, HasMore: true}}}
	store := &fakeTombstoneStore{cursor: 5}
	syncer := &TombstoneSyncer{Fetcher: fetcher, Store: store}

	err := syncer.SyncOnce(context.Background())

	require.Error(t, err)
	assert.Contains(t, err.Error(), "did not advance")
	assert.Equal(t, int64(5), store.cursor)
	assert.Empty(t, store.applied)
}

type fakeTombstoneFetcher struct {
	batches []*model.RemoteTombstoneBatch
	err     error
	cursors []int64
	limits  []int
}

func (f *fakeTombstoneFetcher) FetchTombstones(_ context.Context, cursor int64, limit int) (*model.RemoteTombstoneBatch, error) {
	f.cursors = append(f.cursors, cursor)
	f.limits = append(f.limits, limit)
	if f.err != nil {
		return nil, f.err
	}
	if len(f.batches) == 0 {
		return nil, errors.New("unexpected fetch")
	}
	batch := f.batches[0]
	f.batches = f.batches[1:]
	return batch, nil
}

type fakeTombstoneStore struct {
	cursor    int64
	applied   []*model.RemoteTombstoneBatch
	appliedAt []time.Time
	err       error
}

func (s *fakeTombstoneStore) GetRemoteTombstoneCursor(context.Context) (int64, error) {
	return s.cursor, nil
}

func (s *fakeTombstoneStore) ApplyRemoteTombstones(_ context.Context, batch *model.RemoteTombstoneBatch, now time.Time) error {
	if s.err != nil {
		return s.err
	}
	s.applied = append(s.applied, batch)
	s.appliedAt = append(s.appliedAt, now)
	s.cursor = batch.NextCursor
	return nil
}
