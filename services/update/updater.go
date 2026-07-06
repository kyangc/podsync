package update

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/hashicorp/go-multierror"
	"github.com/pkg/errors"
	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/builder"
	"github.com/mxpv/podsync/pkg/db"
	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/fs"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/mxpv/podsync/pkg/ytdl"
)

type Downloader interface {
	Download(ctx context.Context, feedConfig *feed.Config, episode *model.Episode) (io.ReadCloser, error)
	PlaylistMetadata(ctx context.Context, url string) (metadata ytdl.PlaylistMetadata, err error)
}

type RemotePublishOutbox interface {
	EnqueueRemotePublishTask(ctx context.Context, task *model.RemotePublishTask) error
}

type RemoteEventSink interface {
	RecordRemoteEvent(event model.RemoteEventDraft)
}

type Option func(*Manager)

func WithRemotePublishOutbox(outbox RemotePublishOutbox) Option {
	return func(u *Manager) {
		u.remotePublishOutbox = outbox
	}
}

func WithRemoteEventSink(sink RemoteEventSink) Option {
	return func(u *Manager) {
		u.remoteEventSink = sink
	}
}

type TokenList []string

type Manager struct {
	mu                  sync.RWMutex
	hostname            string
	downloader          Downloader
	db                  db.Storage
	fs                  fs.Storage
	feeds               map[string]*feed.Config
	keys                map[model.Provider]feed.KeyProvider
	remotePublishOutbox RemotePublishOutbox
	remoteEventSink     RemoteEventSink
}

func NewUpdater(
	feeds map[string]*feed.Config,
	keys map[model.Provider]feed.KeyProvider,
	hostname string,
	downloader Downloader,
	db db.Storage,
	fs fs.Storage,
	options ...Option,
) (*Manager, error) {
	manager := &Manager{
		hostname:   hostname,
		downloader: downloader,
		db:         db,
		fs:         fs,
		feeds:      feeds,
		keys:       keys,
	}
	for _, option := range options {
		option(manager)
	}
	return manager, nil
}

func (u *Manager) SetFeeds(feeds map[string]*feed.Config) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.feeds = feeds
}

func (u *Manager) Feed(id string) (*feed.Config, bool) {
	u.mu.RLock()
	defer u.mu.RUnlock()
	feedConfig, ok := u.feeds[id]
	return feedConfig, ok
}

func (u *Manager) feedSnapshot() map[string]*feed.Config {
	u.mu.RLock()
	defer u.mu.RUnlock()
	feeds := make(map[string]*feed.Config, len(u.feeds))
	for id, cfg := range u.feeds {
		feeds[id] = cfg
	}
	return feeds
}

func (u *Manager) enqueueRemotePublishTask(ctx context.Context, feedConfig *feed.Config, episode *model.Episode, mediaPath string, size int64) error {
	if u.remotePublishOutbox == nil {
		return nil
	}
	info, err := builder.ParseURL(feedConfig.URL)
	if err != nil {
		return err
	}
	return u.remotePublishOutbox.EnqueueRemotePublishTask(ctx, &model.RemotePublishTask{
		FeedID:          feedConfig.ID,
		Provider:        info.Provider,
		LocalEpisodeID:  episode.ID,
		SourceEpisodeID: episode.ID,
		MediaPath:       mediaPath,
		Size:            size,
		Title:           episode.Title,
		Description:     episode.Description,
		Thumbnail:       episode.Thumbnail,
		Duration:        episode.Duration,
		SourceURL:       episode.VideoURL,
		PublishedAt:     episode.PubDate,
	})
}

func (u *Manager) recordRemoteEvent(event model.RemoteEventDraft) {
	if u.remoteEventSink != nil {
		u.remoteEventSink.RecordRemoteEvent(event)
	}
}

func (u *Manager) recordFeedUpdateStarted(feedID string) {
	u.recordRemoteEvent(model.RemoteEventDraft{
		Level:  model.RemoteEventInfo,
		Type:   model.RemoteEventFeedUpdateStarted,
		FeedID: feedID,
	})
}

func (u *Manager) recordFeedUpdateDone(feedID string, err error) {
	if err != nil {
		u.recordRemoteEvent(model.RemoteEventDraft{
			Level:       model.RemoteEventError,
			Type:        model.RemoteEventFeedUpdateFailed,
			FeedID:      feedID,
			ErrorCode:   "feed_update_failed",
			ErrorDetail: err.Error(),
		})
		return
	}
	u.recordRemoteEvent(model.RemoteEventDraft{
		Level:  model.RemoteEventInfo,
		Type:   model.RemoteEventFeedUpdateFinished,
		FeedID: feedID,
	})
}

