package main

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/fs"
	"github.com/mxpv/podsync/pkg/model"
	remotepublish "github.com/mxpv/podsync/services/remote"
)

func TestRemotePublishOptionsDisabledWhenRemoteOff(t *testing.T) {
	options := remotePublishOptions(&Config{}, nil)

	require.Empty(t, options)
}

func TestRemotePublishOptionsEnabledWhenRemoteOn(t *testing.T) {
	options := remotePublishOptions(&Config{Remote: RemoteConfig{Enabled: true}}, nil)

	require.Len(t, options, 1)
}

func TestRemotePublishEnabledRequiresRemoteLocalStorageAndR2(t *testing.T) {
	cfg := completeRemotePublishConfig()
	assert.True(t, remotePublishEnabled(cfg))

	cfg = completeRemotePublishConfig()
	cfg.Remote.Enabled = false
	assert.False(t, remotePublishEnabled(cfg))

	cfg = completeRemotePublishConfig()
	cfg.Storage.Type = "s3"
	assert.False(t, remotePublishEnabled(cfg))

	tests := []func(*Config){
		func(cfg *Config) { cfg.Remote.BaseURL = "" },
		func(cfg *Config) { cfg.Remote.Token = "" },
		func(cfg *Config) { cfg.R2.Endpoint = "" },
		func(cfg *Config) { cfg.R2.Bucket = "" },
		func(cfg *Config) { cfg.R2.AccessKeyID = "" },
		func(cfg *Config) { cfg.R2.SecretAccessKey = "" },
	}
	for _, mutate := range tests {
		cfg = completeRemotePublishConfig()
		mutate(cfg)
		assert.False(t, remotePublishEnabled(cfg))
	}
}

func TestRemoteR2ConfigMapsFields(t *testing.T) {
	cfg := completeRemotePublishConfig()

	got := remoteR2Config(cfg)

	assert.Equal(t, "https://account.r2.cloudflarestorage.com", got.Endpoint)
	assert.Equal(t, "bucket", got.Bucket)
	assert.Equal(t, "podcasts/audio", got.Prefix)
	assert.Equal(t, "access-key", got.AccessKeyID)
	assert.Equal(t, "secret-key", got.SecretAccessKey)
}

func TestBuildRemoteProcessorSkipsDisabledOrIncompleteConfig(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "remote off", mutate: func(cfg *Config) { cfg.Remote.Enabled = false }},
		{name: "s3 storage", mutate: func(cfg *Config) { cfg.Storage.Type = "s3" }},
		{name: "missing r2", mutate: func(cfg *Config) { cfg.R2.Bucket = "" }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := completeRemotePublishConfig()
			tt.mutate(cfg)
			called := false
			processor, err := buildRemoteProcessor(cfg, &cmdFakeOutbox{}, func(remotepublish.R2Config) (remotepublish.Publisher, error) {
				called = true
				return &cmdFakePublisher{}, nil
			}, func(string, string) (remotepublish.EpisodeUpserter, error) {
				called = true
				return &cmdFakeUpserter{}, nil
			}, nil)

			require.NoError(t, err)
			assert.Nil(t, processor)
			assert.False(t, called)
		})
	}
}

func TestBuildRemoteProcessorBuildsLocalR2Processor(t *testing.T) {
	cfg := completeRemotePublishConfig()
	var gotCfg remotepublish.R2Config
	var gotBaseURL string
	var gotToken string

	events := &cmdFakeEventRecorder{}
	processor, err := buildRemoteProcessor(cfg, &cmdFakeOutbox{}, func(cfg remotepublish.R2Config) (remotepublish.Publisher, error) {
		gotCfg = cfg
		return &cmdFakePublisher{}, nil
	}, func(baseURL string, token string) (remotepublish.EpisodeUpserter, error) {
		gotBaseURL = baseURL
		gotToken = token
		return &cmdFakeUpserter{}, nil
	}, events)

	require.NoError(t, err)
	require.NotNil(t, processor)
	assert.Equal(t, remoteR2Config(cfg), gotCfg)
	assert.Equal(t, "https://podcast.example.com", gotBaseURL)
	assert.Equal(t, "secret", gotToken)
	remoteProcessor, ok := processor.(*remotepublish.Processor)
	require.True(t, ok)
	assert.Equal(t, defaultRemotePublishBatchSize, remoteProcessor.Limit)
	assert.Equal(t, "podcasts/audio", remoteProcessor.Prefix)
	assert.NotNil(t, remoteProcessor.Upserter)
	assert.Equal(t, events, remoteProcessor.Events)
	store, ok := remoteProcessor.Store.(remotepublish.LocalMediaStore)
	require.True(t, ok)
	assert.Equal(t, "/data", store.Root)
}

func TestProcessRemotePublishOnceCallsProcessor(t *testing.T) {
	processor := &cmdFakeProcessor{}

	processRemotePublishOnce(context.Background(), processor)
	processRemotePublishOnce(context.Background(), nil)

	assert.Equal(t, 1, processor.calls)
}

func TestRunRemotePublishLoopProcessesImmediatelyAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	processor := &cmdFakeProcessor{afterProcess: cancel}

	err := runRemotePublishLoop(ctx, processor, time.Hour)

	require.Error(t, err)
	assert.True(t, errors.Is(err, context.Canceled))
	assert.Equal(t, 1, processor.calls)
}

func completeRemotePublishConfig() *Config {
	return &Config{
		Remote: RemoteConfig{Enabled: true, BaseURL: "https://podcast.example.com", Token: "secret"},
		Storage: fs.Config{
			Type:  "local",
			Local: fs.LocalConfig{DataDir: "/data"},
		},
		R2: R2Config{
			Endpoint:        "https://account.r2.cloudflarestorage.com",
			Bucket:          "bucket",
			Prefix:          "podcasts/audio",
			AccessKeyID:     "access-key",
			SecretAccessKey: "secret-key",
		},
	}
}

type cmdFakeOutbox struct {
	remotepublish.Outbox
}

type cmdFakePublisher struct{}

func (p *cmdFakePublisher) Upload(context.Context, *model.RemotePublishTask, io.ReadSeeker) error {
	return nil
}

type cmdFakeUpserter struct{}

func (u *cmdFakeUpserter) UpsertEpisode(context.Context, *model.RemotePublishTask) (*remotepublish.EpisodeUpsertResult, error) {
	return &remotepublish.EpisodeUpsertResult{Status: "visible"}, nil
}

type cmdFakeProcessor struct {
	calls        int
	afterProcess func()
}

func (p *cmdFakeProcessor) ProcessDue(context.Context) error {
	p.calls++
	if p.afterProcess != nil {
		p.afterProcess()
	}
	return nil
}
