package db

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dgraph-io/badger"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

func TestBadger_EnqueueRemotePublishTaskCreatesPendingTask(t *testing.T) {
	db := newTestBadger(t)

	task := newRemotePublishTask("feed", "episode")
	task.Status = model.RemotePublishFailed
	task.Attempts = 3
	task.LastError = "caller state should not seed new tasks"
	require.NoError(t, db.EnqueueRemotePublishTask(context.Background(), task))
	assert.Empty(t, task.ID)
	assert.Equal(t, model.RemotePublishFailed, task.Status)
	assert.Equal(t, 3, task.Attempts)
	assert.Equal(t, "caller state should not seed new tasks", task.LastError)
	assert.Zero(t, task.CreatedAt)

	got, err := db.GetRemotePublishTask(context.Background(), model.RemotePublishTaskID("feed", "episode"))
	require.NoError(t, err)
	assert.Equal(t, model.RemotePublishTaskID("feed", "episode"), got.ID)
	assert.Equal(t, model.RemotePublishPending, got.Status)
	assert.Zero(t, got.Attempts)
	assert.Empty(t, got.LastError)
	assert.NotZero(t, got.CreatedAt)
	assert.NotZero(t, got.UpdatedAt)
	assert.NotZero(t, got.NextAttemptAt)
	assert.Equal(t, "feed/episode.mp3", got.MediaPath)
	assert.EqualValues(t, 123, got.Size)
}

func TestBadger_EnqueueRemotePublishTaskIsIdempotent(t *testing.T) {
	db := newTestBadger(t)
	ctx := context.Background()
	nextAttempt := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)

	first := newRemotePublishTask("feed", "episode")
	first.ID = model.RemotePublishTaskID("feed", "episode")
	first.Status = model.RemotePublishFailed
	first.Attempts = 5
	first.NextAttemptAt = nextAttempt
	first.LastError = "temporary failure"
	first.CreatedAt = time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	first.UpdatedAt = first.CreatedAt
	require.NoError(t, db.seedRemotePublishTask(first))

	second := newRemotePublishTask("feed", "episode")
	second.MediaPath = "feed/episode-redownloaded.mp3"
	second.Size = 456
	second.Title = "Episode redownloaded"
	second.SourceURL = "https://example.com/redownloaded"
	second.PublishedAt = time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	require.NoError(t, db.EnqueueRemotePublishTask(ctx, second))

	got, err := db.GetRemotePublishTask(ctx, model.RemotePublishTaskID("feed", "episode"))
	require.NoError(t, err)
	assert.Equal(t, "feed/episode-redownloaded.mp3", got.MediaPath)
	assert.EqualValues(t, 456, got.Size)
	assert.Equal(t, "Episode redownloaded", got.Title)
	assert.Equal(t, "https://example.com/redownloaded", got.SourceURL)
	assert.Equal(t, second.PublishedAt, got.PublishedAt)
	assert.Equal(t, model.RemotePublishFailed, got.Status)
	assert.Equal(t, 5, got.Attempts)
	assert.Equal(t, nextAttempt, got.NextAttemptAt)
	assert.Equal(t, "temporary failure", got.LastError)
}

func TestBadger_EnqueueRemotePublishTaskPreservesRemoteAssetState(t *testing.T) {
	tests := []struct {
		name   string
		status model.RemotePublishStatus
	}{
		{name: "pending", status: model.RemotePublishPending},
		{name: "succeeded", status: model.RemotePublishSucceeded},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := newTestBadger(t)
			ctx := context.Background()
			completedAt := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)

			first := newRemotePublishTask("feed", "episode")
			first.ID = model.RemotePublishTaskID("feed", "episode")
			first.Status = tt.status
			first.Attempts = 4
			first.NextAttemptAt = completedAt.Add(time.Hour)
			first.LastError = "previous error"
			first.R2Key = "audio/feed/episode-token.mp3"
			first.AssetToken = "token"
			first.MimeType = "audio/mpeg"
			first.CompletedAt = completedAt
			first.CreatedAt = completedAt.Add(-time.Hour)
			first.UpdatedAt = completedAt
			require.NoError(t, db.seedRemotePublishTask(first))

			second := newRemotePublishTask("feed", "episode")
			second.MediaPath = "feed/episode-new.mp3"
			second.Size = 999
			second.Title = "Episode new"
			require.NoError(t, db.EnqueueRemotePublishTask(ctx, second))

			got, err := db.GetRemotePublishTask(ctx, model.RemotePublishTaskID("feed", "episode"))
			require.NoError(t, err)
			assert.Equal(t, "feed/episode-new.mp3", got.MediaPath)
			assert.EqualValues(t, 999, got.Size)
			assert.Equal(t, "Episode new", got.Title)
			assert.Equal(t, tt.status, got.Status)
			assert.Equal(t, 4, got.Attempts)
			assert.Equal(t, first.NextAttemptAt, got.NextAttemptAt)
			assert.Equal(t, "previous error", got.LastError)
			assert.Equal(t, "audio/feed/episode-token.mp3", got.R2Key)
			assert.Equal(t, "token", got.AssetToken)
			assert.Equal(t, "audio/mpeg", got.MimeType)
			assert.Equal(t, completedAt, got.CompletedAt)
		})
	}
}

