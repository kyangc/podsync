package builder

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"
)

func TestNewBilibiliBuilderFromFactory(t *testing.T) {
	builder, err := New(context.Background(), model.ProviderBilibili, "", nil)
	require.NoError(t, err)
	require.IsType(t, &BilibiliBuilder{}, builder)
}

func TestBilibiliBuildUserFeedSkipsUpowerVideos(t *testing.T) {
	server := newBilibiliTestServer(t)
	builder := &BilibiliBuilder{
		client: newBilibiliAPIClient(server.Client(), server.URL),
	}

	got, err := builder.Build(context.Background(), &feed.Config{
		URL:      "https://space.bilibili.com/123",
		PageSize: 1,
		Format:   model.FormatAudio,
		Quality:  model.QualityHigh,
	})

	require.NoError(t, err)
	require.Equal(t, model.ProviderBilibili, got.Provider)
	require.Equal(t, model.TypeUser, got.LinkType)
	require.Equal(t, "123", got.ItemID)
	require.Equal(t, "Bili Creator", got.Title)
	require.Equal(t, "Bili Creator", got.Author)
	require.Equal(t, "Creator signature", got.Description)
	require.Equal(t, "https://space.bilibili.com/123", got.ItemURL)
	require.Len(t, got.Episodes, 1)

	require.Equal(t, "BVUSER2", got.Episodes[0].ID)
	require.Equal(t, "First public video", got.Episodes[0].Title)
	require.Equal(t, "https://www.bilibili.com/video/BVUSER2", got.Episodes[0].VideoURL)
	require.Equal(t, int64(600), got.Episodes[0].Duration)
	require.Equal(t, model.EpisodeNew, got.Episodes[0].Status)
}

func TestBilibiliBuildSeasonAndSeriesFeeds(t *testing.T) {
	server := newBilibiliTestServer(t)
	builder := &BilibiliBuilder{
		client: newBilibiliAPIClient(server.Client(), server.URL),
	}

	season, err := builder.Build(context.Background(), &feed.Config{
		URL:      "https://space.bilibili.com/123/lists/456?type=season",
		PageSize: 2,
	})
	require.NoError(t, err)
	require.Equal(t, model.TypeSeason, season.LinkType)
	require.Equal(t, "Season Title", season.Title)
	require.Equal(t, "Season description", season.Description)
	require.Equal(t, "https://cdn.example.com/season.jpg", season.CoverArt)
	require.Len(t, season.Episodes, 1)
	require.Equal(t, "BVSEASON1", season.Episodes[0].ID)

	series, err := builder.Build(context.Background(), &feed.Config{
		URL:      "https://space.bilibili.com/123/lists/789?type=series",
		PageSize: 2,
	})
	require.NoError(t, err)
	require.Equal(t, model.TypeSeries, series.LinkType)
	require.Equal(t, "Series Title", series.Title)
	require.Equal(t, "Series description", series.Description)
	require.Equal(t, "https://cdn.example.com/face.jpg", series.CoverArt)
	require.Len(t, series.Episodes, 1)
	require.Equal(t, "BVSERIES1", series.Episodes[0].ID)
}

func TestBilibiliLiveSmoke(t *testing.T) {
	addr := os.Getenv("BILIBILI_TEST_URL")
	if addr == "" {
		t.Skip("BILIBILI_TEST_URL is not set")
	}

	builder, err := NewBilibiliBuilder()
	require.NoError(t, err)

	got, err := builder.Build(context.Background(), &feed.Config{
		URL:      addr,
		PageSize: 1,
		Format:   model.FormatAudio,
		Quality:  model.QualityHigh,
	})

	require.NoError(t, err)
	require.Equal(t, model.ProviderBilibili, got.Provider)
	require.NotEmpty(t, got.Title)
	require.NotEmpty(t, got.Author)
	require.NotEmpty(t, got.ItemURL)
	require.NotEmpty(t, got.Episodes)
	require.NotEmpty(t, got.Episodes[0].ID)
	require.NotEmpty(t, got.Episodes[0].Title)
	require.NotEmpty(t, got.Episodes[0].VideoURL)
	require.NotZero(t, got.Episodes[0].Duration)
}

