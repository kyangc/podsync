package main

import (
	"context"
	"fmt"
	"os"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/model"
	remotepublish "github.com/mxpv/podsync/services/remote"
)

const (
	defaultRemoteEventInterval    = time.Minute
	defaultRemoteEventRunDuration = time.Hour
)

type remoteEventRecorder interface {
	remotepublish.EventSink
	Flush(ctx context.Context, status model.RemoteSyncRunStatus) error
	FinalStatus() model.RemoteSyncRunStatus
}

type remoteEventReporterFactory func(baseURL string, token string) (remotepublish.EventBatchReporter, error)

func remoteEventReportingEnabled(cfg *Config) bool {
	return cfg != nil && cfg.Remote.Enabled && cfg.Remote.BaseURL != "" && cfg.Remote.Token != ""
}

func newRemoteEventReporter(baseURL string, token string) (remotepublish.EventBatchReporter, error) {
	return remotepublish.NewNASClient(baseURL, token, nil)
}

func buildRemoteEventRecorder(cfg *Config, newReporter remoteEventReporterFactory) (remoteEventRecorder, error) {
	if !remoteEventReportingEnabled(cfg) {
		return nil, nil
	}
	reporter, err := newReporter(cfg.Remote.BaseURL, cfg.Remote.Token)
	if err != nil {
		return nil, err
	}
	started := time.Now().UTC()
	runID := fmt.Sprintf("%s-%d", started.Format("20060102T150405Z"), os.Getpid())
	return remotepublish.NewEventRecorder(remotepublish.EventRecorderConfig{
		RunID:          runID,
		StartedAt:      started,
		Reporter:       reporter,
		Redactions:     collectRemoteEventRedactions(cfg),
		MaxRunDuration: defaultRemoteEventRunDuration,
	}), nil
}

func collectRemoteEventRedactions(cfg *Config) []string {
	if cfg == nil {
		return nil
	}
	values := []string{
		cfg.Remote.Token,
		cfg.R2.AccessKeyID,
		cfg.R2.SecretAccessKey,
	}
	for _, tokens := range cfg.Tokens {
		values = append(values, tokens...)
	}
	for _, profile := range cfg.CookieProfiles {
		values = append(values, profile.Path)
	}
	return values
}

func recordRemoteRunStarted(events remoteEventRecorder) {
	if events != nil {
		events.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventInfo, Type: model.RemoteEventSyncRunStarted})
	}
}

func recordRemoteRunFinishedAndFlush(ctx context.Context, events remoteEventRecorder) {
	if events == nil {
		return
	}
	events.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventInfo, Type: model.RemoteEventSyncRunFinished})
	flushRemoteEventsOnce(ctx, events, events.FinalStatus())
}

func recordRemoteConfigEvent(events remoteEventRecorder, resolved resolvedFeeds, err error) {
	if events == nil {
		return
	}
	if err != nil {
		events.RecordRemoteEvent(model.RemoteEventDraft{
			Level:       model.RemoteEventError,
			Type:        model.RemoteEventConfigInvalid,
			ErrorCode:   "remote_config_invalid",
			ErrorDetail: err.Error(),
		})
	}
	switch resolved.Source {
	case remoteFeedSourceRemote:
		if err == nil {
			events.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventInfo, Type: model.RemoteEventConfigFetched})
		}
	case remoteFeedSourceCache, remoteFeedSourceLocalFallback:
		events.RecordRemoteEvent(model.RemoteEventDraft{Level: model.RemoteEventWarn, Type: model.RemoteEventConfigFallbackUsed, Message: string(resolved.Source)})
	}
}

func flushRemoteEventsOnce(ctx context.Context, events remoteEventRecorder, status model.RemoteSyncRunStatus) {
	if events == nil {
		return
	}
	if err := events.Flush(ctx, status); err != nil {
		log.WithError(err).Warn("remote event upload failed")
	}
}

func runRemoteEventLoop(ctx context.Context, events remoteEventRecorder, interval time.Duration) error {
	if events == nil {
		return nil
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			flushRemoteEventsOnce(ctx, events, model.RemoteSyncRunRunning)
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			recordRemoteRunFinishedAndFlush(shutdownCtx, events)
			return ctx.Err()
		}
	}
}
