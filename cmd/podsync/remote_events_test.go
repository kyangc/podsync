package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
	remotepublish "github.com/mxpv/podsync/services/remote"
)

func TestRemoteEventReportingDisabledWithoutRemote(t *testing.T) {
	assert.False(t, remoteEventReportingEnabled(&Config{}))
	assert.False(t, remoteEventReportingEnabled(&Config{Remote: RemoteConfig{Enabled: true, Token: "secret"}}))
	assert.False(t, remoteEventReportingEnabled(&Config{Remote: RemoteConfig{Enabled: true, BaseURL: "https://podcast.example.com"}}))
	assert.True(t, remoteEventReportingEnabled(&Config{Remote: RemoteConfig{Enabled: true, BaseURL: "https://podcast.example.com", Token: "secret"}}))
}

func TestBuildRemoteEventRecorderDisabledDoesNotCallFactory(t *testing.T) {
	called := false
	recorder, err := buildRemoteEventRecorder(&Config{}, func(string, string) (remotepublish.EventBatchReporter, error) {
		called = true
		return &cmdFakeEventReporter{}, nil
	})

	require.NoError(t, err)
	assert.Nil(t, recorder)
	assert.False(t, called)
}

func TestBuildRemoteEventRecorderUsesRemoteBaseURLAndToken(t *testing.T) {
	cfg := &Config{Remote: RemoteConfig{Enabled: true, BaseURL: "https://podcast.example.com", Token: "secret"}}
	var gotBaseURL string
	var gotToken string

	recorder, err := buildRemoteEventRecorder(cfg, func(baseURL string, token string) (remotepublish.EventBatchReporter, error) {
		gotBaseURL = baseURL
		gotToken = token
		return &cmdFakeEventReporter{}, nil
	})

	require.NoError(t, err)
	assert.NotNil(t, recorder)
	assert.Equal(t, "https://podcast.example.com", gotBaseURL)
	assert.Equal(t, "secret", gotToken)
}

func TestCollectRemoteEventRedactionsIncludesConfiguredSecrets(t *testing.T) {
	cfg := &Config{
		Remote: RemoteConfig{Token: "remote-token"},
		R2:     R2Config{AccessKeyID: "r2-access", SecretAccessKey: "r2-secret"},
		Tokens: map[model.Provider]StringSlice{
			model.ProviderYoutube: StringSlice{"youtube-token"},
			model.ProviderVimeo:   StringSlice{"vimeo-token"},
		},
		CookieProfiles: map[string]CookieProfile{
			"bili": {Path: "/app/secrets/bili.txt"},
		},
	}

	redactions := collectRemoteEventRedactions(cfg)

	assert.Contains(t, redactions, "remote-token")
	assert.Contains(t, redactions, "r2-access")
	assert.Contains(t, redactions, "r2-secret")
	assert.Contains(t, redactions, "youtube-token")
	assert.Contains(t, redactions, "vimeo-token")
	assert.Contains(t, redactions, "/app/secrets/bili.txt")
}

func TestRecordRemoteConfigEventMapsSources(t *testing.T) {
	events := &cmdFakeEventRecorder{}

	recordRemoteConfigEvent(events, resolvedFeeds{Source: remoteFeedSourceRemote}, nil)
	recordRemoteConfigEvent(events, resolvedFeeds{Source: remoteFeedSourceCache}, errors.New("fetch failed"))
	recordRemoteConfigEvent(events, resolvedFeeds{Source: remoteFeedSourceLocalFallback}, errors.New("fetch failed"))

	require.Len(t, events.events, 5)
	assert.Equal(t, model.RemoteEventConfigFetched, events.events[0].Type)
	assert.Equal(t, model.RemoteEventConfigInvalid, events.events[1].Type)
	assert.Equal(t, model.RemoteEventConfigFallbackUsed, events.events[2].Type)
	assert.Equal(t, model.RemoteEventConfigInvalid, events.events[3].Type)
	assert.Equal(t, model.RemoteEventConfigFallbackUsed, events.events[4].Type)
}

func TestRecordRemoteConfigEventDoesNotEmitFetchedWhenErrorHasNoRemoteSource(t *testing.T) {
	events := &cmdFakeEventRecorder{}

	recordRemoteConfigEvent(events, resolvedFeeds{Source: remoteFeedSourceRemote}, errors.New("parse failed"))

	require.Len(t, events.events, 1)
	assert.Equal(t, model.RemoteEventConfigInvalid, events.events[0].Type)
}

func TestRecordRemoteLifecycleStartAndFinishEvents(t *testing.T) {
	events := &cmdFakeEventRecorder{status: model.RemoteSyncRunSuccess}

	recordRemoteRunStarted(events)
	recordRemoteRunFinishedAndFlush(context.Background(), events)

	require.Len(t, events.events, 2)
	assert.Equal(t, model.RemoteEventSyncRunStarted, events.events[0].Type)
	assert.Equal(t, model.RemoteEventSyncRunFinished, events.events[1].Type)
	assert.Equal(t, []model.RemoteSyncRunStatus{model.RemoteSyncRunSuccess}, events.flushStatuses)
}

func TestFlushRemoteEventsOnceSuppressesReporterError(t *testing.T) {
	events := &cmdFakeEventRecorder{err: errors.New("worker unavailable")}

	flushRemoteEventsOnce(context.Background(), events, model.RemoteSyncRunRunning)

	assert.Equal(t, []model.RemoteSyncRunStatus{model.RemoteSyncRunRunning}, events.flushStatuses)
}

func TestRunRemoteEventLoopFlushesFinalOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	events := &cmdFakeEventRecorder{status: model.RemoteSyncRunPartial}
	cancel()

	err := runRemoteEventLoop(ctx, events, time.Hour)

	require.Error(t, err)
	assert.True(t, errors.Is(err, context.Canceled))
	require.Len(t, events.events, 1)
	assert.Equal(t, model.RemoteEventSyncRunFinished, events.events[0].Type)
	assert.Equal(t, []model.RemoteSyncRunStatus{model.RemoteSyncRunPartial}, events.flushStatuses)
}

type cmdFakeEventReporter struct{}

func (r *cmdFakeEventReporter) PostEventBatch(context.Context, *model.RemoteEventBatch) (*model.RemoteEventBatchResult, error) {
	return &model.RemoteEventBatchResult{RunID: "run"}, nil
}

type cmdFakeEventRecorder struct {
	events        []model.RemoteEventDraft
	flushStatuses []model.RemoteSyncRunStatus
	status        model.RemoteSyncRunStatus
	err           error
}

func (r *cmdFakeEventRecorder) RecordRemoteEvent(event model.RemoteEventDraft) {
	r.events = append(r.events, event)
}

func (r *cmdFakeEventRecorder) Flush(_ context.Context, status model.RemoteSyncRunStatus) error {
	r.flushStatuses = append(r.flushStatuses, status)
	return r.err
}

func (r *cmdFakeEventRecorder) FinalStatus() model.RemoteSyncRunStatus {
	if r.status == "" {
		return model.RemoteSyncRunSuccess
	}
	return r.status
}
