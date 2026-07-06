package model

import (
	"encoding/base64"
	"time"
)

type RemotePublishStatus string

const (
	RemotePublishPending   = RemotePublishStatus("pending")
	RemotePublishSucceeded = RemotePublishStatus("succeeded")
	RemotePublishFailed    = RemotePublishStatus("failed")
)

type RemoteEpisodeStatus string

const (
	RemoteEpisodeStatusPending       = RemoteEpisodeStatus("pending")
	RemoteEpisodeStatusVisible       = RemoteEpisodeStatus("visible")
	RemoteEpisodeStatusHidden        = RemoteEpisodeStatus("hidden")
	RemoteEpisodeStatusDeletePending = RemoteEpisodeStatus("delete_pending")
	RemoteEpisodeStatusPurged        = RemoteEpisodeStatus("purged")
)

type RemoteTombstoneAction string

const (
	RemoteTombstoneActionHide    = RemoteTombstoneAction("hide")
	RemoteTombstoneActionDelete  = RemoteTombstoneAction("delete")
	RemoteTombstoneActionPurge   = RemoteTombstoneAction("purge")
	RemoteTombstoneActionRestore = RemoteTombstoneAction("restore")
)

type RemoteTombstoneChange struct {
	Sequence       int64                 `json:"sequence"`
	FeedID         string                `json:"feed_id"`
	LocalEpisodeID string                `json:"local_episode_id"`
	Status         RemoteEpisodeStatus   `json:"status"`
	Action         RemoteTombstoneAction `json:"action"`
	CreatedAt      string                `json:"created_at"`
}

type RemoteTombstoneBatch struct {
	Cursor     int64                   `json:"cursor"`
	NextCursor int64                   `json:"next_cursor"`
	HasMore    bool                    `json:"has_more"`
	Changes    []RemoteTombstoneChange `json:"changes"`
}

type RemoteSyncRunStatus string

const (
	RemoteSyncRunRunning = RemoteSyncRunStatus("running")
	RemoteSyncRunSuccess = RemoteSyncRunStatus("success")
	RemoteSyncRunPartial = RemoteSyncRunStatus("partial")
	RemoteSyncRunFailed  = RemoteSyncRunStatus("failed")
)

type RemoteEventLevel string

const (
	RemoteEventDebug = RemoteEventLevel("debug")
	RemoteEventInfo  = RemoteEventLevel("info")
	RemoteEventWarn  = RemoteEventLevel("warn")
	RemoteEventError = RemoteEventLevel("error")
)

type RemoteEventType string

const (
	RemoteEventSyncRunStarted       = RemoteEventType("sync_run_started")
	RemoteEventSyncRunFinished      = RemoteEventType("sync_run_finished")
	RemoteEventConfigFetched        = RemoteEventType("remote_config_fetched")
	RemoteEventConfigFallbackUsed   = RemoteEventType("remote_config_fallback_used")
	RemoteEventConfigInvalid        = RemoteEventType("remote_config_invalid")
	RemoteEventFeedUpdateStarted    = RemoteEventType("feed_update_started")
	RemoteEventFeedUpdateFinished   = RemoteEventType("feed_update_finished")
	RemoteEventFeedUpdateFailed     = RemoteEventType("feed_update_failed")
	RemoteEventEpisodeDiscovered    = RemoteEventType("episode_discovered")
	RemoteEventDownloadFinished     = RemoteEventType("episode_download_finished")
	RemoteEventDownloadFailed       = RemoteEventType("episode_download_failed")
	RemoteEventUploadFinished       = RemoteEventType("episode_upload_finished")
	RemoteEventUploadFailed         = RemoteEventType("episode_upload_failed")
	RemoteEventReportFinished       = RemoteEventType("episode_report_finished")
	RemoteEventReportFailed         = RemoteEventType("episode_report_failed")
	RemoteEventTombstoneFetched     = RemoteEventType("tombstone_fetched")
	RemoteEventTombstoneApplied     = RemoteEventType("tombstone_applied")
	RemoteEventTombstoneApplyFailed = RemoteEventType("tombstone_apply_failed")
)

type RemoteSyncRun struct {
	ID                 string              `json:"id"`
	StartedAt          string              `json:"started_at"`
	FinishedAt         *string             `json:"finished_at"`
	Status             RemoteSyncRunStatus `json:"status"`
	FeedsUpdated       int                 `json:"feeds_updated"`
	EpisodesDownloaded int                 `json:"episodes_downloaded"`
	EpisodesUploaded   int                 `json:"episodes_uploaded"`
	ErrorsCount        int                 `json:"errors_count"`
}

