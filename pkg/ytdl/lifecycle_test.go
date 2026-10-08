package ytdl

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func commandFixture(t *testing.T, script string) *YoutubeDl {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell downloader fixture requires POSIX")
	}
	path := filepath.Join(t.TempDir(), "youtube-dl")
	require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0700))
	return &YoutubeDl{path: path, timeout: time.Second}
}

func TestDownloadPreservesProcessCancellation(t *testing.T) {
	dl := commandFixture(t, "exit 0\n")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reader, err := dl.Download(ctx, &feed.Config{Format: model.FormatAudio}, &model.Episode{ID: "episode"})
	assert.Nil(t, reader)
	require.ErrorIs(t, err, context.Canceled)
	assert.Contains(t, err.Error(), "context canceled")
}

func TestCanceledCommandsDoNotWaitForDownloaderLock(t *testing.T) {
	for _, operation := range []string{"download", "playlist", "update"} {
		t.Run(operation, func(t *testing.T) {
			dl := &YoutubeDl{path: "unused", timeout: time.Second}
			require.NoError(t, dl.updateLock.Lock(context.Background()))
			defer dl.updateLock.Unlock()
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			done := make(chan error, 1)
			go func() {
				var err error
				switch operation {
				case "download":
					_, err = dl.Download(ctx, &feed.Config{Format: model.FormatAudio}, &model.Episode{ID: "episode"})
				case "playlist":
					_, err = dl.PlaylistMetadata(ctx, "https://example.invalid/playlist")
				case "update":
					err = dl.Update(ctx)
				}
				done <- err
			}()
			select {
			case err := <-done:
				require.ErrorIs(t, err, context.Canceled)
			case <-time.After(150 * time.Millisecond):
				t.Error("canceled operation is still waiting for the downloader lock")
			}
		})
	}
}

func TestQueuedDownloadRecordsWaitAndCancellation(t *testing.T) {
	dl := &YoutubeDl{path: "unused", timeout: time.Second}
	require.NoError(t, dl.updateLock.Lock(context.Background()))
	defer dl.updateLock.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := dl.Download(ctx, &feed.Config{Format: model.FormatAudio}, &model.Episode{ID: "episode"})
	require.ErrorIs(t, err, context.DeadlineExceeded)
	fields := err.(SummaryProvider).DownloadSummary().LogFields()
	assert.Equal(t, "queued", fields["last_stage"])
	assert.GreaterOrEqual(t, fields["queue_wait_ms"], int64(50))
	assert.Equal(t, int64(0), fields["attempt_elapsed_ms"])
}

func TestCommandCancellationDoesNotWaitForChildPipe(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ready")
	t.Setenv("PODSYNC_TEST_CHILD_READY", marker)
	dl := commandFixture(t, `sleep 2 &
printf 'ready\n'
: > "$PODSYNC_TEST_CHILD_READY"
wait
`)
	dl.timeout = 10 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := dl.exec(ctx); done <- err }()
	require.Eventually(t, func() bool { _, err := os.Stat(marker); return err == nil }, 2*time.Second, 5*time.Millisecond)
	cancel()
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(time.Second):
		t.Error("command cancellation still waits for the child's inherited pipe")
	}
}

func TestDownloadExplainsSilentProcessFailure(t *testing.T) {
	dl := commandFixture(t, "exit 1\n")
	reader, err := dl.Download(context.Background(), &feed.Config{Format: model.FormatAudio}, &model.Episode{ID: "episode"})
	assert.Nil(t, reader)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exit status 1")
	var exitError *exec.ExitError
	require.ErrorAs(t, err, &exitError)
	assert.Equal(t, 1, exitError.ExitCode())
}

func TestDownloadPreservesTimeoutAlongsideExtractorOutput(t *testing.T) {
	dl := commandFixture(t, "printf '[youtube] WARNING: The handshake operation timed out\\n'\nexec sleep 30\n")
	dl.timeout = 2 * time.Second
	reader, err := dl.Download(context.Background(), &feed.Config{Format: model.FormatAudio}, &model.Episode{ID: "episode"})
	assert.Nil(t, reader)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Contains(t, err.Error(), "The handshake operation timed out")
	assert.Contains(t, err.Error(), "context deadline exceeded")
	fields := err.(SummaryProvider).DownloadSummary().LogFields()
	assert.Equal(t, "extract", fields["last_stage"])
	assert.GreaterOrEqual(t, fields["attempt_elapsed_ms"], int64(2000))
}

func TestAutoUpdateStopsWhileWaiting(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "updated")
	t.Setenv("PODSYNC_TEST_UPDATE_MARKER", marker)
	dl := commandFixture(t, "printf updated > \"$PODSYNC_TEST_UPDATE_MARKER\"\n")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { dl.autoUpdate(ctx, time.Hour); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("self update did not stop after cancellation")
	}
	_, err := os.Stat(marker)
	assert.True(t, os.IsNotExist(err), "cancellation must not start an update")
}

func TestAutoUpdateCancelsRunningProcess(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "updating")
	t.Setenv("PODSYNC_TEST_UPDATE_MARKER", marker)
	dl := commandFixture(t, "printf updating > \"$PODSYNC_TEST_UPDATE_MARKER\"\nexec sleep 30\n")
	dl.timeout = 5 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { dl.autoUpdate(ctx, time.Millisecond); close(done) }()
	require.Eventually(t, func() bool { _, err := os.Stat(marker); return err == nil }, time.Second, 5*time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("running self update did not stop after cancellation")
	}
}

func TestAutoUpdateRepeatsAndRefreshesSummarySupport(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "updated")
	t.Setenv("PODSYNC_TEST_UPDATE_MARKER", marker)
	dl := commandFixture(t, `case "$1" in
--update) printf 'updated\n' >> "$PODSYNC_TEST_UPDATE_MARKER";;
--help) printf '%s\n' '--print [WHEN:]TEMPLATE';;
esac
`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { dl.autoUpdate(ctx, 5*time.Millisecond); close(done) }()
	require.Eventually(t, func() bool {
		data, err := os.ReadFile(marker)
		return err == nil && strings.Count(string(data), "updated") >= 2
	}, time.Second, 5*time.Millisecond)
	// Wait for the final update's capability probe before canceling its context.
	require.NoError(t, dl.updateLock.Lock(context.Background()))
	supported := dl.summarySupported
	cancel()
	dl.updateLock.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("self update did not stop after repeated updates")
	}
	assert.True(t, supported)
}
