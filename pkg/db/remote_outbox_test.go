package db

import (
	"context"
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

func (b *Badger) seedRemotePublishTask(task *model.RemotePublishTask) error {
	return b.db.Update(func(txn *badger.Txn) error {
		return b.setObj(txn, b.getKey(remotePublishTaskPath, task.ID), task, true)
	})
}
