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

type stubMissingSourceRestorer struct {
	sourceRoot string
	body       []byte
	err        error
	calls      int
	dryRuns    []bool
}

func (r *stubMissingSourceRestorer) Restore(_ context.Context, task *model.RemotePublishTask, dryRun bool) error {
	r.calls++
	r.dryRuns = append(r.dryRuns, dryRun)
	if r.err != nil || dryRun {
		return r.err
	}
	path := filepath.Join(r.sourceRoot, filepath.FromSlash(task.MediaPath))
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, r.body, 0644)
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
		AllowedKeys: map[string]struct{}{
			"audio/feed/one-token.mp3": {},
			"audio/feed/two-token.mp3": {},
		},
		DryRun: true,
	}).Run(context.Background())

	require.NoError(t, err)
	assert.Equal(t, HardlinkBackfillResult{Scanned: 2, Selected: 2, AlreadyLinked: 1, WouldLink: 1}, result)
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
		AllowedKeys: map[string]struct{}{
			"audio/feed/one-token.mp3":     {},
			"audio/feed/missing-token.mp3": {},
		},
	}).Run(context.Background())

	require.Error(t, err)
	assert.Equal(t, HardlinkBackfillResult{Scanned: 2, Selected: 2, Linked: 1, Failed: 1, MissingSource: 1}, result)
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
		Tasks:       &stubRemotePublishTaskWalker{err: wantErr},
		Publisher:   publisher,
		AllowedKeys: map[string]struct{}{},
	}).Run(context.Background())

	require.ErrorIs(t, err, wantErr)
	assert.Equal(t, HardlinkBackfillResult{}, result)
}

func TestHardlinkBackfillReportsFailureCategoriesWithoutKeys(t *testing.T) {
	sourceRoot := t.TempDir()
	publicRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(sourceRoot, "feed"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(sourceRoot, "feed", "episode.mp3"), []byte("audio"), 0644))
	require.NoError(t, os.MkdirAll(filepath.Join(publicRoot, "audio", "feed"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(publicRoot, "audio", "feed", "conflict.mp3"), []byte("other"), 0644))

	publisher, err := NewHardlinkPublisher(sourceRoot, publicRoot)
	require.NoError(t, err)
	tasks := []*model.RemotePublishTask{
		{Status: model.RemotePublishSucceeded, MediaPath: "feed/episode.mp3", R2Key: "audio/feed/size.mp3", Size: 4},
		{Status: model.RemotePublishSucceeded, MediaPath: "feed/episode.mp3", R2Key: "../unsafe.mp3", Size: 5},
		{Status: model.RemotePublishSucceeded, MediaPath: "feed/episode.mp3", R2Key: "audio/feed/conflict.mp3", Size: 5},
	}
	result, err := (&HardlinkBackfill{
		Tasks:     &stubRemotePublishTaskWalker{tasks: tasks},
		Publisher: publisher,
		AllowedKeys: map[string]struct{}{
			"audio/feed/size.mp3":     {},
			"../unsafe.mp3":           {},
			"audio/feed/conflict.mp3": {},
		},
		DryRun: true,
	}).Run(context.Background())

	require.Error(t, err)
	assert.Equal(t, HardlinkBackfillResult{
		Scanned: 3, Selected: 3, Failed: 3, SizeMismatch: 1, UnsafePath: 1, ConflictingTarget: 1,
	}, result)
}