func TestRemotePublishTaskIDEscapesDelimiters(t *testing.T) {
	id := model.RemotePublishTaskID("feed/with:delimiters", "episode/with:delimiters")

	assert.True(t, strings.HasPrefix(id, "publish_episode:"))
	assert.Equal(t, 2, strings.Count(id, ":"))
	assert.Equal(t, id, model.RemotePublishTaskID("feed/with:delimiters", "episode/with:delimiters"))
}

func TestBadger_WalkRemotePublishTasksFiltersByStatus(t *testing.T) {
	db := newTestBadger(t)
	ctx := context.Background()
	pending := newRemotePublishTask("feed", "pending")
	succeeded := newRemotePublishTask("feed", "succeeded")
	succeeded.ID = model.RemotePublishTaskID("feed", "succeeded")
	succeeded.Status = model.RemotePublishSucceeded
	require.NoError(t, db.EnqueueRemotePublishTask(ctx, pending))
	require.NoError(t, db.seedRemotePublishTask(succeeded))

	var got []string
	err := db.WalkRemotePublishTasks(ctx, model.RemotePublishPending, func(task *model.RemotePublishTask) error {
		got = append(got, task.LocalEpisodeID)
		return nil
	})

	require.NoError(t, err)
	assert.Equal(t, []string{"pending"}, got)
}

func TestBadger_DueRemotePublishTasksReturnsPendingDueTasks(t *testing.T) {
	db := newTestBadger(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)

	dueA := seededRemotePublishTask("feed", "due-a", model.RemotePublishPending, now.Add(-time.Minute))
	dueB := seededRemotePublishTask("feed", "due-b", model.RemotePublishPending, time.Time{})
	future := seededRemotePublishTask("feed", "future", model.RemotePublishPending, now.Add(time.Hour))
	succeeded := seededRemotePublishTask("feed", "succeeded", model.RemotePublishSucceeded, now.Add(-time.Minute))
	failed := seededRemotePublishTask("feed", "failed", model.RemotePublishFailed, now.Add(-time.Minute))
	require.NoError(t, db.seedRemotePublishTask(dueA))
	require.NoError(t, db.seedRemotePublishTask(dueB))
	require.NoError(t, db.seedRemotePublishTask(future))
	require.NoError(t, db.seedRemotePublishTask(succeeded))
	require.NoError(t, db.seedRemotePublishTask(failed))

	limited, err := db.DueRemotePublishTasks(ctx, now, 1)
	require.NoError(t, err)
	require.Len(t, limited, 1)

	got, err := db.DueRemotePublishTasks(ctx, now, 10)
	require.NoError(t, err)
	var ids []string
	for _, task := range got {
		ids = append(ids, task.LocalEpisodeID)
	}
	assert.ElementsMatch(t, []string{"due-a", "due-b"}, ids)
}

