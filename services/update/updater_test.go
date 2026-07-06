package update

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/builder"
	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/mxpv/podsync/pkg/ytdl"
)

func TestProviderKeyAllowsBilibiliWithoutConfiguredToken(t *testing.T) {
	manager := &Manager{
		keys: map[model.Provider]feed.KeyProvider{},
	}

	key, err := manager.providerKey(model.ProviderBilibili)

	require.NoError(t, err)
	require.Empty(t, key)
}

func TestProviderKeyStillRequiresTokenForOtherProviders(t *testing.T) {
	manager := &Manager{
		keys: map[model.Provider]feed.KeyProvider{},
	}

	_, err := manager.providerKey(model.ProviderYoutube)

	require.Error(t, err)
}

func TestSetFeedsReplacesFeedSnapshot(t *testing.T) {
	manager := &Manager{feeds: map[string]*feed.Config{
		"old": {ID: "old"},
	}}

	manager.SetFeeds(map[string]*feed.Config{
		"new": {ID: "new"},
	})

	snapshot := manager.feedSnapshot()
	require.NotContains(t, snapshot, "old")
	require.Contains(t, snapshot, "new")
	require.Equal(t, "new", snapshot["new"].ID)
}

func TestFeedSnapshotDoesNotExposeInternalMap(t *testing.T) {
	manager := &Manager{feeds: map[string]*feed.Config{
		"feed": {ID: "feed"},
	}}

	snapshot := manager.feedSnapshot()
	delete(snapshot, "feed")

	_, ok := manager.Feed("feed")
	require.True(t, ok)
}

func TestFeedReturnsCurrentFeedAndRejectsRemovedFeed(t *testing.T) {
	manager := &Manager{feeds: map[string]*feed.Config{
		"old": {ID: "old"},
	}}
	manager.SetFeeds(map[string]*feed.Config{
		"new": {ID: "new"},
	})

	_, ok := manager.Feed("old")
	require.False(t, ok)
	feedConfig, ok := manager.Feed("new")
	require.True(t, ok)
	require.Equal(t, "new", feedConfig.ID)
}

func TestEnqueueRemotePublishTaskNoopsWithoutOutbox(t *testing.T) {
	manager := &Manager{}

	err := manager.enqueueRemotePublishTask(context.Background(), testFeedConfig(), testEpisode(), "feed/episode.mp3", 123)

	require.NoError(t, err)
}

func TestEnqueueRemotePublishTaskRecordsProviderAndEpisodeMetadata(t *testing.T) {
	outbox := &recordingRemoteOutbox{}
	manager := &Manager{remotePublishOutbox: outbox}
	episode := testEpisode()

	err := manager.enqueueRemotePublishTask(context.Background(), testFeedConfig(), episode, "feed/episode.mp3", 123)

	require.NoError(t, err)
	require.Len(t, outbox.tasks, 1)
	task := outbox.tasks[0]
	require.Equal(t, "feed", task.FeedID)
	require.Equal(t, model.ProviderYoutube, task.Provider)
	require.Equal(t, "episode", task.LocalEpisodeID)
	require.Equal(t, "episode", task.SourceEpisodeID)
	require.Equal(t, "feed/episode.mp3", task.MediaPath)
	require.EqualValues(t, 123, task.Size)
	require.Equal(t, episode.Title, task.Title)
	require.Equal(t, episode.Description, task.Description)
	require.Equal(t, episode.Thumbnail, task.Thumbnail)
	require.Equal(t, episode.Duration, task.Duration)
	require.Equal(t, episode.VideoURL, task.SourceURL)
	require.Equal(t, episode.PubDate, task.PublishedAt)
}

func TestEnqueueRemotePublishTaskReturnsProviderParseError(t *testing.T) {
	outbox := &recordingRemoteOutbox{}
	manager := &Manager{remotePublishOutbox: outbox}
	feedConfig := testFeedConfig()
	feedConfig.URL = "://bad"

	err := manager.enqueueRemotePublishTask(context.Background(), feedConfig, testEpisode(), "feed/episode.mp3", 123)

	require.Error(t, err)
	require.Zero(t, outbox.calls)
}

