package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

func TestNASClientUpsertEpisodePostsExpectedPayload(t *testing.T) {
	task := newClientTask()
	var gotAuth string
	var gotPath string
	var gotPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotPayload))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"status":"visible"}`))
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	result, err := client.UpsertEpisode(context.Background(), task)

	require.NoError(t, err)
	assert.Equal(t, "visible", result.Status)
	assert.Equal(t, "Bearer secret", gotAuth)
	assert.Equal(t, "/api/nas/episodes/upsert", gotPath)
	assert.Equal(t, "feed", gotPayload["feed_id"])
	assert.Equal(t, "youtube", gotPayload["provider"])
	assert.Equal(t, "source", gotPayload["source_episode_id"])
	assert.Equal(t, "episode", gotPayload["local_episode_id"])
	assert.Equal(t, "https://www.youtube.com/watch?v=source", gotPayload["source_url"])
	assert.Equal(t, "Episode", gotPayload["title"])
	assert.Equal(t, "Description", gotPayload["description"])
	assert.Equal(t, "https://img.example.com/source.jpg", gotPayload["thumbnail"])
	assert.Equal(t, "2026-07-06T12:00:00Z", gotPayload["published_at"])
	assert.Equal(t, float64(123), gotPayload["duration"])
	assert.Equal(t, "audio/feed/episode-token.mp3", gotPayload["r2_key"])
	assert.Equal(t, float64(456), gotPayload["size"])
	assert.Equal(t, "audio/mpeg", gotPayload["mime_type"])
	assert.Equal(t, "asset-token", gotPayload["asset_token"])
}

func TestNASClientUpsertEpisodeNormalizesLegacyTask(t *testing.T) {
	task := newClientTask()
	task.Provider = ""
	task.SourceEpisodeID = ""
	var gotPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotPayload))
		_, _ = w.Write([]byte(`{"status":"visible"}`))
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	_, err = client.UpsertEpisode(context.Background(), task)

	require.NoError(t, err)
	assert.Equal(t, "youtube", gotPayload["provider"])
	assert.Equal(t, "episode", gotPayload["source_episode_id"])
}

func TestInferProviderFromLegacyEpisodeURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want model.Provider
	}{
		{name: "youtube watch", url: "https://www.youtube.com/watch?v=abc", want: model.ProviderYoutube},
		{name: "youtube short host", url: "https://youtu.be/abc", want: model.ProviderYoutube},
		{name: "bilibili video", url: "https://www.bilibili.com/video/BV1", want: model.ProviderBilibili},
		{name: "unsupported", url: "https://example.com/video/1", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, inferProviderFromLegacyEpisodeURL(tt.url))
		})
	}
}

func TestNASClientRejectsUnsupportedLegacyProvider(t *testing.T) {
	task := newClientTask()
	task.Provider = ""
	task.SourceURL = "https://example.com/video/1"
	client, err := NewNASClient("https://podcast.example.com", "secret", nil)
	require.NoError(t, err)

	_, err = client.UpsertEpisode(context.Background(), task)

	require.Error(t, err)
	assert.True(t, IsNonRetryable(err))
}

func TestNASClientUpsertEpisodeRejectsNon2xx(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusBadGateway)
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	_, err = client.UpsertEpisode(context.Background(), newClientTask())

	require.Error(t, err)
	assert.Contains(t, err.Error(), "HTTP 502")
	assert.Contains(t, err.Error(), "boom")
	assert.False(t, IsNonRetryable(err))
}

func TestNASClientUpsertEpisodeMarksValidationHTTPStatusNonRetryable(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "bad episode", status)
			}))
			defer server.Close()
			client, err := NewNASClient(server.URL, "secret", server.Client())
			require.NoError(t, err)

			_, err = client.UpsertEpisode(context.Background(), newClientTask())

			require.Error(t, err)
			assert.True(t, IsNonRetryable(err))
			assert.Contains(t, err.Error(), "HTTP")
		})
	}
}

func TestNASClientUpsertEpisodeTruncatesErrorBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(strings.Repeat("x", maxNASClientErrorBody+100)))
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	_, err = client.UpsertEpisode(context.Background(), newClientTask())

	require.Error(t, err)
	assert.LessOrEqual(t, len(err.Error()), maxNASClientErrorBody+64)
}

func TestNASClientDoesNotLeakTokenInErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "bad secret-token", http.StatusForbidden)
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret-token", server.Client())
	require.NoError(t, err)

	_, err = client.UpsertEpisode(context.Background(), newClientTask())

	require.Error(t, err)
	assert.NotContains(t, err.Error(), "secret-token")
	assert.Contains(t, err.Error(), "[redacted]")
}

func TestNASClientRequiresBaseURLAndToken(t *testing.T) {
	_, err := NewNASClient("", "secret", nil)
	require.Error(t, err)

	_, err = NewNASClient("https://podcast.example.com", "", nil)
	require.Error(t, err)

	_, err = NewNASClient("https://podcast.example.com", " \t", nil)
	require.Error(t, err)
}

func TestNASClientRequiresHTTPOrHTTPSBaseURL(t *testing.T) {
	_, err := NewNASClient("ftp://podcast.example.com", "secret", nil)

	require.Error(t, err)
}

func TestNASClientRejectsEmptyResponseStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	_, err = client.UpsertEpisode(context.Background(), newClientTask())

	require.Error(t, err)
}

func TestIsNonRetryable(t *testing.T) {
	assert.True(t, IsNonRetryable(nonRetryable("bad metadata")))
	assert.False(t, IsNonRetryable(errors.New("temporary")))
}

func newClientTask() *model.RemotePublishTask {
	return &model.RemotePublishTask{
		ID:              model.RemotePublishTaskID("feed", "episode"),
		FeedID:          "feed",
		Provider:        model.ProviderYoutube,
		SourceEpisodeID: "source",
		LocalEpisodeID:  "episode",
		SourceURL:       "https://www.youtube.com/watch?v=source",
		Thumbnail:       "https://img.example.com/source.jpg",
		Title:           "Episode",
		Description:     "Description",
		PublishedAt:     time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC),
		Duration:        123,
		R2Key:           "audio/feed/episode-token.mp3",
		Size:            456,
		MimeType:        "audio/mpeg",
		AssetToken:      "asset-token",
	}
}
