package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/mxpv/podsync/pkg/model"
)

const defaultNASClientTimeout = 30 * time.Second
const maxNASClientErrorBody = 4 * 1024

type HTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

type EpisodeUpsertResult struct {
	Status string `json:"status"`
}

type EpisodeUpserter interface {
	UpsertEpisode(ctx context.Context, task *model.RemotePublishTask) (*EpisodeUpsertResult, error)
}

type NonRetryableError struct {
	err error
}

func (e *NonRetryableError) Error() string {
	return e.err.Error()
}

func (e *NonRetryableError) Unwrap() error {
	return e.err
}

func IsNonRetryable(err error) bool {
	var target *NonRetryableError
	return errors.As(err, &target)
}

type NASClient struct {
	baseURL *url.URL
	token   string
	client  HTTPClient
}

func NewNASClient(baseURL string, token string, client HTTPClient) (*NASClient, error) {
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("remote token is required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("remote base url must be an absolute URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("remote base url must use http or https")
	}
	if client == nil {
		client = &http.Client{Timeout: defaultNASClientTimeout}
	}
	return &NASClient{baseURL: parsed, token: token, client: client}, nil
}

func (c *NASClient) UpsertEpisode(ctx context.Context, task *model.RemotePublishTask) (*EpisodeUpsertResult, error) {
	payload, err := episodeUpsertPayloadFromTask(task)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.episodeUpsertURL(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(readLimitedString(resp.Body, maxNASClientErrorBody))
		message = strings.ReplaceAll(message, c.token, "[redacted]")
		var err error
		if message == "" {
			err = fmt.Errorf("episode upsert returned HTTP %d", resp.StatusCode)
		} else {
			err = fmt.Errorf("episode upsert returned HTTP %d: %s", resp.StatusCode, message)
		}
		if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusNotFound {
			return nil, &NonRetryableError{err: err}
		}
		return nil, err
	}

	var result EpisodeUpsertResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if result.Status == "" {
		return nil, errors.New("episode upsert response status is required")
	}
	return &result, nil
}

func (c *NASClient) episodeUpsertURL() string {
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/nas/episodes/upsert"
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	return endpoint.String()
}

type episodeUpsertPayload struct {
	FeedID          string `json:"feed_id"`
	Provider        string `json:"provider"`
	SourceEpisodeID string `json:"source_episode_id"`
	LocalEpisodeID  string `json:"local_episode_id"`
	SourceURL       string `json:"source_url,omitempty"`
	Thumbnail       string `json:"thumbnail,omitempty"`
	Title           string `json:"title,omitempty"`
	Description     string `json:"description,omitempty"`
	PublishedAt     string `json:"published_at,omitempty"`
	Duration        int64  `json:"duration,omitempty"`
	R2Key           string `json:"r2_key"`
	Size            int64  `json:"size"`
	MimeType        string `json:"mime_type"`
	AssetToken      string `json:"asset_token"`
}

func episodeUpsertPayloadFromTask(task *model.RemotePublishTask) (*episodeUpsertPayload, error) {
	if task == nil {
		return nil, nonRetryable("remote publish task is required")
	}
	provider := task.Provider
	if provider == "" {
		provider = inferProviderFromLegacyEpisodeURL(task.SourceURL)
	}
	if provider != model.ProviderYoutube && provider != model.ProviderBilibili {
		return nil, nonRetryable("remote publish task provider is unsupported")
	}
	sourceEpisodeID := task.SourceEpisodeID
	if sourceEpisodeID == "" {
		sourceEpisodeID = task.LocalEpisodeID
	}
	if task.FeedID == "" || task.LocalEpisodeID == "" || sourceEpisodeID == "" || task.R2Key == "" || task.MimeType == "" || task.AssetToken == "" {
		return nil, nonRetryable("remote publish task is missing required upsert metadata")
	}
	payload := &episodeUpsertPayload{
		FeedID:          task.FeedID,
		Provider:        string(provider),
		SourceEpisodeID: sourceEpisodeID,
		LocalEpisodeID:  task.LocalEpisodeID,
		SourceURL:       task.SourceURL,
		Thumbnail:       task.Thumbnail,
		Title:           task.Title,
		Description:     task.Description,
		Duration:        task.Duration,
		R2Key:           task.R2Key,
		Size:            task.Size,
		MimeType:        task.MimeType,
		AssetToken:      task.AssetToken,
	}
	if !task.PublishedAt.IsZero() {
		payload.PublishedAt = task.PublishedAt.UTC().Format(time.RFC3339)
	}
	return payload, nil
}

func inferProviderFromLegacyEpisodeURL(rawURL string) model.Provider {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	path := parsed.EscapedPath()
	switch {
	case (host == "youtube.com" || strings.HasSuffix(host, ".youtube.com")) && path == "/watch":
		return model.ProviderYoutube
	case host == "youtu.be" || strings.HasSuffix(host, ".youtu.be"):
		return model.ProviderYoutube
	case (host == "bilibili.com" || strings.HasSuffix(host, ".bilibili.com")) && strings.HasPrefix(path, "/video/"):
		return model.ProviderBilibili
	default:
		return ""
	}
}

func nonRetryable(message string) error {
	return &NonRetryableError{err: errors.New(message)}
}

func readLimitedString(reader io.Reader, limit int64) string {
	data, _ := io.ReadAll(io.LimitReader(reader, limit))
	return string(data)
}