func TestEnqueueRemotePublishTaskReturnsOutboxError(t *testing.T) {
	wantErr := errors.New("outbox unavailable")
	manager := &Manager{remotePublishOutbox: &recordingRemoteOutbox{err: wantErr}}

	err := manager.enqueueRemotePublishTask(context.Background(), testFeedConfig(), testEpisode(), "feed/episode.mp3", 123)

	require.ErrorIs(t, err, wantErr)
}

func TestDownloadEpisodesEnqueuesAfterExistingMediaMarkedDownloaded(t *testing.T) {
	db := &hookDB{}
	outbox := &recordingRemoteOutbox{dbUpdated: func() bool { return db.updated }}
	manager := &Manager{
		db:                  db,
		fs:                  &hookFS{existingSize: 321},
		remotePublishOutbox: outbox,
	}

	err := manager.downloadEpisodes(context.Background(), testFeedConfig(), []*model.Episode{testEpisode()})

	require.NoError(t, err)
	require.Len(t, outbox.tasks, 1)
	require.Equal(t, []bool{true}, outbox.updatedAtCall)
	require.Equal(t, "feed/episode.mp3", outbox.tasks[0].MediaPath)
	require.EqualValues(t, 321, outbox.tasks[0].Size)
}

func TestDownloadEpisodesEnqueuesAfterNewDownloadMarkedDownloaded(t *testing.T) {
	db := &hookDB{}
	outbox := &recordingRemoteOutbox{dbUpdated: func() bool { return db.updated }}
	storage := &hookFS{}
	manager := &Manager{
		downloader:          hookDownloader{body: "audio"},
		db:                  db,
		fs:                  storage,
		remotePublishOutbox: outbox,
	}

	err := manager.downloadEpisodes(context.Background(), testFeedConfig(), []*model.Episode{testEpisode()})

	require.NoError(t, err)
	require.Equal(t, "feed/episode.mp3", storage.createdPath)
	require.Len(t, outbox.tasks, 1)
	require.Equal(t, []bool{true}, outbox.updatedAtCall)
	require.Equal(t, "feed/episode.mp3", outbox.tasks[0].MediaPath)
	require.EqualValues(t, len("audio"), outbox.tasks[0].Size)
}

func TestDownloadEpisodesIgnoresRemotePublishEnqueueError(t *testing.T) {
	manager := &Manager{
		db:                  &hookDB{},
		fs:                  &hookFS{existingSize: 321},
		remotePublishOutbox: &recordingRemoteOutbox{err: errors.New("outbox unavailable")},
	}

	err := manager.downloadEpisodes(context.Background(), testFeedConfig(), []*model.Episode{testEpisode()})

	require.NoError(t, err)
	require.Equal(t, 1, manager.remotePublishOutbox.(*recordingRemoteOutbox).calls)
}

func TestDownloadEpisodesDoesNotEnqueueWhenLocalUpdateFails(t *testing.T) {
	outbox := &recordingRemoteOutbox{}
	manager := &Manager{
		db:                  &hookDB{fail: errors.New("db unavailable")},
		fs:                  &hookFS{existingSize: 321},
		remotePublishOutbox: outbox,
	}

	err := manager.downloadEpisodes(context.Background(), testFeedConfig(), []*model.Episode{testEpisode()})

	require.Error(t, err)
	require.Zero(t, outbox.calls)
}

func TestUpdateRecordsFeedUpdateFailureEvent(t *testing.T) {
	sink := &recordingEventSink{}
	manager := &Manager{remoteEventSink: sink}
	feedConfig := testFeedConfig()
	feedConfig.URL = "://bad"

	err := manager.Update(context.Background(), feedConfig)

	require.Error(t, err)
	require.Len(t, sink.events, 2)
	assert.Equal(t, model.RemoteEventFeedUpdateStarted, sink.events[0].Type)
	assert.Equal(t, model.RemoteEventFeedUpdateFailed, sink.events[1].Type)
	assert.Equal(t, model.RemoteEventError, sink.events[1].Level)
	assert.Contains(t, sink.events[1].ErrorDetail, "update failed")
}

