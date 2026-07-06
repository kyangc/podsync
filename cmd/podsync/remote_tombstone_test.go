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

func TestRemoteTombstoneSyncEnabledRequiresRemoteBaseURLAndToken(t *testing.T) {
	cfg := &Config{Remote: RemoteConfig{Enabled: true, BaseURL: "https://podcast.example.com", Token: "secret"}}
	assert.True(t, remoteTombstoneSyncEnabled(cfg))

	cfg.Remote.Enabled = false
	assert.False(t, remoteTombstoneSyncEnabled(cfg))

	cfg = &Config{Remote: RemoteConfig{Enabled: true, Token: "secret"}}
	assert.False(t, remoteTombstoneSyncEnabled(cfg))

	cfg = &Config{Remote: RemoteConfig{Enabled: true, BaseURL: "https://podcast.example.com"}}
	assert.False(t, remoteTombstoneSyncEnabled(cfg))
}

func TestBuildRemoteTombstoneSyncerSkipsDisabledConfig(t *testing.T) {
	called := false
	syncer, err := buildRemoteTombstoneSyncer(&Config{}, &cmdFakeTombstoneStore{}, func(string, string) (remotepublish.TombstoneFetcher, error) {
		called = true
		return &cmdFakeTombstoneFetcher{}, nil
	})

	require.NoError(t, err)
	assert.Nil(t, syncer)
	assert.False(t, called)
}

func TestBuildRemoteTombstoneSyncerBuildsWithRemoteOnlyConfig(t *testing.T) {
	cfg := &Config{Remote: RemoteConfig{Enabled: true, BaseURL: "https://podcast.example.com", Token: "secret"}}
	var gotBaseURL string
	var gotToken string

	syncer, err := buildRemoteTombstoneSyncer(cfg, &cmdFakeTombstoneStore{}, func(baseURL string, token string) (remotepublish.TombstoneFetcher, error) {
		gotBaseURL = baseURL
		gotToken = token
		return &cmdFakeTombstoneFetcher{}, nil
	})

	require.NoError(t, err)
	assert.NotNil(t, syncer)
	assert.Equal(t, "https://podcast.example.com", gotBaseURL)
	assert.Equal(t, "secret", gotToken)
}

func TestSyncRemoteTombstonesOnceCallsSyncer(t *testing.T) {
	syncer := &cmdFakeTombstoneSyncer{}

	syncRemoteTombstonesOnce(context.Background(), syncer)
	syncRemoteTombstonesOnce(context.Background(), nil)

	assert.Equal(t, 1, syncer.calls)
}

func TestSyncRemoteTombstonesOnceSwallowsError(t *testing.T) {
	syncer := &cmdFakeTombstoneSyncer{err: errors.New("worker unavailable")}

	syncRemoteTombstonesOnce(context.Background(), syncer)

	assert.Equal(t, 1, syncer.calls)
}

func TestRunRemoteTombstoneLoopWaitsForTickAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	syncer := &cmdFakeTombstoneSyncer{afterSync: cancel}

	err := runRemoteTombstoneLoop(ctx, syncer, 10*time.Millisecond)

	require.Error(t, err)
	assert.True(t, errors.Is(err, context.Canceled))
	assert.Equal(t, 1, syncer.calls)
}

func TestRemoteStartupOrderingSyncsTombstonesBeforeHeadlessUpdateAndPublish(t *testing.T) {
	var order []string
	syncer := &cmdFakeTombstoneSyncer{onSync: func() { order = append(order, "sync") }}

	recordRemoteStartupOrder(context.Background(), syncer, func() {
		order = append(order, "update")
	}, func() {
		order = append(order, "publish")
	})

	assert.Equal(t, []string{"sync", "update", "publish"}, order)
}

func recordRemoteStartupOrder(ctx context.Context, syncer remoteTombstoneSyncer, update func(), publish func()) {
	syncRemoteTombstonesOnce(ctx, syncer)
	update()
	publish()
}

type cmdFakeTombstoneSyncer struct {
	calls     int
	err       error
	onSync    func()
	afterSync func()
}

func (s *cmdFakeTombstoneSyncer) SyncOnce(context.Context) error {
	s.calls++
	if s.onSync != nil {
		s.onSync()
	}
	if s.afterSync != nil {
		s.afterSync()
	}
	return s.err
}

type cmdFakeTombstoneFetcher struct{}

func (f *cmdFakeTombstoneFetcher) FetchTombstones(context.Context, int64, int) (*model.RemoteTombstoneBatch, error) {
	return &model.RemoteTombstoneBatch{}, nil
}

type cmdFakeTombstoneStore struct{}

func (s *cmdFakeTombstoneStore) GetRemoteTombstoneCursor(context.Context) (int64, error) {
	return 0, nil
}

func (s *cmdFakeTombstoneStore) ApplyRemoteTombstones(context.Context, *model.RemoteTombstoneBatch, time.Time) error {
	return nil
}
