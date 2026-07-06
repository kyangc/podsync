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

func TestNASClientFetchTombstonesSendsExpectedRequest(t *testing.T) {
	var gotAuth string
	var gotAccept string
	var gotPath string
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		require.Equal(t, http.MethodGet, r.Method)
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(model.RemoteTombstoneBatch{
			Cursor:     7,
			NextCursor: 8,
			Changes: []model.RemoteTombstoneChange{{
				Sequence:       8,
				FeedID:         "feed",
				LocalEpisodeID: "episode",
				Status:         model.RemoteEpisodeStatusHidden,
				Action:         model.RemoteTombstoneActionHide,
			}},
		}))
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	batch, err := client.FetchTombstones(context.Background(), 7, 100)

	require.NoError(t, err)
	assert.Equal(t, int64(8), batch.NextCursor)
	assert.Equal(t, "Bearer secret", gotAuth)
	assert.Equal(t, "application/json", gotAccept)
	assert.Equal(t, "/api/nas/tombstones", gotPath)
	assert.Contains(t, gotQuery, "cursor=7")
	assert.Contains(t, gotQuery, "limit=100")
}

func TestNASClientFetchTombstonesUsesDefaultLimitWhenZero(t *testing.T) {
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"cursor":0,"next_cursor":0,"has_more":false,"changes":[]}`))
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	_, err = client.FetchTombstones(context.Background(), 0, 0)

	require.NoError(t, err)
	assert.Contains(t, gotQuery, "cursor=0")
	assert.NotContains(t, gotQuery, "limit=")
}

func TestNASClientFetchTombstonesClearsBaseURLQuery(t *testing.T) {
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"cursor":0,"next_cursor":0,"has_more":false,"changes":[]}`))
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL+"?stale=1", "secret", server.Client())
	require.NoError(t, err)

	_, err = client.FetchTombstones(context.Background(), 0, 100)

	require.NoError(t, err)
	assert.Contains(t, gotQuery, "cursor=0")
	assert.Contains(t, gotQuery, "limit=100")
	assert.NotContains(t, gotQuery, "stale=1")
}

func TestNASClientFetchTombstonesRejectsCursorMismatch(t *testing.T) {
	client := newTombstoneResponseClient(t, `{"cursor":8,"next_cursor":8,"has_more":false,"changes":[]}`, http.StatusOK)

	_, err := client.FetchTombstones(context.Background(), 7, 100)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "cursor mismatch")
}

func TestNASClientFetchTombstonesRejectsBackwardCursor(t *testing.T) {
	client := newTombstoneResponseClient(t, `{"cursor":7,"next_cursor":6,"has_more":false,"changes":[]}`, http.StatusOK)

	_, err := client.FetchTombstones(context.Background(), 7, 100)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "moved backwards")
}

func TestNASClientFetchTombstonesRejectsInvalidChange(t *testing.T) {
	client := newTombstoneResponseClient(t, `{
		"cursor":7,
		"next_cursor":8,
		"changes":[{"sequence":8,"feed_id":"","local_episode_id":"episode","status":"hidden","action":"hide"}]
	}`, http.StatusOK)

	_, err := client.FetchTombstones(context.Background(), 7, 100)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "feed_id")
}

func TestNASClientFetchTombstonesRejectsMismatchedStatusAction(t *testing.T) {
	client := newTombstoneResponseClient(t, `{
		"cursor":7,
		"next_cursor":8,
		"changes":[{"sequence":8,"feed_id":"feed","local_episode_id":"episode","status":"hidden","action":"restore"}]
	}`, http.StatusOK)

	_, err := client.FetchTombstones(context.Background(), 7, 100)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "status/action mismatch")
}

func TestNASClientFetchTombstonesRejectsUnorderedIncrementalSequence(t *testing.T) {
	client := newTombstoneResponseClient(t, `{
		"cursor":7,
		"next_cursor":8,
		"changes":[
			{"sequence":9,"feed_id":"feed","local_episode_id":"first","status":"hidden","action":"hide"},
			{"sequence":8,"feed_id":"feed","local_episode_id":"second","status":"delete_pending","action":"delete"}
		]
	}`, http.StatusOK)

	_, err := client.FetchTombstones(context.Background(), 7, 100)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "strictly increasing")
}

func TestNASClientFetchTombstonesRejectsIncrementalCursorJump(t *testing.T) {
	tests := []string{
		`{"cursor":10,"next_cursor":99,"has_more":false,"changes":[]}`,
		`{"cursor":10,"next_cursor":99,"has_more":true,"changes":[]}`,
		`{
			"cursor":10,
			"next_cursor":99,
			"has_more":false,
			"changes":[{"sequence":11,"feed_id":"feed","local_episode_id":"episode","status":"hidden","action":"hide"}]
		}`,
	}
	for _, body := range tests {
		t.Run(body, func(t *testing.T) {
			client := newTombstoneResponseClient(t, body, http.StatusOK)

			_, err := client.FetchTombstones(context.Background(), 10, 100)

			require.Error(t, err)
		})
	}
}

func TestNASClientFetchTombstonesAllowsCursorZeroSnapshotSequence(t *testing.T) {
	client := newTombstoneResponseClient(t, `{
		"cursor":0,
		"next_cursor":55,
		"has_more":false,
		"changes":[
			{"sequence":0,"feed_id":"feed","local_episode_id":"hidden","status":"hidden","action":"hide"},
			{"sequence":0,"feed_id":"feed","local_episode_id":"delete","status":"delete_pending","action":"delete"},
			{"sequence":0,"feed_id":"feed","local_episode_id":"purged","status":"purged","action":"purge"}
		]
	}`, http.StatusOK)

	batch, err := client.FetchTombstones(context.Background(), 0, 100)

	require.NoError(t, err)
	assert.Equal(t, int64(55), batch.NextCursor)
	assert.Len(t, batch.Changes, 3)
}

func TestNASClientFetchTombstonesRedactsTokenInErrors(t *testing.T) {
	client := newTombstoneResponseClientWithToken(t, `bad secret-token`, http.StatusForbidden, "secret-token")

	_, err := client.FetchTombstones(context.Background(), 0, 100)

	require.Error(t, err)
	assert.NotContains(t, err.Error(), "secret-token")
	assert.Contains(t, err.Error(), "[redacted]")
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

func newTombstoneResponseClient(t *testing.T, body string, status int) *NASClient {
	t.Helper()
	return newTombstoneResponseClientWithToken(t, body, status, "secret")
}

func newTombstoneResponseClientWithToken(t *testing.T, body string, status int, token string) *NASClient {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	client, err := NewNASClient(server.URL, token, server.Client())
	require.NoError(t, err)
	return client
}