func TestUpdateRecordsFeedUpdateStartedAndFinishedEvents(t *testing.T) {
	sink := &recordingEventSink{}
	manager := &Manager{remoteEventSink: sink}

	manager.recordFeedUpdateStarted("feed")
	manager.recordFeedUpdateDone("feed", nil)

	require.Len(t, sink.events, 2)
	assert.Equal(t, model.RemoteEventFeedUpdateStarted, sink.events[0].Type)
	assert.Equal(t, model.RemoteEventFeedUpdateFinished, sink.events[1].Type)
	assert.Equal(t, "feed", sink.events[0].FeedID)
	assert.Equal(t, "feed", sink.events[1].FeedID)
}

func TestFetchEpisodesRecordsDiscoveredEvents(t *testing.T) {
	sink := &recordingEventSink{}
	manager := &Manager{
		db:              &hookDB{episodes: []*model.Episode{testEpisode()}},
		remoteEventSink: sink,
	}
	feedConfig := testFeedConfig()
	feedConfig.PageSize = 1

	episodes, err := manager.fetchEpisodes(context.Background(), feedConfig)

	require.NoError(t, err)
	require.Len(t, episodes, 1)
	require.Len(t, sink.events, 1)
	assert.Equal(t, model.RemoteEventEpisodeDiscovered, sink.events[0].Type)
	assert.Equal(t, "feed", sink.events[0].FeedID)
	assert.Equal(t, "episode", sink.events[0].LocalEpisodeID)
}

func TestDownloadEpisodesRecordsDownloadFinishedEvent(t *testing.T) {
	sink := &recordingEventSink{}
	manager := &Manager{
		downloader:      hookDownloader{body: "audio"},
		db:              &hookDB{},
		fs:              &hookFS{},
		remoteEventSink: sink,
	}

	err := manager.downloadEpisodes(context.Background(), testFeedConfig(), []*model.Episode{testEpisode()})

	require.NoError(t, err)
	require.Len(t, sink.events, 1)
	assert.Equal(t, model.RemoteEventDownloadFinished, sink.events[0].Type)
	assert.Equal(t, "episode", sink.events[0].LocalEpisodeID)
}

func TestDownloadEpisodesRecordsDownloadFailedEvent(t *testing.T) {
	wantErr := errors.New("download Authorization: Bearer secret-token failed")
	sink := &recordingEventSink{}
	manager := &Manager{
		downloader:      hookDownloader{err: wantErr},
		db:              &hookDB{},
		fs:              &hookFS{},
		remoteEventSink: sink,
	}

	err := manager.downloadEpisodes(context.Background(), testFeedConfig(), []*model.Episode{testEpisode()})

	require.NoError(t, err)
	require.Len(t, sink.events, 1)
	assert.Equal(t, model.RemoteEventDownloadFailed, sink.events[0].Type)
	assert.Equal(t, model.RemoteEventError, sink.events[0].Level)
	assert.Equal(t, wantErr.Error(), sink.events[0].ErrorDetail)
}

func TestDownloadEpisodesDoesNotRecordFinishedForExistingMedia(t *testing.T) {
	sink := &recordingEventSink{}
	manager := &Manager{
		db:              &hookDB{},
		fs:              &hookFS{existingSize: 321},
		remoteEventSink: sink,
	}

	err := manager.downloadEpisodes(context.Background(), testFeedConfig(), []*model.Episode{testEpisode()})

	require.NoError(t, err)
	assert.Empty(t, sink.events)
}

