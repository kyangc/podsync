package remote

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

type mockR2RecoveryAPI struct {
	body          string
	headSize      int64
	headCount     int
	getCount      int
	recoveryError error
}

func (m *mockR2RecoveryAPI) HeadObject(_ context.Context, _ *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	m.headCount++
	if m.recoveryError != nil {
		return nil, m.recoveryError
	}
	return &s3.HeadObjectOutput{ContentLength: aws.Int64(m.headSize)}, nil
}

func (m *mockR2RecoveryAPI) GetObject(_ context.Context, _ *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	m.getCount++
	if m.recoveryError != nil {
		return nil, m.recoveryError
	}
	return &s3.GetObjectOutput{
		Body:          io.NopCloser(strings.NewReader(m.body)),
		ContentLength: aws.Int64(int64(len(m.body))),
	}, nil
}

func TestR2SourceRestorerDryRunHeadsWithoutWriting(t *testing.T) {
	root := t.TempDir()
	api := &mockR2RecoveryAPI{body: "audio", headSize: 5}
	restorer, err := NewR2SourceRestorerWithAPI(api, "bucket", root)
	require.NoError(t, err)
	task := &model.RemotePublishTask{MediaPath: "feed/episode.mp3", R2Key: "audio/feed/episode.mp3", Size: 5}

	require.NoError(t, restorer.Restore(context.Background(), task, true))

	assert.Equal(t, 1, api.headCount)
	assert.Equal(t, 0, api.getCount)
	_, statErr := os.Stat(filepath.Join(root, "feed", "episode.mp3"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestR2SourceRestorerDownloadsAtomicallyAndIsIdempotent(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "feed"), 0755))
	api := &mockR2RecoveryAPI{body: "audio", headSize: 5}
	restorer, err := NewR2SourceRestorerWithAPI(api, "bucket", root)
	require.NoError(t, err)
	task := &model.RemotePublishTask{MediaPath: "feed/episode.mp3", R2Key: "audio/feed/episode.mp3", Size: 5}

	require.NoError(t, restorer.Restore(context.Background(), task, false))
	require.NoError(t, restorer.Restore(context.Background(), task, false))

	assert.Equal(t, 0, api.headCount)
	assert.Equal(t, 1, api.getCount)
	restored, readErr := os.ReadFile(filepath.Join(root, "feed", "episode.mp3"))
	require.NoError(t, readErr)
	assert.Equal(t, []byte("audio"), restored)
	assert.Empty(t, findRecoveryTemps(t, filepath.Join(root, "feed")))
}

func TestR2SourceRestorerFailsClosedOnSizeMismatchAndUnsafePath(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "feed"), 0755))
	api := &mockR2RecoveryAPI{body: "short", headSize: 5}
	restorer, err := NewR2SourceRestorerWithAPI(api, "bucket", root)
	require.NoError(t, err)

	err = restorer.Restore(context.Background(), &model.RemotePublishTask{
		MediaPath: "feed/episode.mp3", R2Key: "audio/feed/episode.mp3", Size: 6,
	}, true)
	require.ErrorIs(t, err, ErrHardlinkSourceSizeMismatch)

	err = restorer.Restore(context.Background(), &model.RemotePublishTask{
		MediaPath: "../outside.mp3", R2Key: "audio/feed/episode.mp3", Size: 5,
	}, false)
	require.ErrorIs(t, err, ErrUnsafeMediaPath)
	_, statErr := os.Stat(filepath.Join(filepath.Dir(root), "outside.mp3"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestR2SourceRestorerRejectsSymlinkParentBeforeCreatingDirectories(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	require.NoError(t, os.Symlink(outside, filepath.Join(root, "feed")))
	api := &mockR2RecoveryAPI{body: "audio", headSize: 5}
	restorer, err := NewR2SourceRestorerWithAPI(api, "bucket", root)
	require.NoError(t, err)

	err = restorer.Restore(context.Background(), &model.RemotePublishTask{
		MediaPath: "feed/nested/episode.mp3", R2Key: "audio/feed/episode.mp3", Size: 5,
	}, false)

	require.ErrorIs(t, err, ErrUnsafeMediaPath)
	_, statErr := os.Stat(filepath.Join(outside, "nested"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
	assert.Equal(t, 0, api.getCount)
}

func TestR2SourceRestorerPropagatesRemoteFailure(t *testing.T) {
	root := t.TempDir()
	api := &mockR2RecoveryAPI{recoveryError: errors.New("r2 unavailable")}
	restorer, err := NewR2SourceRestorerWithAPI(api, "bucket", root)
	require.NoError(t, err)

	err = restorer.Restore(context.Background(), &model.RemotePublishTask{
		MediaPath: "feed/episode.mp3", R2Key: "audio/feed/episode.mp3", Size: 5,
	}, true)

	require.ErrorContains(t, err, "r2 unavailable")
}

func findRecoveryTemps(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ".podsync-r2-recovery-*"))
	require.NoError(t, err)
	return matches
}
