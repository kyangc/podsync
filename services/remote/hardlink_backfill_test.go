package remote

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

type stubRemotePublishTaskWalker struct {
	tasks []*model.RemotePublishTask
	err   error
}

func (w *stubRemotePublishTaskWalker) WalkRemotePublishTasks(_ context.Context, status model.RemotePublishStatus, cb func(*model.RemotePublishTask) error) error {
	if w.err != nil {
		return w.err
	}
	for _, task := range w.tasks {
		if task.Status == status {
			if err := cb(task); err != nil {
				return err
			}
		}
	}
	return nil
}

func TestHardlinkBackfillDryRunReportsWorkWithoutWriting(t *testing.T) {
	sourceRoot := t.TempDir()
	publicRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(sourceRoot, "feed"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(sourceRoot, "feed", "one.mp3"), []byte("one"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(sourceRoot, "feed", "two.mp3"), []byte("two"), 0644))
	require.NoError(t, os.MkdirAll(filepath.Join(publicRoot, "audio", "feed"), 0755))
	require.NoError(t, os.Link(
		filepath.Join(sourceRoot, "feed", "one.mp3"),
		filepath.Join(publicRoot, "audio", "feed", "one-token.mp3"),
	))

	publisher, err := NewHardlinkPublisher(sourceRoot, publicRoot)
	require.NoError(t, err)
	result, err := (&HardlinkBackfill{
		Tasks: &stubRemotePublishTaskWalker{tasks: []*model.RemotePublishTask{
			{Status: model.RemotePublishSucceeded, MediaPath: "feed/one.mp3", R2Key: "audio/feed/one-token.mp3", Size: 3},
			{Status: model.RemotePublishSucceeded, MediaPath: "feed/two.mp3", R2Key: "audio/feed/two-token.mp3", Size: 3},
		}},
		Publisher: publisher,
		DryRun:    true,
	}).Run(context.Background())

	require.NoError(t, err)
	assert.Equal(t, HardlinkBackfillResult{Scanned: 2, AlreadyLinked: 1, WouldLink: 1}, result)
	_, statErr := os.Stat(filepath.Join(publicRoot, "audio", "feed", "two-token.mp3"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestHardlinkBackfillLinksValidTasksAndReportsIncompleteWork(t *testing.T) {
	sourceRoot := t.TempDir()
	publicRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(sourceRoot, "feed"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(sourceRoot, "feed", "one.mp3"), []byte("one"), 0644))

	publisher, err := NewHardlinkPublisher(sourceRoot, publicRoot)
	require.NoError(t, err)
	result, err := (&HardlinkBackfill{
		Tasks: &stubRemotePublishTaskWalker{tasks: []*model.RemotePublishTask{
			{Status: model.RemotePublishSucceeded, MediaPath: "feed/one.mp3", R2Key: "audio/feed/one-token.mp3", Size: 3},
			{Status: model.RemotePublishSucceeded, MediaPath: "feed/missing.mp3", R2Key: "audio/feed/missing-token.mp3", Size: 7},
		}},
		Publisher: publisher,
	}).Run(context.Background())

	require.Error(t, err)
	assert.Equal(t, HardlinkBackfillResult{Scanned: 2, Linked: 1, Failed: 1}, result)
	sourceInfo, statErr := os.Stat(filepath.Join(sourceRoot, "feed", "one.mp3"))
	require.NoError(t, statErr)
	targetInfo, statErr := os.Stat(filepath.Join(publicRoot, "audio", "feed", "one-token.mp3"))
	require.NoError(t, statErr)
	assert.True(t, os.SameFile(sourceInfo, targetInfo))
}

func TestHardlinkBackfillReturnsWalkerError(t *testing.T) {
	wantErr := errors.New("walk failed")
	publisher, publisherErr := NewHardlinkPublisher(t.TempDir(), t.TempDir())
	require.NoError(t, publisherErr)
	result, err := (&HardlinkBackfill{
		Tasks:     &stubRemotePublishTaskWalker{err: wantErr},
		Publisher: publisher,
	}).Run(context.Background())

	require.ErrorIs(t, err, wantErr)
	assert.Equal(t, HardlinkBackfillResult{}, result)
}