func TestRemoteFeedMetadataFromResultMapsFields(t *testing.T) {
	reportedAt := time.Date(2026, 7, 6, 12, 5, 0, 0, time.UTC)
	result := testFeedResult()

	metadata, err := remoteFeedMetadataFromResult(testFeedConfig(), result, reportedAt)

	require.NoError(t, err)
	require.NotNil(t, metadata)
	assert.Equal(t, "feed", metadata.FeedID)
	assert.Equal(t, model.ProviderYoutube, metadata.Provider)
	assert.Equal(t, "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw", metadata.SourceURL)
	assert.Equal(t, "Feed Title", metadata.Title)
	assert.Equal(t, "Feed description", metadata.Description)
	assert.Equal(t, "https://example.com/cover.jpg", metadata.ImageURL)
	assert.Equal(t, "https://example.com/feed", metadata.Link)
	assert.Equal(t, "Creator", metadata.Author)
	assert.Empty(t, metadata.Category)
	assert.Empty(t, metadata.Language)
	assert.Nil(t, metadata.Explicit)
	assert.Equal(t, result.PubDate.UTC(), metadata.LastSourceUpdateAt)
	assert.Equal(t, reportedAt, metadata.ReportedAt)
}

func TestRemoteFeedMetadataFromResultUsesCustomOverrides(t *testing.T) {
	feedConfig := testFeedConfig()
	feedConfig.Custom.Title = "Custom Title"
	feedConfig.Custom.Description = "Custom description"
	feedConfig.Custom.CoverArt = "https://example.com/custom.jpg"
	feedConfig.Custom.Link = "https://example.com/custom"
	feedConfig.Custom.Author = "Custom Creator"
	feedConfig.Custom.Category = "Technology"
	feedConfig.Custom.Language = "zh-CN"
	feedConfig.Custom.Explicit = true

	metadata, err := remoteFeedMetadataFromResult(feedConfig, testFeedResult(), time.Now())

	require.NoError(t, err)
	require.NotNil(t, metadata)
	assert.Equal(t, "Custom Title", metadata.Title)
	assert.Equal(t, "Custom description", metadata.Description)
	assert.Equal(t, "https://example.com/custom.jpg", metadata.ImageURL)
	assert.Equal(t, "https://example.com/custom", metadata.Link)
	assert.Equal(t, "Custom Creator", metadata.Author)
	assert.Equal(t, "Technology", metadata.Category)
	assert.Equal(t, "zh-CN", metadata.Language)
	require.NotNil(t, metadata.Explicit)
	assert.True(t, *metadata.Explicit)
}

func TestRemoteFeedMetadataFromResultSkipsUnsupportedProvider(t *testing.T) {
	feedConfig := testFeedConfig()
	feedConfig.URL = "https://vimeo.com/example"

	metadata, err := remoteFeedMetadataFromResult(feedConfig, testFeedResult(), time.Now())

	require.NoError(t, err)
	assert.Nil(t, metadata)
}

func TestUpdateFeedReportsRemoteFeedMetadataAfterAddFeed(t *testing.T) {
	reporter := &recordingFeedMetadataReporter{}
	database := &hookDB{}
	result := testFeedResult()
	feedConfig := testFeedConfig()
	feedConfig.URL = "https://space.bilibili.com/10835521"
	manager := &Manager{
		db:                         database,
		downloader:                 hookDownloader{},
		keys:                       map[model.Provider]feed.KeyProvider{},
		remoteFeedMetadataReporter: reporter,
		builderFactory: func(_ context.Context, provider model.Provider, key string, downloader Downloader) (builder.Builder, error) {
			assert.Equal(t, model.ProviderBilibili, provider)
			assert.Empty(t, key)
			assert.NotNil(t, downloader)
			return fakeFeedBuilder{result: result}, nil
		},
	}

	err := manager.updateFeed(context.Background(), feedConfig)

	require.NoError(t, err)
	assert.Equal(t, 1, database.addFeedCalls)
	assert.Equal(t, result, database.feed)
	require.Len(t, reporter.metadata, 1)
	assert.Equal(t, "feed", reporter.metadata[0].FeedID)
	assert.Equal(t, model.ProviderBilibili, reporter.metadata[0].Provider)
	assert.Equal(t, "https://space.bilibili.com/10835521", reporter.metadata[0].SourceURL)
}

