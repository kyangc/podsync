package main

import (
	"context"
	"time"

	log "github.com/sirupsen/logrus"

	remotepublish "github.com/mxpv/podsync/services/remote"
)

const defaultRemoteTombstoneInterval = 5 * time.Minute

type remoteTombstoneSyncer interface {
	SyncOnce(ctx context.Context) error
}

type remoteTombstoneFetcherFactory func(baseURL string, token string) (remotepublish.TombstoneFetcher, error)

func remoteTombstoneSyncEnabled(cfg *Config) bool {
	return cfg.Remote.Enabled &&
		cfg.Remote.BaseURL != "" &&
		cfg.Remote.Token != ""
}

func newRemoteTombstoneFetcher(baseURL string, token string) (remotepublish.TombstoneFetcher, error) {
	return remotepublish.NewNASClient(baseURL, token, nil)
}

func buildRemoteTombstoneSyncer(cfg *Config, store remotepublish.TombstoneStore, newFetcher remoteTombstoneFetcherFactory) (remoteTombstoneSyncer, error) {
	if !remoteTombstoneSyncEnabled(cfg) {
		return nil, nil
	}
	fetcher, err := newFetcher(cfg.Remote.BaseURL, cfg.Remote.Token)
	if err != nil {
		return nil, err
	}
	return &remotepublish.TombstoneSyncer{
		Fetcher: fetcher,
		Store:   store,
	}, nil
}

func syncRemoteTombstonesOnce(ctx context.Context, syncer remoteTombstoneSyncer) {
	if syncer == nil {
		return
	}
	if err := syncer.SyncOnce(ctx); err != nil {
		log.WithError(err).Warn("remote tombstone sync failed")
	}
}

func runRemoteTombstoneLoop(ctx context.Context, syncer remoteTombstoneSyncer, interval time.Duration) error {
	if syncer == nil {
		return nil
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			syncRemoteTombstonesOnce(ctx, syncer)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
