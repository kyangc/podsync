package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRemotePublishOptionsDisabledWhenRemoteOff(t *testing.T) {
	options := remotePublishOptions(&Config{}, nil)

	require.Empty(t, options)
}

func TestRemotePublishOptionsEnabledWhenRemoteOn(t *testing.T) {
	options := remotePublishOptions(&Config{Remote: RemoteConfig{Enabled: true}}, nil)

	require.Len(t, options, 1)
}
