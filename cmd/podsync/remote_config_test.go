package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/feed"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) Do(req *http.Request) (*http.Response, error) {
	return f(req)
}

func textResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func TestRemoteConfigURLAppendsAPIPath(t *testing.T) {
	got, err := remoteConfigURL("https://podcast.example.com/base/")

	require.NoError(t, err)
	assert.Equal(t, "https://podcast.example.com/base/api/nas/config.toml", got)
}

func TestResolveFeedsUsesRemoteAndReturnsCacheCandidate(t *testing.T) {
	body := `
[feeds."bili.feed-1"]
url = "https://space.bilibili.com/10835521"
cookie_profile = "main"
filters = { not_title = "直播" }
`
	cfg := remoteResolverConfig(t)
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		assert.Equal(t, "/api/nas/config.toml", req.URL.Path)
		assert.Equal(t, "Bearer secret", req.Header.Get("Authorization"))
		assert.Contains(t, req.Header.Get("Accept"), "application/toml")
		return textResponse(http.StatusOK, body), nil
	})

	resolved, err := resolveFeeds(context.Background(), cfg, client)

	require.NoError(t, err)
	assert.Equal(t, remoteFeedSourceRemote, resolved.Source)
	require.Contains(t, resolved.Feeds, "bili.feed-1")
	remoteFeed := resolved.Feeds["bili.feed-1"]
	assert.Equal(t, "bili.feed-1", remoteFeed.ID)
	assert.Equal(t, "/cookies/bilibili.txt", remoteFeed.Bilibili.CookiesFile)
	assert.Equal(t, "直播", remoteFeed.Filters.NotTitle)
	assert.Equal(t, []byte(body), resolved.CacheData)

	require.NoError(t, writeAcceptedRemoteConfigCache(cfg, resolved))
	cached, err := os.ReadFile(cfg.Remote.CachePath)
	require.NoError(t, err)
	assert.Equal(t, body, string(cached))
}

func TestResolveFeedsAcceptsEmptyRemoteFeedSet(t *testing.T) {
	cfg := remoteResolverConfig(t)
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return textResponse(http.StatusOK, ""), nil
	})

	resolved, err := resolveFeeds(context.Background(), cfg, client)

	require.NoError(t, err)
	assert.Equal(t, remoteFeedSourceRemote, resolved.Source)
	assert.Empty(t, resolved.Feeds)
	require.NotNil(t, resolved.CacheData)
	assert.Len(t, resolved.CacheData, 0)

	require.NoError(t, writeAcceptedRemoteConfigCache(cfg, resolved))
	info, err := os.Stat(cfg.Remote.CachePath)
	require.NoError(t, err)
	assert.EqualValues(t, 0, info.Size())
}

func TestResolveFeedsFallsBackToCache(t *testing.T) {
	cfg := remoteResolverConfig(t)
	require.NoError(t, os.WriteFile(cfg.Remote.CachePath, []byte(`
[feeds.cached]
url = "https://youtube.com/watch?v=ygIUF678y40"
`), 0o600))
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return textResponse(http.StatusInternalServerError, "boom"), nil
	})

	resolved, err := resolveFeeds(context.Background(), cfg, client)

	require.Error(t, err)
	assert.Equal(t, remoteFeedSourceCache, resolved.Source)
	require.Contains(t, resolved.Feeds, "cached")
}

func TestResolveFeedsInvalidRemoteDoesNotOverwriteCache(t *testing.T) {
	cfg := remoteResolverConfig(t)
	cached := []byte(`
[feeds.cached]
url = "https://youtube.com/watch?v=ygIUF678y40"
`)
	require.NoError(t, os.WriteFile(cfg.Remote.CachePath, cached, 0o600))
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return textResponse(http.StatusOK, "[feeds.bad"), nil
	})

	resolved, err := resolveFeeds(context.Background(), cfg, client)

	require.Error(t, err)
	assert.Equal(t, remoteFeedSourceCache, resolved.Source)
	if resolved.CacheData != nil {
		require.NoError(t, writeAcceptedRemoteConfigCache(cfg, resolved))
	}
	got, readErr := os.ReadFile(cfg.Remote.CachePath)
	require.NoError(t, readErr)
	assert.Equal(t, cached, got)
}