func (u *Manager) Update(ctx context.Context, feedConfig *feed.Config) (err error) {
	log.WithFields(log.Fields{
		"feed_id": feedConfig.ID,
		"format":  feedConfig.Format,
		"quality": feedConfig.Quality,
	}).Infof("-> updating %s", feedConfig.URL)
	u.recordFeedUpdateStarted(feedConfig.ID)
	defer func() {
		u.recordFeedUpdateDone(feedConfig.ID, err)
	}()

	started := time.Now()

	if err := u.updateFeed(ctx, feedConfig); err != nil {
		return errors.Wrap(err, "update failed")
	}

	// Fetch episodes for download
	episodesToDownload, err := u.fetchEpisodes(ctx, feedConfig)
	if err != nil {
		return errors.Wrap(err, "fetch episodes failed")
	}

	if err := u.downloadEpisodes(ctx, feedConfig, episodesToDownload); err != nil {
		return errors.Wrap(err, "download failed")
	}

	if err := u.cleanup(ctx, feedConfig); err != nil {
		log.WithError(err).Error("cleanup failed")
	}

	if err := u.buildXML(ctx, feedConfig); err != nil {
		return errors.Wrap(err, "xml build failed")
	}

	if err := u.buildOPML(ctx); err != nil {
		return errors.Wrap(err, "opml build failed")
	}

	elapsed := time.Since(started)
	log.Infof("successfully updated feed in %s", elapsed)
	return nil
}

// updateFeed pulls API for new episodes and saves them to database
func (u *Manager) updateFeed(ctx context.Context, feedConfig *feed.Config) error {
	info, err := builder.ParseURL(feedConfig.URL)
	if err != nil {
		return errors.Wrapf(err, "failed to parse URL: %s", feedConfig.URL)
	}

	key, err := u.providerKey(info.Provider)
	if err != nil {
		return err
	}

	// Create an updater for this feed type
	provider, err := builder.New(ctx, info.Provider, key, u.downloader)
	if err != nil {
		return err
	}

	// Query API to get episodes
	log.Debug("building feed")
	result, err := provider.Build(ctx, feedConfig)
	if err != nil {
		return err
	}

	log.Debugf("received %d episode(s) for %q", len(result.Episodes), result.Title)

	episodeSet := make(map[string]struct{})
	if err := u.db.WalkEpisodes(ctx, feedConfig.ID, func(episode *model.Episode) error {
		if episode.Status != model.EpisodeDownloaded && episode.Status != model.EpisodeCleaned {
			episodeSet[episode.ID] = struct{}{}
		}
		return nil
	}); err != nil {
		return err
	}

	if err := u.db.AddFeed(ctx, feedConfig.ID, result); err != nil {
		return err
	}

	for _, episode := range result.Episodes {
		delete(episodeSet, episode.ID)
	}

	// removing episodes that are no longer available in the feed and not downloaded or cleaned
	for id := range episodeSet {
		log.Infof("removing episode %q", id)
		err := u.db.DeleteEpisode(feedConfig.ID, id)
		if err != nil {
			return err
		}
	}

	log.Debug("successfully saved updates to storage")
	return nil
}

func (u *Manager) providerKey(provider model.Provider) (string, error) {
	if provider == model.ProviderBilibili {
		return "", nil
	}

	keyProvider, ok := u.keys[provider]
	if !ok {
		return "", errors.Errorf("key provider %q not loaded", provider)
	}

	return keyProvider.Get(), nil
}

func (u *Manager) fetchEpisodes(ctx context.Context, feedConfig *feed.Config) ([]*model.Episode, error) {
	var (
		feedID       = feedConfig.ID
		downloadList []*model.Episode
		pageSize     = feedConfig.PageSize
	)

	log.WithField("page_size", pageSize).Info("fetching episodes for download")

	// Build the list of files to download
	err := u.db.WalkEpisodes(ctx, feedID, func(episode *model.Episode) error {
		var (
			logger = log.WithFields(log.Fields{"episode_id": episode.ID})
		)
		if episode.Status != model.EpisodeNew && episode.Status != model.EpisodeError {
			// File already downloaded
			logger.Infof("skipping due to already downloaded")
			return nil
		}

		if !matchFilters(episode, &feedConfig.Filters) {
			return nil
		}

		// Limit the number of episodes downloaded at once
		pageSize--
		if pageSize < 0 {
			return nil
		}

		log.Debugf("adding %s (%q) to queue", episode.ID, episode.Title)
		u.recordRemoteEvent(model.RemoteEventDraft{
			Level:          model.RemoteEventInfo,
			Type:           model.RemoteEventEpisodeDiscovered,
			FeedID:         feedID,
			LocalEpisodeID: episode.ID,
			Message:        episode.Title,
		})
		downloadList = append(downloadList, episode)
		return nil
	})

	if err != nil {
		return nil, errors.Wrapf(err, "failed to build update list")
	}

	return downloadList, nil
}

