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