func TestBadger_PrepareRemotePublishAttemptPersistsAssetAndIncrementsAttempts(t *testing.T) {
	db := newTestBadger(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	task := seededRemotePublishTask("feed", "episode", model.RemotePublishPending, now)
	task.Attempts = 2
	task.LastError = "old error"
	require.NoError(t, db.seedRemotePublishTask(task))

	got, err := db.PrepareRemotePublishAttempt(ctx, task.ID, "audio/feed/episode-token.mp3", "token", "audio/mpeg", now)
	require.NoError(t, err)
	assert.Equal(t, "audio/feed/episode-token.mp3", got.R2Key)
	assert.Equal(t, "token", got.AssetToken)
	assert.Equal(t, "audio/mpeg", got.MimeType)
	assert.Equal(t, 3, got.Attempts)
	assert.Empty(t, got.LastError)
	assert.Equal(t, now, got.UpdatedAt)

	persisted, err := db.GetRemotePublishTask(ctx, task.ID)
	require.NoError(t, err)
	assert.Equal(t, got, persisted)
}

func TestBadger_PrepareRemotePublishAttemptRejectsNonPendingTask(t *testing.T) {
	db := newTestBadger(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	task := seededRemotePublishTask("feed", "episode", model.RemotePublishSucceeded, now)
	require.NoError(t, db.seedRemotePublishTask(task))

	_, err := db.PrepareRemotePublishAttempt(ctx, task.ID, "key", "token", "audio/mpeg", now)
	require.Error(t, err)
}

func TestBadger_RetryRemotePublishTaskSchedulesBackoff(t *testing.T) {
	tests := []struct {
		attempts int
		delay    time.Duration
	}{
		{attempts: 1, delay: 0},
		{attempts: 2, delay: 0},
		{attempts: 3, delay: 0},
		{attempts: 4, delay: time.Hour},
		{attempts: 5, delay: 2 * time.Hour},
		{attempts: 6, delay: 4 * time.Hour},
		{attempts: 7, delay: 8 * time.Hour},
		{attempts: 8, delay: 16 * time.Hour},
		{attempts: 9, delay: 24 * time.Hour},
		{attempts: 100, delay: 24 * time.Hour},
	}

	for _, tt := range tests {
		t.Run(strings.ReplaceAll(tt.delay.String(), "0s", "immediate"), func(t *testing.T) {
			db := newTestBadger(t)
			ctx := context.Background()
			now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
			task := seededRemotePublishTask("feed", "episode", model.RemotePublishPending, now)
			task.Attempts = tt.attempts
			task.R2Key = "audio/feed/episode-token.mp3"
			task.AssetToken = "token"
			task.MimeType = "audio/mpeg"
			require.NoError(t, db.seedRemotePublishTask(task))

			require.NoError(t, db.RetryRemotePublishTask(ctx, task.ID, errors.New("upload failed"), now))

			got, err := db.GetRemotePublishTask(ctx, task.ID)
			require.NoError(t, err)
			assert.Equal(t, model.RemotePublishPending, got.Status)
			assert.Equal(t, "upload failed", got.LastError)
			assert.Equal(t, now.Add(tt.delay), got.NextAttemptAt)
			assert.Equal(t, task.R2Key, got.R2Key)
			assert.Equal(t, task.AssetToken, got.AssetToken)
			assert.Equal(t, task.MimeType, got.MimeType)
		})
	}
}

func TestBadger_DeferRemotePublishTaskRecordsBackoff(t *testing.T) {
	tests := []struct {
		name             string
		startingAttempts int
		wantAttempts     int
		wantDelay        time.Duration
	}{
		{name: "first", startingAttempts: 0, wantAttempts: 1, wantDelay: 0},
		{name: "fourth", startingAttempts: 3, wantAttempts: 4, wantDelay: time.Hour},
		{name: "capped", startingAttempts: 99, wantAttempts: 100, wantDelay: 24 * time.Hour},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := newTestBadger(t)
			ctx := context.Background()
			now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
			task := seededRemotePublishTask("feed", "episode", model.RemotePublishPending, now)
			task.Attempts = tt.startingAttempts
			require.NoError(t, db.seedRemotePublishTask(task))

			require.NoError(t, db.DeferRemotePublishTask(ctx, task.ID, errors.New("read failed"), now))

			got, err := db.GetRemotePublishTask(ctx, task.ID)
			require.NoError(t, err)
			assert.Equal(t, model.RemotePublishPending, got.Status)
			assert.Equal(t, tt.wantAttempts, got.Attempts)
			assert.Equal(t, "read failed", got.LastError)
			assert.Equal(t, now.Add(tt.wantDelay), got.NextAttemptAt)
			assert.Empty(t, got.R2Key)
			assert.Empty(t, got.AssetToken)
			assert.Empty(t, got.MimeType)
		})
	}
}