func (u *Manager) downloadEpisodes(ctx context.Context, feedConfig *feed.Config, downloadList []*model.Episode) error {
	var (
		downloadCount = len(downloadList)
		downloaded    = 0
		feedID        = feedConfig.ID
	)

	if downloadCount > 0 {
		log.Infof("download count: %d", downloadCount)
	} else {
		log.Info("no episodes to download")
		return nil
	}

	// Download pending episodes

	for idx, episode := range downloadList {
		var (
			logger      = log.WithFields(log.Fields{"index": idx, "episode_id": episode.ID})
			episodeName = feed.EpisodeName(feedConfig, episode)
			mediaPath   = fmt.Sprintf("%s/%s", feedID, episodeName)
		)

		// Check whether episode already exists
		size, err := u.fs.Size(ctx, mediaPath)
		if err == nil {
			logger.Infof("episode %q already exists on disk", episode.ID)

			// File already exists, update file status and disk size
			if err := u.db.UpdateEpisode(feedID, episode.ID, func(episode *model.Episode) error {
				episode.Size = size
				episode.Status = model.EpisodeDownloaded
				return nil
			}); err != nil {
				logger.WithError(err).Error("failed to update file info")
				return err
			}

			if err := u.enqueueRemotePublishTask(ctx, feedConfig, episode, mediaPath, size); err != nil {
				logger.WithError(err).Warn("failed to enqueue remote publish task")
			}

			continue
		} else if os.IsNotExist(err) {
			// Will download, do nothing here
		} else {
			logger.WithError(err).Error("failed to stat file")
			return err
		}

		// Download episode to disk
		// We download the episode to a temp directory first to avoid downloading this file by clients
		// while still being processed by youtube-dl (e.g. a file is being downloaded from YT or encoding in progress)

		logger.Infof("! downloading episode %s", episode.VideoURL)
		tempFile, err := u.downloader.Download(ctx, feedConfig, episode)
		if err != nil {
			// YouTube might block host with HTTP Error 429: Too Many Requests
			// We still need to generate XML, so just stop sending download requests and
			// retry next time
			if err == ytdl.ErrTooManyRequests {
				logger.Warn("server responded with a 'Too Many Requests' error")
				break
			}
			u.recordRemoteEvent(model.RemoteEventDraft{
				Level:          model.RemoteEventError,
				Type:           model.RemoteEventDownloadFailed,
				FeedID:         feedID,
				LocalEpisodeID: episode.ID,
				ErrorCode:      "download_failed",
				ErrorDetail:    err.Error(),
			})

			// Execute episode download error hooks
			if len(feedConfig.OnEpisodeDownloadError) > 0 {
				env := []string{
					"FEED_NAME=" + feedID,
					"EPISODE_TITLE=" + episode.Title,
					"ERROR_MESSAGE=" + err.Error(),
				}

				for i, hook := range feedConfig.OnEpisodeDownloadError {
					if hookErr := hook.Invoke(env); hookErr != nil {
						logger.Errorf("failed to execute episode download error hook %d: %v", i+1, hookErr)
					} else {
						logger.Infof("episode download error hook %d executed successfully", i+1)
					}
				}
			}

			if err := u.db.UpdateEpisode(feedID, episode.ID, func(episode *model.Episode) error {
				episode.Status = model.EpisodeError
				return nil
			}); err != nil {
				return err
			}

			continue
		}

		logger.Debug("copying file")
		fileSize, err := u.fs.Create(ctx, mediaPath, tempFile)
		tempFile.Close()
		if err != nil {
			logger.WithError(err).Error("failed to copy file")
			return err
		}

		// Execute post episode download hooks
		if len(feedConfig.PostEpisodeDownload) > 0 {
			env := []string{
				"EPISODE_FILE=" + mediaPath,
				"FEED_NAME=" + feedID,
				"EPISODE_TITLE=" + episode.Title,
			}

			for i, hook := range feedConfig.PostEpisodeDownload {
				if err := hook.Invoke(env); err != nil {
					logger.Errorf("failed to execute post episode download hook %d: %v", i+1, err)
				} else {
					logger.Infof("post episode download hook %d executed successfully", i+1)
				}
			}
		}

		// Update file status in database

		logger.Infof("successfully downloaded file %q", episode.ID)
		if err := u.db.UpdateEpisode(feedID, episode.ID, func(episode *model.Episode) error {
			episode.Size = fileSize
			episode.Status = model.EpisodeDownloaded
			return nil
		}); err != nil {
			return err
		}
		u.recordRemoteEvent(model.RemoteEventDraft{
			Level:          model.RemoteEventInfo,
			Type:           model.RemoteEventDownloadFinished,
			FeedID:         feedID,
			LocalEpisodeID: episode.ID,
			Message:        episode.Title,
		})

		if err := u.enqueueRemotePublishTask(ctx, feedConfig, episode, mediaPath, fileSize); err != nil {
			logger.WithError(err).Warn("failed to enqueue remote publish task")
		}

		downloaded++
	}

	log.Infof("downloaded %d episode(s)", downloaded)
	return nil
}

