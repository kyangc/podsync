package remote

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	poddb "github.com/mxpv/podsync/pkg/db"
	"github.com/mxpv/podsync/pkg/model"
)

func TestProcessorUploadsDueTaskAndMarksSucceeded(t *testing.T) {
	root := t.TempDir()
	task := newProcessorTask("feed", "episode")
	writeProcessorMedia(t, root, task.MediaPath, []byte("audio bytes"))
	outbox := &fakeOutbox{due: []*model.RemotePublishTask{task}}
	publisher := &fakeProcessorPublisher{}
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	processor := &Processor{
		Outbox:    outbox,
		Publisher: publisher,
		Store:     LocalMediaStore{Root: root},
		Prefix:    "audio",
		Now:       func() time.Time { return now },
	}

	err := processor.ProcessDue(context.Background())

	require.NoError(t, err)
	require.Len(t, outbox.prepared, 1)
	prepared := outbox.prepared[0]
	assert.NotEmpty(t, prepared.R2Key)
	assert.NotEmpty(t, prepared.AssetToken)
	assert.NotEmpty(t, prepared.MimeType)
	assert.Equal(t, 1, prepared.Attempts)
	assert.Equal(t, []string{task.ID}, outbox.completed)
	require.Len(t, publisher.uploads, 1)
	assert.Equal(t, prepared.R2Key, publisher.uploads[0].R2Key)
}

func TestProcessorRetriesUploadFailure(t *testing.T) {
	root := t.TempDir()
	task := newProcessorTask("feed", "episode")
	writeProcessorMedia(t, root, task.MediaPath, []byte("audio bytes"))
	outbox := &fakeOutbox{due: []*model.RemotePublishTask{task}}
	publisher := &fakeProcessorPublisher{failIDs: map[string]error{task.ID: errors.New("put failed")}}
	processor := &Processor{
		Outbox:    outbox,
		Publisher: publisher,
		Store:     LocalMediaStore{Root: root},
	}

	err := processor.ProcessDue(context.Background())

	require.NoError(t, err)
	assert.Equal(t, []string{task.ID}, outbox.retried)
	assert.Empty(t, outbox.completed)
}

func TestProcessorMarksMissingMediaAsFailed(t *testing.T) {
	task := newProcessorTask("feed", "episode")
	outbox := &fakeOutbox{due: []*model.RemotePublishTask{task}}
	publisher := &fakeProcessorPublisher{}
	processor := &Processor{
		Outbox:    outbox,
		Publisher: publisher,
		Store:     LocalMediaStore{Root: t.TempDir()},
	}

	err := processor.ProcessDue(context.Background())

	require.NoError(t, err)
	assert.Equal(t, []string{task.ID}, outbox.failed)
	assert.Empty(t, publisher.uploads)
}

func TestProcessorMarksUnsafeMediaPathAsFailed(t *testing.T) {
	tests := []string{
		"/abs",
		"../x",
		"a/../../x",
	}

	for _, mediaPath := range tests {
		t.Run(mediaPath, func(t *testing.T) {
			task := newProcessorTask("feed", "episode")
			task.MediaPath = mediaPath
			outbox := &fakeOutbox{due: []*model.RemotePublishTask{task}}
			publisher := &fakeProcessorPublisher{}
			processor := &Processor{
				Outbox:    outbox,
				Publisher: publisher,
				Store:     LocalMediaStore{Root: t.TempDir()},
			}

			err := processor.ProcessDue(context.Background())

			require.NoError(t, err)
			assert.Equal(t, []string{task.ID}, outbox.failed)
			assert.Empty(t, publisher.uploads)
		})
	}
}

func TestProcessorRecordsOpenErrorAsRetryable(t *testing.T) {
	task := newProcessorTask("feed", "episode")
	outbox := &fakeOutbox{due: []*model.RemotePublishTask{task}}
	publisher := &fakeProcessorPublisher{}
	openErr := errors.New("permission denied")
	processor := &Processor{
		Outbox:    outbox,
		Publisher: publisher,
		Store:     errorMediaStore{err: openErr},
	}

	err := processor.ProcessDue(context.Background())

	require.NoError(t, err)
	assert.Equal(t, []string{task.ID}, outbox.deferred)
	require.Len(t, outbox.deferErrors, 1)
	assert.Equal(t, openErr, outbox.deferErrors[0])
	assert.Empty(t, outbox.retried)
	assert.Empty(t, outbox.failed)
	assert.Empty(t, publisher.uploads)
}

