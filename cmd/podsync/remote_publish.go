package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	log "github.com/sirupsen/logrus"

	remotepublish "github.com/mxpv/podsync/services/remote"
	"github.com/mxpv/podsync/services/update"
	"github.com/mxpv/podsync/services/web"
)

const defaultRemotePublishInterval = 5 * time.Minute
const defaultRemotePublishBatchSize = 10

const (
	remoteMediaTypeR2       = "r2"
	remoteMediaTypeHardlink = "hardlink"
)

type remotePublishProcessor interface {
	ProcessDue(ctx context.Context) error
}

type remotePublisherFactory func(remotepublish.R2Config) (remotepublish.Publisher, error)
type remoteUpserterFactory func(baseURL string, token string) (remotepublish.EpisodeUpserter, error)
type remoteFeedMetadataReporterFactory func(baseURL string, token string) (remotepublish.FeedMetadataReporter, error)

func remotePublishOptions(cfg *Config, outbox update.RemotePublishOutbox) []update.Option {
	if !cfg.Remote.Enabled {
		return nil
	}
	return []update.Option{update.WithRemotePublishOutbox(outbox)}
}

func remotePublishEnabled(cfg *Config) bool {
	if !cfg.Remote.Enabled ||
		cfg.Remote.BaseURL == "" ||
		cfg.Remote.Token == "" ||
		cfg.Storage.Type != "local" {
		return false
	}
	switch remoteMediaType(cfg) {
	case remoteMediaTypeR2:
		return cfg.R2.Endpoint != "" &&
			cfg.R2.Bucket != "" &&
			cfg.R2.AccessKeyID != "" &&
			cfg.R2.SecretAccessKey != ""
	case remoteMediaTypeHardlink:
		return cfg.RemoteMedia.PublicRoot != ""
	default:
		return false
	}
}

func remoteMediaType(cfg *Config) string {
	if cfg.RemoteMedia.Type == "" {
		return remoteMediaTypeR2
	}
	return cfg.RemoteMedia.Type
}

func remoteMediaPrefix(cfg *Config) string {
	if cfg.RemoteMedia.Prefix != "" {
		return cfg.RemoteMedia.Prefix
	}
	return cfg.R2.Prefix
}

func remoteFeedMetadataReportingEnabled(cfg *Config) bool {
	return cfg.Remote.Enabled &&
		cfg.Remote.BaseURL != "" &&
		cfg.Remote.Token != ""
}

func remoteFeedMetadataOptions(cfg *Config, newReporter remoteFeedMetadataReporterFactory) ([]update.Option, error) {
	if !remoteFeedMetadataReportingEnabled(cfg) {
		return nil, nil
	}
	reporter, err := newReporter(cfg.Remote.BaseURL, cfg.Remote.Token)
	if err != nil {
		return nil, err
	}
	return []update.Option{update.WithRemoteFeedMetadataReporter(reporter)}, nil
}

func remoteR2Config(cfg *Config) remotepublish.R2Config {
	return remotepublish.R2Config{
		Endpoint:        cfg.R2.Endpoint,
		Bucket:          cfg.R2.Bucket,
		Prefix:          cfg.R2.Prefix,
		AccessKeyID:     cfg.R2.AccessKeyID,
		SecretAccessKey: cfg.R2.SecretAccessKey,
	}
}

func newRemoteR2Publisher(cfg remotepublish.R2Config) (remotepublish.Publisher, error) {
	return remotepublish.NewR2Publisher(cfg)
}

func newRemoteNASUpserter(baseURL string, token string) (remotepublish.EpisodeUpserter, error) {
	return remotepublish.NewNASClient(baseURL, token, nil)
}

func newRemoteFeedMetadataReporter(baseURL string, token string) (remotepublish.FeedMetadataReporter, error) {
	return remotepublish.NewNASClient(baseURL, token, nil)
}