type RemoteEventDraft struct {
	Level          RemoteEventLevel `json:"-"`
	Type           RemoteEventType  `json:"-"`
	FeedID         string           `json:"-"`
	LocalEpisodeID string           `json:"-"`
	Message        string           `json:"-"`
	ErrorCode      string           `json:"-"`
	ErrorDetail    string           `json:"-"`
}

type RemoteEvent struct {
	Sequence       int              `json:"sequence"`
	EventTime      string           `json:"event_time"`
	Level          RemoteEventLevel `json:"level"`
	Type           RemoteEventType  `json:"type"`
	FeedID         string           `json:"feed_id,omitempty"`
	LocalEpisodeID string           `json:"local_episode_id,omitempty"`
	Message        string           `json:"message,omitempty"`
	ErrorCode      string           `json:"error_code,omitempty"`
	ErrorDetail    string           `json:"error_detail,omitempty"`
}

type RemoteEventBatch struct {
	Run    RemoteSyncRun `json:"run"`
	Events []RemoteEvent `json:"events"`
}

type RemoteEventBatchResult struct {
	OK              bool   `json:"ok"`
	RunID           string `json:"run_id"`
	AcceptedEvents  int    `json:"accepted_events"`
	InsertedEvents  int    `json:"inserted_events"`
	DuplicateEvents int    `json:"duplicate_events"`
}

func (s RemoteEpisodeStatus) IsTombstoned() bool {
	return s == RemoteEpisodeStatusHidden ||
		s == RemoteEpisodeStatusDeletePending ||
		s == RemoteEpisodeStatusPurged
}

func (s RemoteEpisodeStatus) IsValidTombstoneResponseStatus() bool {
	return s == RemoteEpisodeStatusVisible || s.IsTombstoned()
}

func (a RemoteTombstoneAction) IsValid() bool {
	return a == RemoteTombstoneActionHide ||
		a == RemoteTombstoneActionDelete ||
		a == RemoteTombstoneActionPurge ||
		a == RemoteTombstoneActionRestore
}

func (c RemoteTombstoneChange) HasConsistentStatusAction() bool {
	switch c.Status {
	case RemoteEpisodeStatusVisible:
		return c.Action == RemoteTombstoneActionRestore
	case RemoteEpisodeStatusHidden:
		return c.Action == RemoteTombstoneActionHide
	case RemoteEpisodeStatusDeletePending:
		return c.Action == RemoteTombstoneActionDelete
	case RemoteEpisodeStatusPurged:
		return c.Action == RemoteTombstoneActionPurge
	default:
		return false
	}
}

type RemotePublishTask struct {
	ID              string              `json:"id"`
	FeedID          string              `json:"feed_id"`
	Provider        Provider            `json:"provider"`
	LocalEpisodeID  string              `json:"local_episode_id"`
	SourceEpisodeID string              `json:"source_episode_id"`
	MediaPath       string              `json:"media_path"`
	Size            int64               `json:"size"`
	Title           string              `json:"title"`
	Description     string              `json:"description"`
	Thumbnail       string              `json:"thumbnail"`
	Duration        int64               `json:"duration"`
	SourceURL       string              `json:"source_url"`
	PublishedAt     time.Time           `json:"published_at"`
	Status          RemotePublishStatus `json:"status"`
	Attempts        int                 `json:"attempts"`
	NextAttemptAt   time.Time           `json:"next_attempt_at"`
	LastError       string              `json:"last_error"`
	R2Key           string              `json:"r2_key"`
	AssetToken      string              `json:"asset_token"`
	MimeType        string              `json:"mime_type"`
	ServerStatus    string              `json:"server_status"`
	UpsertedAt      time.Time           `json:"upserted_at"`
	CompletedAt     time.Time           `json:"completed_at"`
	CreatedAt       time.Time           `json:"created_at"`
	UpdatedAt       time.Time           `json:"updated_at"`
}

func RemotePublishTaskID(feedID, localEpisodeID string) string {
	feedPart := base64.RawURLEncoding.EncodeToString([]byte(feedID))
	episodePart := base64.RawURLEncoding.EncodeToString([]byte(localEpisodeID))
	return "publish_episode:" + feedPart + ":" + episodePart
}

func RemotePublishNextAttempt(now time.Time, attempts int) time.Time {
	if attempts <= 3 {
		return now
	}
	if attempts >= 9 {
		return now.Add(24 * time.Hour)
	}
	hours := 1 << (attempts - 4)
	return now.Add(time.Duration(hours) * time.Hour)
}