func newBilibiliTestServer(t *testing.T) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/x/web-interface/card", func(w http.ResponseWriter, r *http.Request) {
		if !assertRequestValue(t, w, "referer", "https://www.bilibili.com/", r.Header.Get("Referer")) {
			return
		}
		if !assertRequestValue(t, w, "mid", "123", r.URL.Query().Get("mid")) {
			return
		}
		writeJSON(t, w, map[string]any{
			"code": 0,
			"data": map[string]any{
				"card": map[string]any{
					"name": "Bili Creator",
					"face": "https://cdn.example.com/face.jpg",
					"sign": "Creator signature",
				},
			},
		})
	})
	mux.HandleFunc("/x/series/recArchivesByKeywords", func(w http.ResponseWriter, r *http.Request) {
		if !assertRequestValue(t, w, "mid", "123", r.URL.Query().Get("mid")) {
			return
		}
		if !assertRequestValue(t, w, "pn", "1", r.URL.Query().Get("pn")) {
			return
		}
		if !assertRequestValue(t, w, "ps", "100", r.URL.Query().Get("ps")) {
			return
		}
		writeJSON(t, w, map[string]any{
			"code": 0,
			"data": map[string]any{
				"archives": []map[string]any{
					{"bvid": "BVUSER1", "pubdate": 1700000000},
					{"bvid": "BVUSER2", "pubdate": 1700000100},
				},
			},
		})
	})
	mux.HandleFunc("/x/polymer/web-space/seasons_archives_list", func(w http.ResponseWriter, r *http.Request) {
		if !assertRequestValue(t, w, "mid", "123", r.URL.Query().Get("mid")) {
			return
		}
		if !assertRequestValue(t, w, "season_id", "456", r.URL.Query().Get("season_id")) {
			return
		}
		writeJSON(t, w, map[string]any{
			"code": 0,
			"data": map[string]any{
				"meta": map[string]any{
					"name":        "Season Title",
					"description": "Season description",
					"cover":       "https://cdn.example.com/season.jpg",
				},
				"archives": []map[string]any{
					{"bvid": "BVSEASON1", "pubdate": 1700000300},
				},
			},
		})
	})
	mux.HandleFunc("/x/series/series", func(w http.ResponseWriter, r *http.Request) {
		if !assertRequestValue(t, w, "series_id", "789", r.URL.Query().Get("series_id")) {
			return
		}
		writeJSON(t, w, map[string]any{
			"code": 0,
			"data": map[string]any{
				"meta": map[string]any{
					"name":        "Series Title",
					"description": "Series description",
				},
			},
		})
	})
	mux.HandleFunc("/x/series/archives", func(w http.ResponseWriter, r *http.Request) {
		if !assertRequestValue(t, w, "mid", "123", r.URL.Query().Get("mid")) {
			return
		}
		if !assertRequestValue(t, w, "series_id", "789", r.URL.Query().Get("series_id")) {
			return
		}
		writeJSON(t, w, map[string]any{
			"code": 0,
			"data": map[string]any{
				"archives": []map[string]any{
					{"bvid": "BVSERIES1", "pubdate": 1700000400},
				},
			},
		})
	})
	mux.HandleFunc("/x/web-interface/view", func(w http.ResponseWriter, r *http.Request) {
		bvid := r.URL.Query().Get("bvid")
		response := map[string]any{
			"code": 0,
			"data": map[string]any{
				"bvid":                bvid,
				"title":               titleForBvid(bvid),
				"desc":                "Description for " + bvid,
				"pic":                 "https://cdn.example.com/" + bvid + ".jpg",
				"duration":            600,
				"is_upower_exclusive": bvid == "BVUSER1",
			},
		}
		writeJSON(t, w, response)
	})

	return httptest.NewServer(mux)
}

func assertRequestValue(t *testing.T, w http.ResponseWriter, name, want, got string) bool {
	t.Helper()

	if got == want {
		return true
	}

	t.Errorf("unexpected %s: want %q, got %q", name, want, got)
	http.Error(w, "unexpected request value", http.StatusBadRequest)
	return false
}

func titleForBvid(bvid string) string {
	switch bvid {
	case "BVUSER1":
		return "Exclusive video"
	case "BVUSER2":
		return "First public video"
	case "BVSEASON1":
		return "Season video"
	case "BVSERIES1":
		return "Series video"
	default:
		return bvid
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Errorf("failed to encode json response: %v", err)
	}
}