func TestProcessorRecordsMimeDetectionErrorAsRetryable(t *testing.T) {
	task := newProcessorTask("feed", "episode")
	outbox := &fakeOutbox{due: []*model.RemotePublishTask{task}}
	publisher := &fakeProcessorPublisher{}
	readErr := errors.New("read failed")
	processor := &Processor{
		Outbox:    outbox,
		Publisher: publisher,
		Store:     staticMediaStore{reader: &errorReadSeekCloser{readErr: readErr}},
	}

	err := processor.ProcessDue(context.Background())

	require.NoError(t, err)
	assert.Equal(t, []string{task.ID}, outbox.deferred)
	require.Len(t, outbox.deferErrors, 1)
	assert.Equal(t, readErr, outbox.deferErrors[0])
	assert.Empty(t, outbox.retried)
	assert.Empty(t, outbox.failed)
	assert.Empty(t, publisher.uploads)
}

func TestProcessorRecordsPreUploadErrorInBadger(t *testing.T) {
	ctx := context.Background()
	database, err := poddb.NewBadger(&poddb.Config{Dir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, database.Close())
	})
	task := newProcessorTask("feed", "episode")
	require.NoError(t, database.EnqueueRemotePublishTask(ctx, task))
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	processor := &Processor{
		Outbox:    database,
		Publisher: &fakeProcessorPublisher{},
		Store:     errorMediaStore{err: errors.New("permission denied")},
		Limit:     10,
		Now:       func() time.Time { return now },
	}

	err = processor.ProcessDue(ctx)

	require.NoError(t, err)
	got, err := database.GetRemotePublishTask(ctx, task.ID)
	require.NoError(t, err)
	assert.Equal(t, model.RemotePublishPending, got.Status)
	assert.Equal(t, 1, got.Attempts)
	assert.Equal(t, "permission denied", got.LastError)
	assert.Equal(t, now, got.NextAttemptAt)
	assert.Empty(t, got.R2Key)
	assert.Empty(t, got.AssetToken)
	assert.Empty(t, got.MimeType)
}

func TestProcessorContinuesAfterTaskFailure(t *testing.T) {
	root := t.TempDir()
	first := newProcessorTask("feed", "first")
	second := newProcessorTask("feed", "second")
	writeProcessorMedia(t, root, first.MediaPath, []byte("first audio"))
	writeProcessorMedia(t, root, second.MediaPath, []byte("second audio"))
	outbox := &fakeOutbox{due: []*model.RemotePublishTask{first, second}}
	publisher := &fakeProcessorPublisher{failIDs: map[string]error{first.ID: errors.New("put failed")}}
	processor := &Processor{
		Outbox:    outbox,
		Publisher: publisher,
		Store:     LocalMediaStore{Root: root},
	}

	err := processor.ProcessDue(context.Background())

	require.NoError(t, err)
	assert.Equal(t, []string{first.ID}, outbox.retried)
	assert.Equal(t, []string{second.ID}, outbox.completed)
	require.Len(t, publisher.uploads, 2)
	assert.Equal(t, second.ID, publisher.uploads[1].ID)
}

func TestProcessorReusesPersistedR2Key(t *testing.T) {
	root := t.TempDir()
	task := newProcessorTask("feed", "episode")
	task.AssetToken = "existing-token"
	task.R2Key = "audio/feed/episode-existing-token.mp3"
	writeProcessorMedia(t, root, task.MediaPath, []byte("audio bytes"))
	outbox := &fakeOutbox{due: []*model.RemotePublishTask{task}}
	processor := &Processor{
		Outbox:    outbox,
		Publisher: &fakeProcessorPublisher{},
		Store:     LocalMediaStore{Root: root},
	}

	err := processor.ProcessDue(context.Background())

	require.NoError(t, err)
	require.Len(t, outbox.prepared, 1)
	assert.Equal(t, "existing-token", outbox.prepared[0].AssetToken)
	assert.Equal(t, "audio/feed/episode-existing-token.mp3", outbox.prepared[0].R2Key)
}