func TestUpdateFeedDoesNotReportRemoteFeedMetadataWhenBuildFails(t *testing.T) {
	reporter := &recordingFeedMetadataReporter{}
	wantErr := errors.New("builder failed")
	manager := &Manager{
		db:                         &hookDB{},
		downloader:                 hookDownloader{},
		keys:                       map[model.Provider]feed.KeyProvider{},
		remoteFeedMetadataReporter: reporter,
		builderFactory: func(context.Context, model.Provider, string, Downloader) (builder.Builder, error) {
			return fakeFeedBuilder{err: wantErr}, nil
		},
	}
	feedConfig := testFeedConfig()
	feedConfig.URL = "https://space.bilibili.com/10835521"

	err := manager.updateFeed(context.Background(), feedConfig)

	require.ErrorIs(t, err, wantErr)
	assert.Empty(t, reporter.metadata)
}

func TestUpdateFeedDoesNotReportRemoteFeedMetadataWhenAddFeedFails(t *testing.T) {
	reporter := &recordingFeedMetadataReporter{}
	wantErr := errors.New("db failed")
	manager := &Manager{
		db:                         &hookDB{addFeedErr: wantErr},
		downloader:                 hookDownloader{},
		keys:                       map[model.Provider]feed.KeyProvider{},
		remoteFeedMetadataReporter: reporter,
		builderFactory: func(context.Context, model.Provider, string, Downloader) (builder.Builder, error) {
			return fakeFeedBuilder{result: testFeedResult()}, nil
		},
	}
	feedConfig := testFeedConfig()
	feedConfig.URL = "https://space.bilibili.com/10835521"

	err := manager.updateFeed(context.Background(), feedConfig)

	require.ErrorIs(t, err, wantErr)
	assert.Empty(t, reporter.metadata)
}

func TestUpdateFeedIgnoresRemoteFeedMetadataReporterError(t *testing.T) {
	reporter := &recordingFeedMetadataReporter{err: errors.New("remote failed")}
	manager := &Manager{
		db:                         &hookDB{},
		downloader:                 hookDownloader{},
		keys:                       map[model.Provider]feed.KeyProvider{},
		remoteFeedMetadataReporter: reporter,
		builderFactory: func(context.Context, model.Provider, string, Downloader) (builder.Builder, error) {
			return fakeFeedBuilder{result: testFeedResult()}, nil
		},
	}
	feedConfig := testFeedConfig()
	feedConfig.URL = "https://space.bilibili.com/10835521"

	err := manager.updateFeed(context.Background(), feedConfig)

	require.NoError(t, err)
	assert.Len(t, reporter.metadata, 1)
}

type recordingRemoteOutbox struct {
	tasks         []*model.RemotePublishTask
	err           error
	calls         int
	dbUpdated     func() bool
	updatedAtCall []bool
}

func (r *recordingRemoteOutbox) EnqueueRemotePublishTask(_ context.Context, task *model.RemotePublishTask) error {
	r.calls++
	if r.dbUpdated != nil {
		r.updatedAtCall = append(r.updatedAtCall, r.dbUpdated())
	}
	if r.err != nil {
		return r.err
	}
	r.tasks = append(r.tasks, task)
	return nil
}

type recordingEventSink struct {
	events []model.RemoteEventDraft
}

func (r *recordingEventSink) RecordRemoteEvent(event model.RemoteEventDraft) {
	r.events = append(r.events, event)
}

type recordingFeedMetadataReporter struct {
	metadata []*model.RemoteFeedMetadata
	err      error
}

func (r *recordingFeedMetadataReporter) UpsertFeedMetadata(_ context.Context, metadata *model.RemoteFeedMetadata) error {
	r.metadata = append(r.metadata, metadata)
	return r.err
}

