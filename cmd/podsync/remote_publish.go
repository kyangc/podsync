package main

import "github.com/mxpv/podsync/services/update"

func remotePublishOptions(cfg *Config, outbox update.RemotePublishOutbox) []update.Option {
	if !cfg.Remote.Enabled {
		return nil
	}
	return []update.Option{update.WithRemotePublishOutbox(outbox)}
}