func TestProcessorWithBadgerLocalStoreAndMockPublisher(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	database, err := poddb.NewBadger(&poddb.Config{Dir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, database.Close())
	})
	task := newProcessorTask("feed", "episode")
	writeProcessorMedia(t, root, task.MediaPath, []byte("audio bytes"))
	require.NoError(t, database.EnqueueRemotePublishTask(ctx, task))
	processor := &Processor{
		Outbox:    database,
		Publisher: &fakeProcessorPublisher{},
		Store:     LocalMediaStore{Root: root},
		Prefix:    "audio",
		Limit:     10,
		Now:       func() time.Time { return time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC) },
	}

	err = processor.ProcessDue(ctx)

	require.NoError(t, err)
	got, err := database.GetRemotePublishTask(ctx, task.ID)
	require.NoError(t, err)
	assert.Equal(t, model.RemotePublishSucceeded, got.Status)
	assert.NotEmpty(t, got.R2Key)
	assert.NotEmpty(t, got.AssetToken)
	assert.NotEmpty(t, got.MimeType)
	assert.NotZero(t, got.CompletedAt)
}

type fakeOutbox struct {
	due         []*model.RemotePublishTask
	prepared    []*model.RemotePublishTask
	completed   []string
	retried     []string
	retryErrors []error
	deferred    []string
	deferErrors []error
	failed      []string
}

func (o *fakeOutbox) DueRemotePublishTasks(_ context.Context, _ time.Time, _ int) ([]*model.RemotePublishTask, error) {
	return o.due, nil
}

func (o *fakeOutbox) PrepareRemotePublishAttempt(_ context.Context, id string, r2Key string, assetToken string, mimeType string, now time.Time) (*model.RemotePublishTask, error) {
	for _, task := range o.due {
		if task.ID != id {
			continue
		}
		prepared := *task
		prepared.R2Key = r2Key
		prepared.AssetToken = assetToken
		prepared.MimeType = mimeType
		prepared.Attempts++
		prepared.UpdatedAt = now
		o.prepared = append(o.prepared, &prepared)
		return &prepared, nil
	}
	return nil, model.ErrNotFound
}

func (o *fakeOutbox) CompleteRemotePublishTask(_ context.Context, id string, _ time.Time) error {
	o.completed = append(o.completed, id)
	return nil
}

func (o *fakeOutbox) RetryRemotePublishTask(_ context.Context, id string, cause error, _ time.Time) error {
	o.retried = append(o.retried, id)
	o.retryErrors = append(o.retryErrors, cause)
	return nil
}

func (o *fakeOutbox) DeferRemotePublishTask(_ context.Context, id string, cause error, _ time.Time) error {
	o.deferred = append(o.deferred, id)
	o.deferErrors = append(o.deferErrors, cause)
	return nil
}

func (o *fakeOutbox) FailRemotePublishTask(_ context.Context, id string, _ error, _ time.Time) error {
	o.failed = append(o.failed, id)
	return nil
}

type fakeProcessorPublisher struct {
	failIDs map[string]error
	uploads []*model.RemotePublishTask
	bodies  [][]byte
}

type errorMediaStore struct {
	err error
}

func (s errorMediaStore) Open(string) (ReadSeekCloser, error) {
	return nil, s.err
}

type staticMediaStore struct {
	reader ReadSeekCloser
}

func (s staticMediaStore) Open(string) (ReadSeekCloser, error) {
	return s.reader, nil
}

type errorReadSeekCloser struct {
	readErr error
}

func (r *errorReadSeekCloser) Read([]byte) (int, error) {
	return 0, r.readErr
}

func (r *errorReadSeekCloser) Seek(int64, int) (int64, error) {
	return 0, nil
}

func (r *errorReadSeekCloser) Close() error {
	return nil
}

func (p *fakeProcessorPublisher) Upload(_ context.Context, task *model.RemotePublishTask, reader io.ReadSeeker) error {
	body, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	cloned := *task
	p.uploads = append(p.uploads, &cloned)
	p.bodies = append(p.bodies, body)
	if p.failIDs != nil && p.failIDs[task.ID] != nil {
		return p.failIDs[task.ID]
	}
	return nil
}

func newProcessorTask(feedID, episodeID string) *model.RemotePublishTask {
	return &model.RemotePublishTask{
		ID:             model.RemotePublishTaskID(feedID, episodeID),
		FeedID:         feedID,
		LocalEpisodeID: episodeID,
		MediaPath:      feedID + "/" + episodeID + ".mp3",
		Size:           11,
		Title:          "Episode " + episodeID,
		SourceURL:      "https://example.com/" + episodeID,
		PublishedAt:    time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC),
		Status:         model.RemotePublishPending,
	}
}

func writeProcessorMedia(t *testing.T, root string, name string, data []byte) {
	t.Helper()

	path := filepath.Join(root, name)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
	require.NoError(t, os.WriteFile(path, data, 0644))
}