func TestHardlinkBackfillDryRunChecksRecoverableMissingSourcesWithoutWriting(t *testing.T) {
	sourceRoot := t.TempDir()
	publicRoot := t.TempDir()
	publisher, err := NewHardlinkPublisher(sourceRoot, publicRoot)
	require.NoError(t, err)
	restorer := &stubMissingSourceRestorer{sourceRoot: sourceRoot, body: []byte("audio")}
	task := &model.RemotePublishTask{
		Status: model.RemotePublishSucceeded, MediaPath: "feed/missing.mp3", R2Key: "audio/feed/missing.mp3", Size: 5,
	}

	result, err := (&HardlinkBackfill{
		Tasks:                 &stubRemotePublishTaskWalker{tasks: []*model.RemotePublishTask{task}},
		Publisher:             publisher,
		AllowedKeys:           map[string]struct{}{task.R2Key: {}},
		MissingSourceRestorer: restorer,
		DryRun:                true,
	}).Run(context.Background())

	require.NoError(t, err)
	assert.Equal(t, HardlinkBackfillResult{
		Scanned: 1, Selected: 1, MissingSource: 1, WouldRecoverSource: 1,
	}, result)
	assert.Equal(t, []bool{true}, restorer.dryRuns)
	_, statErr := os.Stat(filepath.Join(sourceRoot, "feed", "missing.mp3"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestHardlinkBackfillRecoversMissingSourceThenLinksIt(t *testing.T) {
	sourceRoot := t.TempDir()
	publicRoot := t.TempDir()
	publisher, err := NewHardlinkPublisher(sourceRoot, publicRoot)
	require.NoError(t, err)
	body := []byte("audio")
	restorer := &stubMissingSourceRestorer{sourceRoot: sourceRoot, body: body}
	task := &model.RemotePublishTask{
		Status: model.RemotePublishSucceeded, MediaPath: "feed/missing.mp3", R2Key: "audio/feed/missing.mp3", Size: int64(len(body)),
	}

	result, err := (&HardlinkBackfill{
		Tasks:                 &stubRemotePublishTaskWalker{tasks: []*model.RemotePublishTask{task}},
		Publisher:             publisher,
		AllowedKeys:           map[string]struct{}{task.R2Key: {}},
		MissingSourceRestorer: restorer,
	}).Run(context.Background())

	require.NoError(t, err)
	assert.Equal(t, HardlinkBackfillResult{
		Scanned: 1, Selected: 1, Linked: 1, MissingSource: 1, RecoveredSource: 1,
	}, result)
	assert.Equal(t, []bool{false}, restorer.dryRuns)
	sourceInfo, statErr := os.Stat(filepath.Join(sourceRoot, "feed", "missing.mp3"))
	require.NoError(t, statErr)
	targetInfo, statErr := os.Stat(filepath.Join(publicRoot, "audio", "feed", "missing.mp3"))
	require.NoError(t, statErr)
	assert.True(t, os.SameFile(sourceInfo, targetInfo))
}

func TestHardlinkBackfillReportsMissingSourceRecoveryFailure(t *testing.T) {
	sourceRoot := t.TempDir()
	publisher, err := NewHardlinkPublisher(sourceRoot, t.TempDir())
	require.NoError(t, err)
	task := &model.RemotePublishTask{
		Status: model.RemotePublishSucceeded, MediaPath: "feed/missing.mp3", R2Key: "audio/feed/missing.mp3", Size: 5,
	}
	restorer := &stubMissingSourceRestorer{err: errors.New("r2 unavailable")}

	result, err := (&HardlinkBackfill{
		Tasks:                 &stubRemotePublishTaskWalker{tasks: []*model.RemotePublishTask{task}},
		Publisher:             publisher,
		AllowedKeys:           map[string]struct{}{task.R2Key: {}},
		MissingSourceRestorer: restorer,
		DryRun:                true,
	}).Run(context.Background())

	require.Error(t, err)
	assert.Equal(t, HardlinkBackfillResult{
		Scanned: 1, Selected: 1, Failed: 1, MissingSource: 1, OtherFailure: 1, RecoveryFailed: 1,
	}, result)
}

func TestHardlinkBackfillOnlyPublishesAllowedKeys(t *testing.T) {
	sourceRoot := t.TempDir()
	publicRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(sourceRoot, "feed"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(sourceRoot, "feed", "retained.mp3"), []byte("keep"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(sourceRoot, "feed", "purged.mp3"), []byte("drop"), 0644))

	publisher, err := NewHardlinkPublisher(sourceRoot, publicRoot)
	require.NoError(t, err)
	result, err := (&HardlinkBackfill{
		Tasks: &stubRemotePublishTaskWalker{tasks: []*model.RemotePublishTask{
			{Status: model.RemotePublishSucceeded, MediaPath: "feed/retained.mp3", R2Key: "audio/feed/retained.mp3", Size: 4},
			{Status: model.RemotePublishSucceeded, MediaPath: "feed/purged.mp3", R2Key: "audio/feed/purged.mp3", Size: 4},
		}},
		Publisher: publisher,
		AllowedKeys: map[string]struct{}{
			"audio/feed/retained.mp3": {},
		},
	}).Run(context.Background())

	require.NoError(t, err)
	assert.Equal(t, HardlinkBackfillResult{Scanned: 2, Selected: 1, Skipped: 1, Linked: 1}, result)
	_, statErr := os.Stat(filepath.Join(publicRoot, "audio", "feed", "purged.mp3"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestHardlinkBackfillFailsWhenAllowedKeyHasNoSucceededTask(t *testing.T) {
	publisher, err := NewHardlinkPublisher(t.TempDir(), t.TempDir())
	require.NoError(t, err)
	result, err := (&HardlinkBackfill{
		Tasks:       &stubRemotePublishTaskWalker{},
		Publisher:   publisher,
		AllowedKeys: map[string]struct{}{"audio/feed/missing.mp3": {}},
		DryRun:      true,
	}).Run(context.Background())

	require.ErrorContains(t, err, "allowed key")
	assert.Equal(t, HardlinkBackfillResult{MissingTasks: 1}, result)
}

func TestHardlinkBackfillRequiresAllowedKeys(t *testing.T) {
	publisher, err := NewHardlinkPublisher(t.TempDir(), t.TempDir())
	require.NoError(t, err)
	_, err = (&HardlinkBackfill{
		Tasks:     &stubRemotePublishTaskWalker{},
		Publisher: publisher,
	}).Run(context.Background())

	require.ErrorContains(t, err, "allowed keys")
}
