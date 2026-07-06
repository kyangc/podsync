package main

import (
	"context"
	"time"

	log "github.com/sirupsen/logrus"

	remotepublish "github.com/mxpv/podsync/services/remote"
	"github.com/mxpv/podsync/services/update"
)

const defaultRemotePublishInterval = 5 * time.Minute
const defaultRemotePublishBatchSize = 10

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
	return cfg.Remote.Enabled &&
		cfg.Remote.BaseURL != "" &&
		cfg.Remote.Token != "" &&
		cfg.Storage.Type == "local" &&
		cfg.R2.Endpoint != "" &&
		cfg.R2.Bucket != "" &&
		cfg.R2.AccessKeyID != "" &&
		cfg.R2.SecretAccessKey != ""
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

func buildRemoteProcessor(cfg *Config, outbox remotepublish.Outbox, newPublisher remotePublisherFactory, newUpserter remoteUpserterFactory, events remotepublish.EventSink) (remotePublishProcessor, error) {
	if !remotePublishEnabled(cfg) {
		return nil, nil
	}
	publisher, err := newPublisher(remoteR2Config(cfg))
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
		Prefix:    cfg.R2.Prefix,
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
