package db

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

func TestBadgerRemoteTombstoneCursorDefaultsToZero(t *testing.T) {
	db := newTestBadger(t)

	cursor, err := db.GetRemoteTombstoneCursor(context.Background())

	require.NoError(t, err)
	assert.Equal(t, int64(0), cursor)
}

func TestBadgerApplyRemoteTombstonesStoresMarkerAndCursorAtomically(t *testing.T) {
	ctx := context.Background()
	db := newTestBadger(t)
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)

	err := db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(0, 7, remoteTombstoneChange(7, "feed", "episode", model.RemoteEpisodeStatusHidden, model.RemoteTombstoneActionHide)), now)

	require.NoError(t, err)
	cursor, err := db.GetRemoteTombstoneCursor(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(7), cursor)
	tombstoned, err := db.IsRemoteEpisodeTombstoned(ctx, "feed", "episode")
	require.NoError(t, err)
	assert.True(t, tombstoned)
}

func TestBadgerApplyRemoteTombstonesRejectsBackwardCursor(t *testing.T) {
	ctx := context.Background()
	db := newTestBadger(t)
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	require.NoError(t, db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(0, 7), now))

	err := db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(7, 6, remoteTombstoneChange(6, "feed", "episode", model.RemoteEpisodeStatusHidden, model.RemoteTombstoneActionHide)), now)

	require.Error(t, err)
	cursor, err := db.GetRemoteTombstoneCursor(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(7), cursor)
	tombstoned, err := db.IsRemoteEpisodeTombstoned(ctx, "feed", "episode")
	require.NoError(t, err)
	assert.False(t, tombstoned)
}

func TestBadgerApplyRemoteTombstonesRejectsStaleOrGapCursor(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		batchCursor int64
	}{
		{name: "stale", batchCursor: 6},
		{name: "gap", batchCursor: 9},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := newTestBadger(t)
			require.NoError(t, db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(0, 7), now))

			err := db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(tt.batchCursor, 10, remoteTombstoneChange(10, "feed", "episode", model.RemoteEpisodeStatusHidden, model.RemoteTombstoneActionHide)), now)

			require.Error(t, err)
			cursor, err := db.GetRemoteTombstoneCursor(ctx)
			require.NoError(t, err)
			assert.Equal(t, int64(7), cursor)
			tombstoned, err := db.IsRemoteEpisodeTombstoned(ctx, "feed", "episode")
			require.NoError(t, err)
			assert.False(t, tombstoned)
		})
	}
}

func TestBadgerApplyRemoteTombstonesRollsBackInvalidMidBatchChange(t *testing.T) {
	ctx := context.Background()
	db := newTestBadger(t)
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)

	err := db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(0, 2,
		remoteTombstoneChange(1, "feed", "first", model.RemoteEpisodeStatusHidden, model.RemoteTombstoneActionHide),
		remoteTombstoneChange(2, "feed", "second", model.RemoteEpisodeStatusHidden, model.RemoteTombstoneActionRestore),
	), now)

	require.Error(t, err)
	cursor, err := db.GetRemoteTombstoneCursor(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(0), cursor)
	tombstoned, err := db.IsRemoteEpisodeTombstoned(ctx, "feed", "first")
	require.NoError(t, err)
	assert.False(t, tombstoned)
}

func TestBadgerApplyRemoteTombstonesRestoreRemovesMarker(t *testing.T) {
	ctx := context.Background()
	db := newTestBadger(t)
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	require.NoError(t, db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(0, 1, remoteTombstoneChange(1, "feed", "episode", model.RemoteEpisodeStatusHidden, model.RemoteTombstoneActionHide)), now))

	err := db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(1, 2, remoteTombstoneChange(2, "feed", "episode", model.RemoteEpisodeStatusVisible, model.RemoteTombstoneActionRestore)), now)

	require.NoError(t, err)
	cursor, err := db.GetRemoteTombstoneCursor(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(2), cursor)
	tombstoned, err := db.IsRemoteEpisodeTombstoned(ctx, "feed", "episode")
	require.NoError(t, err)
	assert.False(t, tombstoned)
}

func TestBadgerApplyRemoteTombstonesFailsPendingPublishTask(t *testing.T) {
	ctx := context.Background()
	db := newTestBadger(t)
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	task := newRemotePublishTask("feed", "episode")
	require.NoError(t, db.EnqueueRemotePublishTask(ctx, task))

	err := db.ApplyRemoteTombstones(ctx, remoteTombstoneBatch(0, 1, remoteTombstoneChange(1, "feed", "episode", model.RemoteEpisodeStatusDeletePending, model.RemoteTombstoneActionDelete)), now)

	require.NoError(t, err)
	got, err := db.GetRemotePublishTask(ctx, model.RemotePublishTaskID("feed", "episode"))
	require.NoError(t, err)
	assert.Equal(t, model.RemotePublishFailed, got.Status)
	assert.Equal(t, model.ErrRemoteEpisodeTombstoned.Error(), got.LastError)
	assert.Zero(t, got.NextAttemptAt)
}

func remoteTombstoneBatch(cursor int64, nextCursor int64, changes ...model.RemoteTombstoneChange) *model.RemoteTombstoneBatch {
	return &model.RemoteTombstoneBatch{
		Cursor:     cursor,
		NextCursor: nextCursor,
		Changes:    changes,
	}
}

func remoteTombstoneChange(sequence int64, feedID string, localEpisodeID string, status model.RemoteEpisodeStatus, action model.RemoteTombstoneAction) model.RemoteTombstoneChange {
	return model.RemoteTombstoneChange{
		Sequence:       sequence,
		FeedID:         feedID,
		LocalEpisodeID: localEpisodeID,
		Status:         status,
		Action:         action,
		CreatedAt:      "2026-07-07T12:00:00Z",
	}
}