func (u *Manager) buildXML(ctx context.Context, feedConfig *feed.Config) error {
	f, err := u.db.GetFeed(ctx, feedConfig.ID)
	if err != nil {
		return err
	}

	// Build iTunes XML feed with data received from builder
	log.Debug("building iTunes podcast feed")
	podcast, err := feed.Build(ctx, f, feedConfig, u.hostname)
	if err != nil {
		return err
	}

	var (
		reader  = bytes.NewReader([]byte(podcast.String()))
		xmlName = fmt.Sprintf("%s.xml", feedConfig.ID)
	)

	if _, err := u.fs.Create(ctx, xmlName, reader); err != nil {
		return errors.Wrap(err, "failed to upload new XML feed")
	}

	return nil
}

func (u *Manager) buildOPML(ctx context.Context) error {
	// Build OPML with data received from builder
	log.Debug("building podcast OPML")
	opml, err := feed.BuildOPML(ctx, u.feedSnapshot(), u.db, u.hostname)
	if err != nil {
		return err
	}

	var (
		reader  = bytes.NewReader([]byte(opml))
		xmlName = fmt.Sprintf("%s.opml", "podsync")
	)

	if _, err := u.fs.Create(ctx, xmlName, reader); err != nil {
		return errors.Wrap(err, "failed to upload OPML")
	}

	return nil
}

func (u *Manager) cleanup(ctx context.Context, feedConfig *feed.Config) error {
	var (
		feedID = feedConfig.ID
		logger = log.WithField("feed_id", feedID)
		list   []*model.Episode
		result *multierror.Error
	)

	if feedConfig.Clean == nil {
		logger.Debug("no cleanup policy configured")
		return nil
	}

	count := feedConfig.Clean.KeepLast
	if count < 1 {
		logger.Info("nothing to clean")
		return nil
	}

	logger.WithField("count", count).Info("running cleaner")
	if err := u.db.WalkEpisodes(ctx, feedConfig.ID, func(episode *model.Episode) error {
		if episode.Status == model.EpisodeDownloaded {
			list = append(list, episode)
		}
		return nil
	}); err != nil {
		return err
	}

	if count > len(list) {
		return nil
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].PubDate.After(list[j].PubDate)
	})

	for _, episode := range list[count:] {
		logger.WithField("episode_id", episode.ID).Infof("deleting %q", episode.Title)

		var (
			episodeName = feed.EpisodeName(feedConfig, episode)
			path        = fmt.Sprintf("%s/%s", feedConfig.ID, episodeName)
		)

		err := u.fs.Delete(ctx, path)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				logger.WithError(err).Errorf("failed to delete episode file: %s", episode.ID)
				result = multierror.Append(result, errors.Wrapf(err, "failed to delete episode: %s", episode.ID))
				continue
			}

			logger.WithField("episode_id", episode.ID).Info("episode was not found - file does not exist")
		}

		if err := u.db.UpdateEpisode(feedID, episode.ID, func(episode *model.Episode) error {
			episode.Status = model.EpisodeCleaned
			episode.Title = ""
			episode.Description = ""
			return nil
		}); err != nil {
			result = multierror.Append(result, errors.Wrapf(err, "failed to set state for cleaned episode: %s", episode.ID))
			continue
		}
	}

	return result.ErrorOrNil()
}