type fakeFeedBuilder struct {
	result *model.Feed
	err    error
}

func (f fakeFeedBuilder) Build(context.Context, *feed.Config) (*model.Feed, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.result, nil
}

type hookDB struct {
	updated      bool
	fail         error
	episodes     []*model.Episode
	feed         *model.Feed
	addFeedErr   error
	addFeedCalls int
}

func (h *hookDB) Close() error          { return nil }
func (h *hookDB) Version() (int, error) { return 0, errors.New("not implemented") }
func (h *hookDB) AddFeed(_ context.Context, _ string, feed *model.Feed) error {
	h.addFeedCalls++
	if h.addFeedErr != nil {
		return h.addFeedErr
	}
	h.feed = feed
	return nil
}
func (h *hookDB) GetFeed(context.Context, string) (*model.Feed, error) {
	return nil, errors.New("not implemented")
}
func (h *hookDB) WalkFeeds(context.Context, func(*model.Feed) error) error {
	return errors.New("not implemented")
}
func (h *hookDB) DeleteFeed(context.Context, string) error { return errors.New("not implemented") }
func (h *hookDB) GetEpisode(context.Context, string, string) (*model.Episode, error) {
	return nil, errors.New("not implemented")
}
func (h *hookDB) DeleteEpisode(string, string) error { return errors.New("not implemented") }
func (h *hookDB) WalkEpisodes(_ context.Context, _ string, cb func(*model.Episode) error) error {
	for _, episode := range h.episodes {
		if err := cb(episode); err != nil {
			return err
		}
	}
	return nil
}

func (h *hookDB) UpdateEpisode(_ string, episodeID string, cb func(*model.Episode) error) error {
	if h.fail != nil {
		return h.fail
	}
	episode := &model.Episode{ID: episodeID}
	if err := cb(episode); err != nil {
		return err
	}
	h.updated = episode.Status == model.EpisodeDownloaded
	return nil
}

type hookFS struct {
	existingSize int64
	createdPath  string
}

func (h *hookFS) Open(string) (http.File, error) { return nil, errors.New("not implemented") }
func (h *hookFS) Delete(context.Context, string) error {
	return errors.New("not implemented")
}

func (h *hookFS) Size(context.Context, string) (int64, error) {
	if h.existingSize > 0 {
		return h.existingSize, nil
	}
	return 0, os.ErrNotExist
}

func (h *hookFS) Create(_ context.Context, name string, reader io.Reader) (int64, error) {
	h.createdPath = name
	return io.Copy(io.Discard, reader)
}

type hookDownloader struct {
	body string
	err  error
}

func (h hookDownloader) Download(context.Context, *feed.Config, *model.Episode) (io.ReadCloser, error) {
	if h.err != nil {
		return nil, h.err
	}
	return io.NopCloser(strings.NewReader(h.body)), nil
}

func (h hookDownloader) PlaylistMetadata(context.Context, string) (ytdl.PlaylistMetadata, error) {
	return ytdl.PlaylistMetadata{}, nil
}

func testFeedConfig() *feed.Config {
	return &feed.Config{
		ID:     "feed",
		URL:    "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
		Format: model.FormatAudio,
	}
}

func testEpisode() *model.Episode {
	return &model.Episode{
		ID:          "episode",
		Title:       "Episode",
		Description: "Episode description",
		Thumbnail:   "https://example.com/episode.jpg",
		Duration:    123,
		VideoURL:    "https://www.youtube.com/watch?v=episode",
		PubDate:     time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC),
		Status:      model.EpisodeNew,
	}
}

func testFeedResult() *model.Feed {
	return &model.Feed{
		ID:          "feed",
		Title:       "Feed Title",
		Description: "Feed description",
		CoverArt:    "https://example.com/cover.jpg",
		ItemURL:     "https://example.com/feed",
		Author:      "Creator",
		PubDate:     time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC),
		Episodes:    []*model.Episode{testEpisode()},
	}
}
