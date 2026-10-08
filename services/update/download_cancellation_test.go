package update

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/fs"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type cancelingDownloader struct {
	hookDownloader
	calls      int
	onDownload func()
}

func (d *cancelingDownloader) Download(ctx context.Context, cfg *feed.Config, episode *model.Episode) (io.ReadCloser, error) {
	d.calls++
	if d.onDownload != nil {
		d.onDownload()
	}
	return d.hookDownloader.Download(ctx, cfg, episode)
}

type cancellationDB struct {
	hookDB
	statuses []model.EpisodeStatus
}

func (d *cancellationDB) UpdateEpisode(_ string, id string, cb func(*model.Episode) error) error {
	episode := &model.Episode{ID: id}
	if err := cb(episode); err != nil {
		return err
	}
	d.statuses = append(d.statuses, episode.Status)
	return nil
}

func TestDownloadEpisodesStopsBatchOnServiceCancellation(t *testing.T) {
	for _, when := range []string{"before batch", "during download", "expired before batch"} {
		t.Run(when, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			cause := context.Canceled
			downloader := &cancelingDownloader{hookDownloader: hookDownloader{err: context.Canceled}}
			wantCalls := 0
			switch when {
			case "before batch":
				cancel()
			case "during download":
				downloader.onDownload = cancel
				wantCalls = 1
			case "expired before batch":
				var stop context.CancelFunc
				ctx, stop = context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
				defer stop()
				cause = context.DeadlineExceeded
			}
			storage, err := fs.NewLocal(t.TempDir(), false, false)
			require.NoError(t, err)
			db := &cancellationDB{}
			sink := &recordingEventSink{}
			manager, err := NewUpdater(nil, nil, "", downloader, db, storage, WithRemoteEventSink(sink))
			require.NoError(t, err)
			marker := filepath.Join(t.TempDir(), "hooks")
			t.Setenv("PODSYNC_CANCELLATION_HOOK_HELPER", "1")
			t.Setenv("PODSYNC_CANCELLATION_HOOK_MARKER", marker)
			cfg := testFeedConfig()
			cfg.OnEpisodeDownloadError = []*feed.ExecHook{{Command: []string{os.Args[0], "-test.run=^TestCancellationErrorHookHelper$"}}}
			episodes := make([]*model.Episode, 0, 3)
			for i := range 3 {
				episode := testEpisode()
				episode.ID = fmt.Sprintf("cancel-episode-%d", i)
				episodes = append(episodes, episode)
			}
			err = manager.downloadEpisodes(ctx, cfg, episodes)
			require.ErrorIs(t, err, cause)
			assert.Equal(t, wantCalls, downloader.calls)
			assert.Empty(t, sink.events)
			assert.Empty(t, db.statuses)
			_, err = os.Stat(marker)
			assert.True(t, os.IsNotExist(err), "service cancellation must not invoke failure hooks")
		})
	}
}

func TestCancellationErrorHookHelper(t *testing.T) {
	if os.Getenv("PODSYNC_CANCELLATION_HOOK_HELPER") != "1" {
		return
	}
	f, err := os.OpenFile(os.Getenv("PODSYNC_CANCELLATION_HOOK_MARKER"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	require.NoError(t, err)
	defer f.Close()
	_, err = f.WriteString("run\n")
	require.NoError(t, err)
}

func TestDownloadEpisodesContinuesAfterAttemptDeadline(t *testing.T) {
	db := &cancellationDB{}
	sink := &recordingEventSink{}
	downloader := &sequenceDownloader{results: []downloadResult{{err: context.DeadlineExceeded}, {body: "audio"}}}
	manager, err := NewUpdater(nil, nil, "", downloader, db, &hookFS{}, WithRemoteEventSink(sink))
	require.NoError(t, err)
	first, second := testEpisode(), testEpisode()
	second.ID = "second-episode"
	err = manager.downloadEpisodes(context.Background(), testFeedConfig(), []*model.Episode{first, second})
	require.NoError(t, err)
	assert.Equal(t, 2, downloader.calls)
	assert.Equal(t, []model.EpisodeStatus{model.EpisodeError, model.EpisodeDownloaded}, db.statuses)
	require.Len(t, sink.events, 2)
	assert.Equal(t, model.RemoteEventDownloadFailed, sink.events[0].Type)
	assert.Equal(t, model.RemoteEventDownloadFinished, sink.events[1].Type)
}

type canceledResultDownloader struct {
	hookDownloader
	cancel context.CancelFunc
	reader *cancellationReader
}

func (d *canceledResultDownloader) Download(context.Context, *feed.Config, *model.Episode) (io.ReadCloser, error) {
	d.cancel()
	return d.reader, nil
}

type cancellationReader struct {
	io.Reader
	closed bool
}

func (r *cancellationReader) Close() error { r.closed = true; return nil }

func TestDownloadEpisodesClosesResultWhenServiceIsCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := &cancellationReader{Reader: strings.NewReader("audio")}
	downloader := &canceledResultDownloader{cancel: cancel, reader: reader}
	storage := &hookFS{}
	db := &cancellationDB{}
	sink := &recordingEventSink{}
	manager, err := NewUpdater(nil, nil, "", downloader, db, storage, WithRemoteEventSink(sink))
	require.NoError(t, err)
	err = manager.downloadEpisodes(ctx, testFeedConfig(), []*model.Episode{testEpisode()})
	require.ErrorIs(t, err, context.Canceled)
	assert.True(t, reader.closed)
	assert.Empty(t, storage.createdPath)
	assert.Empty(t, db.statuses)
	assert.Empty(t, sink.events)
}