func TestBadger_FailRemotePublishTaskMarksTerminalFailure(t *testing.T) {
	db := newTestBadger(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	task := seededRemotePublishTask("feed", "episode", model.RemotePublishPending, now)
	require.NoError(t, db.seedRemotePublishTask(task))

	require.NoError(t, db.FailRemotePublishTask(ctx, task.ID, errors.New("missing media"), now))

	got, err := db.GetRemotePublishTask(ctx, task.ID)
	require.NoError(t, err)
	assert.Equal(t, model.RemotePublishFailed, got.Status)
	assert.Equal(t, "missing media", got.LastError)
	assert.True(t, got.NextAttemptAt.IsZero())
	due, err := db.DueRemotePublishTasks(ctx, now.Add(time.Hour), 10)
	require.NoError(t, err)
	assert.Empty(t, due)
}

func TestBadger_CompleteRemotePublishTaskMarksSucceeded(t *testing.T) {
	db := newTestBadger(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	task := seededRemotePublishTask("feed", "episode", model.RemotePublishPending, now)
	task.LastError = "old error"
	require.NoError(t, db.seedRemotePublishTask(task))

	require.NoError(t, db.CompleteRemotePublishTask(ctx, task.ID, now))

	got, err := db.GetRemotePublishTask(ctx, task.ID)
	require.NoError(t, err)
	assert.Equal(t, model.RemotePublishSucceeded, got.Status)
	assert.Empty(t, got.LastError)
	assert.True(t, got.NextAttemptAt.IsZero())
	assert.Equal(t, now, got.CompletedAt)
	assert.Equal(t, now, got.UpdatedAt)
}

func TestRemotePublishNextAttempt(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		attempts int
		want     time.Time
	}{
		{attempts: 1, want: now},
		{attempts: 2, want: now},
		{attempts: 3, want: now},
		{attempts: 4, want: now.Add(time.Hour)},
		{attempts: 5, want: now.Add(2 * time.Hour)},
		{attempts: 6, want: now.Add(4 * time.Hour)},
		{attempts: 7, want: now.Add(8 * time.Hour)},
		{attempts: 8, want: now.Add(16 * time.Hour)},
		{attempts: 9, want: now.Add(24 * time.Hour)},
		{attempts: 100, want: now.Add(24 * time.Hour)},
	}

	for _, tt := range tests {
		assert.Equal(t, tt.want, model.RemotePublishNextAttempt(now, tt.attempts))
	}
}

func TestBadger_EnqueueRemotePublishTaskValidatesRequiredFields(t *testing.T) {
	db := newTestBadger(t)
	ctx := context.Background()

	tests := []struct {
		name string
		task *model.RemotePublishTask
		want string
	}{
		{
			name: "feed id",
			task: &model.RemotePublishTask{LocalEpisodeID: "episode", MediaPath: "feed/episode.mp3"},
			want: "feed_id",
		},
		{
			name: "local episode id",
			task: &model.RemotePublishTask{FeedID: "feed", MediaPath: "feed/episode.mp3"},
			want: "local_episode_id",
		},
		{
			name: "media path",
			task: &model.RemotePublishTask{FeedID: "feed", LocalEpisodeID: "episode"},
			want: "media_path",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := db.EnqueueRemotePublishTask(ctx, tt.task)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.want)
		})
	}
}

func newTestBadger(t *testing.T) *Badger {
	t.Helper()

	db, err := NewBadger(&Config{Dir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, db.Close())
	})
	return db
}

func newRemotePublishTask(feedID, episodeID string) *model.RemotePublishTask {
	return &model.RemotePublishTask{
		FeedID:         feedID,
		LocalEpisodeID: episodeID,
		MediaPath:      feedID + "/" + episodeID + ".mp3",
		Size:           123,
		Title:          "Episode " + episodeID,
		SourceURL:      "https://example.com/" + episodeID,
		PublishedAt:    time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC),
	}
}

func seededRemotePublishTask(feedID, episodeID string, status model.RemotePublishStatus, nextAttempt time.Time) *model.RemotePublishTask {
	task := newRemotePublishTask(feedID, episodeID)
	task.ID = model.RemotePublishTaskID(feedID, episodeID)
	task.Status = status
	task.NextAttemptAt = nextAttempt
	task.CreatedAt = time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	task.UpdatedAt = task.CreatedAt
	return task
}

func (b *Badger) seedRemotePublishTask(task *model.RemotePublishTask) error {
	return b.db.Update(func(txn *badger.Txn) error {
		return b.setObj(txn, b.getKey(remotePublishTaskPath, task.ID), task, true)
	})
}
