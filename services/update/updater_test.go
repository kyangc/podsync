package update

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"
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