func remoteMediaWebOptions(cfg *Config) ([]web.Option, error) {
	if !cfg.Remote.Enabled || remoteMediaType(cfg) != remoteMediaTypeHardlink {
		return nil, nil
	}
	store, err := remotepublish.NewHardlinkStore(cfg.RemoteMedia.PublicRoot)
	if err != nil {
		return nil, err
	}
	return []web.Option{web.WithMediaLifecycle(store, cfg.Remote.Token)}, nil
}

func loadRemoteMediaKeys(path string) (map[string]struct{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("read remote media key file: " + err.Error())
	}
	var keys []string
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, errors.New("parse remote media key file as a JSON array: " + err.Error())
	}
	if keys == nil {
		return nil, errors.New("remote media key file must contain a JSON array")
	}
	allowedKeys := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		if key == "" {
			return nil, errors.New("remote media key file contains an empty key")
		}
		if _, exists := allowedKeys[key]; exists {
			return nil, errors.New("remote media key file contains a duplicate key")
		}
		allowedKeys[key] = struct{}{}
	}
	return allowedKeys, nil
}

func runRemoteMediaBackfill(ctx context.Context, cfg *Config, tasks remotepublish.RemotePublishTaskWalker, keyFile string, recoverMissing bool, dryRun bool) (remotepublish.HardlinkBackfillResult, error) {
	if cfg.Storage.Type != "local" || remoteMediaType(cfg) != remoteMediaTypeHardlink || cfg.RemoteMedia.PublicRoot == "" {
		return remotepublish.HardlinkBackfillResult{}, errors.New("remote media backfill requires local storage and remote_media.type hardlink with public_root")
	}
	allowedKeys, err := loadRemoteMediaKeys(keyFile)
	if err != nil {
		return remotepublish.HardlinkBackfillResult{}, err
	}
	publisher, err := remotepublish.NewHardlinkPublisher(cfg.Storage.Local.DataDir, cfg.RemoteMedia.PublicRoot)
	if err != nil {
		return remotepublish.HardlinkBackfillResult{}, err
	}
	var restorer remotepublish.MissingSourceRestorer
	if recoverMissing {
		restorer, err = remotepublish.NewR2SourceRestorer(remoteR2Config(cfg), cfg.Storage.Local.DataDir)
		if err != nil {
			return remotepublish.HardlinkBackfillResult{}, err
		}
	}
	return (&remotepublish.HardlinkBackfill{
		Tasks:                 tasks,
		Publisher:             publisher,
		AllowedKeys:           allowedKeys,
		MissingSourceRestorer: restorer,
		DryRun:                dryRun,
	}).Run(ctx)
}

func buildRemoteProcessor(cfg *Config, outbox remotepublish.Outbox, newPublisher remotePublisherFactory, newUpserter remoteUpserterFactory, events remotepublish.EventSink) (remotePublishProcessor, error) {
	if !remotePublishEnabled(cfg) {
		return nil, nil
	}
	var publisher remotepublish.Publisher
	var err error
	switch remoteMediaType(cfg) {
	case remoteMediaTypeHardlink:
		publisher, err = remotepublish.NewHardlinkPublisher(cfg.Storage.Local.DataDir, cfg.RemoteMedia.PublicRoot)
	case remoteMediaTypeR2:
		publisher, err = newPublisher(remoteR2Config(cfg))
	}
	if err != nil {
		return nil, err
	}
	upserter, err := newUpserter(cfg.Remote.BaseURL, cfg.Remote.Token)
	if err != nil {
		return nil, err
	}
	return &remotepublish.Processor{
		Outbox:    outbox,
		Publisher: publisher,
		Upserter:  upserter,
		Store:     remotepublish.LocalMediaStore{Root: cfg.Storage.Local.DataDir},
		Events:    events,
		Prefix:    remoteMediaPrefix(cfg),
		Limit:     defaultRemotePublishBatchSize,
	}, nil
}

func processRemotePublishOnce(ctx context.Context, processor remotePublishProcessor) {
	if processor == nil {
		return
	}
	if err := processor.ProcessDue(ctx); err != nil {
		log.WithError(err).Warn("remote publish processing failed")
	}
}

func runRemotePublishLoop(ctx context.Context, processor remotePublishProcessor, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		processRemotePublishOnce(ctx, processor)
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
