package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRefreshFeedsRetriesTruncatedConfigBeforeFallback(t *testing.T) {
	cfg := remoteResolverConfig(t)
	calls := 0
	client := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		assert.Equal(t, "Bearer secret", req.Header.Get("Authorization"))
		if calls == 1 {
			return &http.Response{StatusCode: http.StatusOK, Body: &truncatedConfigBody{}}, nil
		}
		return textResponse(http.StatusOK, "[feeds.new]\nurl = 'https://www.youtube.com/channel/new'\n"), nil
	})

	resolved, apply, err := refreshFeeds(context.Background(), cfg, client)

	require.NoError(t, err)
	assert.True(t, apply)
	assert.Equal(t, remoteFeedSourceRemote, resolved.Source)
	assert.Contains(t, resolved.Feeds, "new")
	assert.Equal(t, 2, calls)
}

func TestRefreshFeedsPreservesCacheWhenTransientFailurePersists(t *testing.T) {
	cfg := remoteResolverConfig(t)
	cached := []byte("[feeds.cached]\nurl = 'https://www.youtube.com/channel/cached'\n")
	require.NoError(t, os.WriteFile(cfg.Remote.CachePath, cached, 0o600))
	calls := 0
	client := roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, io.EOF
	})

	resolved, apply, err := refreshFeeds(context.Background(), cfg, client)

	require.ErrorIs(t, err, io.EOF)
	assert.True(t, apply)
	assert.Equal(t, remoteFeedSourceCache, resolved.Source)
	assert.Contains(t, resolved.Feeds, "cached")
	assert.Equal(t, 2, calls)
	actual, err := os.ReadFile(cfg.Remote.CachePath)
	require.NoError(t, err)
	assert.Equal(t, cached, actual)
}

type truncatedConfigBody struct{}

func (*truncatedConfigBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (*truncatedConfigBody) Close() error             { return nil }
