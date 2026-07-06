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