func TestResolveFeedsFallsBackToOriginalLocalFeeds(t *testing.T) {
	cfg := remoteResolverConfig(t)
	cfg.LocalFeeds = map[string]*feed.Config{
		"local": {ID: "local", URL: "https://youtube.com/watch?v=ygIUF678y40"},
	}
	cfg.Feeds = map[string]*feed.Config{
		"remote-looking": {ID: "remote-looking", URL: "https://youtube.com/watch?v=abc"},
	}
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return textResponse(http.StatusInternalServerError, "boom"), nil
	})

	resolved, err := resolveFeeds(context.Background(), cfg, client)

	require.Error(t, err)
	assert.Equal(t, remoteFeedSourceLocalFallback, resolved.Source)
	assert.Same(t, cfg.LocalFeeds["local"], resolved.Feeds["local"])
	assert.NotContains(t, resolved.Feeds, "remote-looking")
}

func TestResolveFeedsReturnsEmptyWhenNoFallback(t *testing.T) {
	cfg := remoteResolverConfig(t)
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return textResponse(http.StatusInternalServerError, "boom"), nil
	})

	resolved, err := resolveFeeds(context.Background(), cfg, client)

	require.Error(t, err)
	assert.Equal(t, remoteFeedSourceEmpty, resolved.Source)
	assert.Empty(t, resolved.Feeds)
}

func TestRefreshFeedsKeepsCurrentWhenRemoteAndCacheFail(t *testing.T) {
	cfg := remoteResolverConfig(t)
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return textResponse(http.StatusInternalServerError, "boom"), nil
	})

	_, apply, err := refreshFeeds(context.Background(), cfg, client)

	require.Error(t, err)
	assert.False(t, apply)
	assert.Contains(t, err.Error(), "remote config returned HTTP 500")
	assert.Contains(t, err.Error(), "failed to read remote config cache")
}

func TestRefreshFeedsCanApplyEmptyRemoteFeedSet(t *testing.T) {
	cfg := remoteResolverConfig(t)
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return textResponse(http.StatusOK, "   "), nil
	})

	resolved, apply, err := refreshFeeds(context.Background(), cfg, client)

	require.NoError(t, err)
	assert.True(t, apply)
	assert.Equal(t, remoteFeedSourceRemote, resolved.Source)
	assert.Empty(t, resolved.Feeds)
}

func TestFetchRemoteConfigHonorsContextTimeout(t *testing.T) {
	cfg := RemoteConfig{BaseURL: "https://podcast.example.com", Token: "secret"}
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	_, err := fetchRemoteConfig(ctx, cfg, client)

	require.Error(t, err)
}

func TestFetchRemoteConfigSetsDefaultTimeout(t *testing.T) {
	cfg := RemoteConfig{BaseURL: "https://podcast.example.com", Token: "secret"}
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		deadline, ok := req.Context().Deadline()
		require.True(t, ok)
		now := time.Now()
		assert.True(t, deadline.After(now.Add(defaultRemoteFetchTimeout-2*time.Second)))
		assert.True(t, deadline.Before(now.Add(defaultRemoteFetchTimeout+time.Second)))
		return textResponse(http.StatusOK, ""), nil
	})

	_, err := fetchRemoteConfig(context.Background(), cfg, client)

	require.NoError(t, err)
}

func remoteResolverConfig(t *testing.T) *Config {
	t.Helper()

	dir := t.TempDir()
	return &Config{
		Remote: RemoteConfig{
			Enabled:   true,
			BaseURL:   "https://podcast.example.com",
			Token:     "secret",
			CachePath: filepath.Join(dir, "remote-cache.toml"),
		},
		CookieProfiles: map[string]CookieProfile{
			"main": {
				Provider: "bilibili",
				Path:     "/cookies/bilibili.txt",
				ReadOnly: true,
			},
		},
	}
}
