# Remote Runtime Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Podsync consume Cloudflare `/api/nas/config.toml` at runtime with safe cache fallback and scheduler reconciliation, while preserving local-only behavior when remote mode is disabled.

**Architecture:** Local `config.toml` remains the source for runtime secrets, storage, tokens, cookie profiles, and remote connection settings. When `[remote].enabled = true`, startup resolves an active feed map from remote TOML, last-success cache, local emergency fallback, or an empty set; periodic refresh only applies a valid remote/cache snapshot and otherwise keeps the currently active feed map. Scheduler reconciliation validates schedules before mutating cron entries, then updater/OPML switch to the same accepted feed map.

**Tech Stack:** Go 1.25, `github.com/pelletier/go-toml`, existing `feed.Config`, existing `robfig/cron/v3`, standard `net/http`, standard `os` atomic rename.

---

## Scope Boundaries

This phase may modify:

- `cmd/podsync/config.go`
- `cmd/podsync/config_test.go`
- `cmd/podsync/main.go`
- `cmd/podsync/remote_config.go`
- `cmd/podsync/remote_config_test.go`
- `cmd/podsync/scheduler.go`
- `cmd/podsync/scheduler_test.go`
- `pkg/feed/config.go`
- `services/update/updater.go`
- `services/update/updater_test.go`
- `docs/superpowers/plans/2026-07-06-remote-runtime-config.md`

This phase must not modify:

- `cloudflare/worker/**`
- R2 upload code
- DB schema/outbox code
- dashboard mutation code
- NAS live config
- GitHub Actions
- Dockerfile

This phase intentionally does not implement R2 publish, remote episode upsert, tombstone pull/apply, remote logging, retention cron, or dashboard feed mutation.

---

## Acceptance Criteria

- Local-only config without `[remote]` keeps existing behavior and tests.
- `[remote].enabled = false` keeps existing behavior and does not create remote HTTP requests.
- `[remote].enabled = true` allows zero local feeds.
- Remote config endpoint is derived from `remote.base_url` plus `/api/nas/config.toml`; no per-endpoint config knobs are added.
- Remote fetch sends `Authorization: Bearer <token>` and has a bounded timeout.
- Remote fetch success can legitimately produce zero feeds; zero remote feeds means the scheduler removes all feed jobs.
- Startup fallback order is: valid remote snapshot, valid cache, original local feeds, empty set with logged error.
- Periodic refresh fallback order is: valid remote snapshot, valid cache; otherwise keep the currently active set.
- Invalid remote TOML, invalid feed fields, invalid cookie profile mapping, or invalid schedules never overwrite last-success cache.
- Last-success cache is written atomically only after the remote snapshot is validated and accepted by the caller.
- Empty remote bodies are valid zero-feed snapshots and must still be cacheable; `nil` cache data means "no cache candidate", while a zero-length non-nil byte slice means "write an empty cache file".
- Original local feeds are preserved separately from the current active feed map so emergency fallback never turns into "whatever remote map was last active".
- Scheduler reconciliation supports add, remove, and schedule update without duplicate cron entries.
- Scheduler reconciliation must not send to the updates channel while holding scheduler state locks; it returns feeds to enqueue, and callers enqueue after applying manager state.
- Queued stale feed updates are skipped after a feed is removed or disabled remotely.
- Updater OPML generation uses the same current feed map as the scheduler.
- Headless mode resolves remote once and updates the resolved feed set.
- The implementation does not initialize R2, outbox, or tombstone machinery.

---

### Task 1: Local Config Structures And Feed Finalization

**Files:**

- Modify: `cmd/podsync/config.go`
- Modify: `cmd/podsync/config_test.go`
- Modify: `pkg/feed/config.go`

- [ ] **Step 1.1: Add config fields**

Modify `pkg/feed/config.go` to add a local reference to a cookie profile:

```go
// CookieProfile references a local cookie profile from [cookie_profiles].
CookieProfile string `toml:"cookie_profile"`
```

Place it near the Bilibili config fields so its relationship to Bilibili cookies is visible.

Modify `cmd/podsync/config.go` imports to include `net/url` and `time`.

Add:

```go
const (
	defaultRemoteConfigRefreshInterval = 5 * time.Minute
	defaultRemoteFetchTimeout          = 30 * time.Second
)

type RemoteConfig struct {
	Enabled               bool          `toml:"enabled"`
	BaseURL               string        `toml:"base_url"`
	Token                 string        `toml:"token"`
	CachePath             string        `toml:"cache_path"`
	ConfigRefreshInterval time.Duration `toml:"config_refresh_interval"`
}

type R2Config struct {
	Endpoint        string `toml:"endpoint"`
	Bucket          string `toml:"bucket"`
	Prefix          string `toml:"prefix"`
	AccessKeyID     string `toml:"access_key_id"`
	SecretAccessKey string `toml:"secret_access_key"`
}

type CookieProfile struct {
	Provider model.Provider `toml:"provider"`
	Path     string         `toml:"path"`
	ReadOnly bool           `toml:"readonly"`
}
```

Add these fields to `Config`:

```go
Remote         RemoteConfig             `toml:"remote"`
R2             R2Config                 `toml:"r2"`
CookieProfiles map[string]CookieProfile `toml:"cookie_profiles"`
LocalFeeds     map[string]*feed.Config  `toml:"-"`
```

`R2Config` is parse-only in this phase and matches the design document's field names. Do not validate or use R2 settings yet.

- [ ] **Step 1.2: Split top-level and feed-only defaults**

Refactor existing `applyDefaults(configPath string)` so feed defaults live in a separate helper:

```go
func (c *Config) applyDefaults(configPath string) {
	if c.Server.Hostname == "" {
		if c.Server.Port != 0 && c.Server.Port != 80 {
			c.Server.Hostname = fmt.Sprintf("http://localhost:%d", c.Server.Port)
		} else {
			c.Server.Hostname = "http://localhost"
		}
	}

	if c.Storage.Type == "" {
		c.Storage.Type = "local"
	}

	if c.Log.Filename != "" {
		if c.Log.MaxSize == 0 {
			c.Log.MaxSize = model.DefaultLogMaxSize
		}
		if c.Log.MaxAge == 0 {
			c.Log.MaxAge = model.DefaultLogMaxAge
		}
		if c.Log.MaxBackups == 0 {
			c.Log.MaxBackups = model.DefaultLogMaxBackups
		}
	}

	if c.Database.Dir == "" {
		c.Database.Dir = filepath.Join(filepath.Dir(configPath), "db")
	}

	if c.Remote.Enabled && c.Remote.ConfigRefreshInterval == 0 {
		c.Remote.ConfigRefreshInterval = defaultRemoteConfigRefreshInterval
	}

	c.applyFeedDefaults(c.Feeds)
}

func (c *Config) applyFeedDefaults(feeds map[string]*feed.Config) {
	for _, _feed := range feeds {
		if _feed.UpdatePeriod == 0 {
			_feed.UpdatePeriod = model.DefaultUpdatePeriod
		}
		if _feed.Quality == "" {
			_feed.Quality = model.DefaultQuality
		}
		if _feed.Custom.CoverArtQuality == "" {
			_feed.Custom.CoverArtQuality = model.DefaultQuality
		}
		if _feed.Format == "" {
			_feed.Format = model.DefaultFormat
		}
		if _feed.PageSize == 0 {
			_feed.PageSize = model.DefaultPageSize
		}
		if _feed.PlaylistSort == "" {
			_feed.PlaylistSort = model.SortingAsc
		}
		if _feed.Clean == nil && c.Cleanup != nil {
			_feed.Clean = c.Cleanup
		}
	}
}
```

Do not temporarily replace `c.Feeds` to finalize remote feeds.

- [ ] **Step 1.3: Add reusable feed helpers**

Add:

```go
func applyFeedIDs(feeds map[string]*feed.Config) {
	for id, f := range feeds {
		f.ID = id
	}
}

func cloneFeedMap(feeds map[string]*feed.Config) map[string]*feed.Config {
	clone := make(map[string]*feed.Config, len(feeds))
	for id, cfg := range feeds {
		clone[id] = cfg
	}
	return clone
}

func (c *Config) finalizeFeeds(feeds map[string]*feed.Config) error {
	if feeds == nil {
		feeds = map[string]*feed.Config{}
	}
	applyFeedIDs(feeds)
	c.applyFeedDefaults(feeds)
	if err := c.applyCookieProfiles(feeds); err != nil {
		return err
	}
	return validateFeedMap(feeds)
}
```

`cloneFeedMap` is shallow by design; feed configs are finalized once and then treated as immutable snapshots.

- [ ] **Step 1.4: Refactor LoadConfig**

Keep `LoadConfig(path)` as the public entrypoint:

```go
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.Wrapf(err, "failed to read config file: %s", path)
	}

	config := Config{}
	if err := toml.Unmarshal(data, &config); err != nil {
		return nil, errors.Wrap(err, "failed to unmarshal toml")
	}

	applyFeedIDs(config.Feeds)
	config.applyDefaults(path)
	config.applyEnv()
	if err := config.applyCookieProfiles(config.Feeds); err != nil {
		return nil, err
	}
	if err := config.validate(path); err != nil {
		return nil, err
	}
	config.LocalFeeds = cloneFeedMap(config.Feeds)

	return &config, nil
}
```

`LocalFeeds` must always preserve the original local `[feeds.*]` map after local defaults/cookie profile mapping. Runtime remote refresh must not overwrite it.

- [ ] **Step 1.5: Apply cookie profiles**

Add:

```go
func (c *Config) applyCookieProfiles(feeds map[string]*feed.Config) error {
	for id, f := range feeds {
		if f.CookieProfile == "" {
			continue
		}
		profile, ok := c.CookieProfiles[f.CookieProfile]
		if !ok {
			return errors.Errorf("cookie profile %q referenced by %q is not configured", f.CookieProfile, id)
		}
		if profile.Path == "" {
			return errors.Errorf("cookie profile %q referenced by %q has empty path", f.CookieProfile, id)
		}
		if profile.Provider == model.ProviderBilibili {
			if f.Bilibili.CookiesFile == "" {
				f.Bilibili.CookiesFile = profile.Path
			}
			continue
		}
		return errors.Errorf("cookie profile %q for %q uses unsupported provider %q", f.CookieProfile, id, profile.Provider)
	}
	return nil
}
```

First version only maps Bilibili cookie profiles because that is the active need. Do not add dashboard cookie management or arbitrary downloader headers.

- [ ] **Step 1.6: Update validation**

Change `validate` signature to:

```go
func (c *Config) validate(configPath string) error
```

Keep existing storage validation unchanged.

Feed-count rule:

```go
if len(c.Feeds) == 0 && !c.Remote.Enabled {
	result = multierror.Append(result, errors.New("at least one feed must be specified"))
}
```

Remote rule:

```go
if c.Remote.Enabled {
	if c.Remote.BaseURL == "" {
		result = multierror.Append(result, errors.New("remote.base_url is required when remote is enabled"))
	} else if parsed, err := url.Parse(c.Remote.BaseURL); err != nil || parsed.Scheme == "" || parsed.Host == "" {
		result = multierror.Append(result, errors.Errorf("remote.base_url must be an absolute URL"))
	}
	if c.Remote.Token == "" {
		result = multierror.Append(result, errors.New("remote.token is required when remote is enabled"))
	}
	if c.Remote.CachePath == "" {
		result = multierror.Append(result, errors.New("remote.cache_path is required when remote is enabled"))
	} else if samePath(c.Remote.CachePath, configPath) {
		result = multierror.Append(result, errors.New("remote.cache_path must not be the main config file"))
	}
	if c.Remote.ConfigRefreshInterval <= 0 {
		result = multierror.Append(result, errors.New("remote.config_refresh_interval must be positive"))
	}
}
```

Add:

```go
func samePath(a, b string) bool {
	absA, errA := filepath.Abs(a)
	absB, errB := filepath.Abs(b)
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return filepath.Clean(absA) == filepath.Clean(absB)
}
```

Move existing per-feed validation into `validateFeedMap(feeds map[string]*feed.Config) error` and call it from `validate` after the feed-count rule.

- [ ] **Step 1.7: Add config tests**

Add tests in `cmd/podsync/config_test.go`:

- `TestLoadRemoteConfigAllowsNoLocalFeeds`
  - remote enabled, no local feeds, required remote fields present.
  - assert no error, `Remote.Enabled`, default refresh interval, empty `Feeds`, empty `LocalFeeds`.

- `TestLoadRemoteConfigRequiresConnectionFields`
  - remote enabled with missing fields.
  - assert error includes `remote.base_url`, `remote.token`, `remote.cache_path`.

- `TestLoadRemoteConfigRejectsRelativeBaseURL`
  - `base_url = "podcast.example.com"`.
  - assert error contains `remote.base_url must be an absolute URL`.

- `TestLoadRemoteConfigRejectsCachePathEqualToConfigPath`
  - create temp config path and use that exact path as `cache_path`.
  - assert error contains `remote.cache_path must not be the main config file`.

- `TestCookieProfileMapsBilibiliCookiesFile`
  - local Bilibili feed references `cookie_profile = "main"`.
  - local `[cookie_profiles.main]` provider/path/readonly set.
  - assert `Bilibili.CookiesFile` is mapped and `CookieProfile` remains `main`.

- `TestCookieProfileMustExist`
  - feed references missing profile.
  - assert error contains profile name.

- `TestCookieProfilePathMustNotBeEmpty`
  - profile exists with provider `bilibili` and no path.
  - assert error contains `empty path`.

- `TestLoadR2ConfigParseOnly`
  - set `[r2] endpoint/bucket/prefix/access_key_id/secret_access_key`.
  - assert fields parse; no validation is required in this phase.

- [ ] **Step 1.8: Run targeted config tests**

Run:

```bash
go test ./cmd/podsync -run 'TestLoadRemoteConfig|TestCookieProfile|TestLoadR2Config|TestRemoteDisabledDoesNotChangeLocalConfig|TestLoadConfig'
```

Expected: PASS.

---

### Task 2: Remote TOML Resolver With Safe Cache Fallback

**Files:**

- Create: `cmd/podsync/remote_config.go`
- Create: `cmd/podsync/remote_config_test.go`
- Modify: `cmd/podsync/config.go` if helper signatures need a small adjustment

- [ ] **Step 2.1: Add resolver types**

Create `cmd/podsync/remote_config.go`:

```go
package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/feed"
)

type remoteFeedSource string

const (
	remoteFeedSourceLocal         remoteFeedSource = "local"
	remoteFeedSourceRemote        remoteFeedSource = "remote"
	remoteFeedSourceCache         remoteFeedSource = "cache"
	remoteFeedSourceLocalFallback remoteFeedSource = "local_fallback"
	remoteFeedSourceEmpty         remoteFeedSource = "empty"
)

type resolvedFeeds struct {
	Feeds     map[string]*feed.Config
	Source    remoteFeedSource
	CacheData []byte
}

type remoteHTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

type remoteFeedFile struct {
	Feeds map[string]*feed.Config
}
```

`CacheData` is set only for a fresh remote HTTP response that parsed and validated. Use `nil` to mean "no cache candidate". A zero-length non-nil slice is a valid cache candidate for an empty remote feed set. The caller writes cache only after accepting the snapshot.

- [ ] **Step 2.2: Add schedule validation helper required by resolver**

Create `cmd/podsync/scheduler.go` with schedule validation before adding the resolver parser:

```go
package main

import (
	"fmt"

	"github.com/pkg/errors"
	"github.com/robfig/cron/v3"

	"github.com/mxpv/podsync/pkg/feed"
)

func feedCronSchedule(feedConfig *feed.Config) (string, bool) {
	if feedConfig.CronSchedule != "" {
		return feedConfig.CronSchedule, true
	}
	return fmt.Sprintf("@every %s", feedConfig.UpdatePeriod.String()), false
}

func validateFeedSchedules(feeds map[string]*feed.Config) error {
	c := cron.New()
	for id, feedConfig := range feeds {
		schedule, _ := feedCronSchedule(feedConfig)
		entryID, err := c.AddFunc(schedule, func() {})
		if err != nil {
			return errors.Wrapf(err, "invalid cron_schedule for %q", id)
		}
		c.Remove(entryID)
	}
	return nil
}
```

Task 3 extends this same file with `scheduledFeed` and `reconcileFeedSchedules`. Creating this validator in Task 2 keeps resolver tests independently compilable.

- [ ] **Step 2.3: Add endpoint derivation**

Add:

```go
func remoteConfigURL(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.Errorf("remote.base_url must be absolute: %s", baseURL)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/nas/config.toml"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}
```

This intentionally supports a path prefix in `base_url`. For example, `https://example.com/podsync` becomes `https://example.com/podsync/api/nas/config.toml`. Add a test for this behavior.

- [ ] **Step 2.4: Add bounded remote fetch**

Add:

```go
func fetchRemoteConfig(ctx context.Context, cfg RemoteConfig, client remoteHTTPClient) ([]byte, error) {
	endpoint, err := remoteConfigURL(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	fetchCtx, cancel := context.WithTimeout(ctx, defaultRemoteFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Accept", "application/toml, text/plain;q=0.8")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, errors.Errorf("remote config returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return body, nil
}
```

Do not reject an empty or whitespace-only body here. An empty remote body is a valid "zero feeds" snapshot.

- [ ] **Step 2.5: Add TOML parsing and validation**

Add:

```go
func parseRemoteFeedConfig(data []byte, cfg *Config) (map[string]*feed.Config, error) {
	var remote remoteFeedFile
	if len(bytes.TrimSpace(data)) > 0 {
		if err := toml.Unmarshal(data, &remote); err != nil {
			return nil, errors.Wrap(err, "failed to unmarshal remote feed toml")
		}
	}
	if remote.Feeds == nil {
		remote.Feeds = map[string]*feed.Config{}
	}
	if err := cfg.finalizeFeeds(remote.Feeds); err != nil {
		return nil, err
	}
	if err := validateFeedSchedules(remote.Feeds); err != nil {
		return nil, err
	}
	return remote.Feeds, nil
}
```

`validateFeedSchedules` is created in Task 3 and must be safe for an empty map.

- [ ] **Step 2.6: Add cache helpers**

Add:

```go
func writeRemoteConfigCache(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func writeAcceptedRemoteConfigCache(cfg *Config, resolved resolvedFeeds) error {
	if resolved.CacheData == nil {
		return nil
	}
	return writeRemoteConfigCache(cfg.Remote.CachePath, resolved.CacheData)
}
```

The resolver must never call `writeRemoteConfigCache` directly. Callers write cache only after the snapshot is accepted for the current mode.

- [ ] **Step 2.7: Add startup resolver**

Add:

```go
func resolveFeeds(ctx context.Context, cfg *Config, client remoteHTTPClient) (resolvedFeeds, error) {
	if !cfg.Remote.Enabled {
		return resolvedFeeds{Feeds: cfg.Feeds, Source: remoteFeedSourceLocal}, nil
	}

	body, fetchErr := fetchRemoteConfig(ctx, cfg.Remote, client)
	if fetchErr == nil {
		feeds, parseErr := parseRemoteFeedConfig(body, cfg)
		if parseErr == nil {
			return resolvedFeeds{Feeds: feeds, Source: remoteFeedSourceRemote, CacheData: body}, nil
		}
		fetchErr = parseErr
	}

	if cached, err := os.ReadFile(cfg.Remote.CachePath); err == nil {
		if feeds, parseErr := parseRemoteFeedConfig(cached, cfg); parseErr == nil {
			return resolvedFeeds{Feeds: feeds, Source: remoteFeedSourceCache}, fetchErr
		}
	}

	if len(cfg.LocalFeeds) > 0 {
		return resolvedFeeds{Feeds: cfg.LocalFeeds, Source: remoteFeedSourceLocalFallback}, fetchErr
	}

	return resolvedFeeds{Feeds: map[string]*feed.Config{}, Source: remoteFeedSourceEmpty}, fetchErr
}
```

Startup may use cache, local fallback, or empty if remote is unavailable. If a fallback is used because remote fetch or parse failed, return the fallback plus the original error so startup logs the root cause while still continuing.

- [ ] **Step 2.8: Add refresh resolver**

Add:

```go
func refreshFeeds(ctx context.Context, cfg *Config, client remoteHTTPClient) (resolvedFeeds, bool, error) {
	body, fetchErr := fetchRemoteConfig(ctx, cfg.Remote, client)
	if fetchErr == nil {
		feeds, parseErr := parseRemoteFeedConfig(body, cfg)
		if parseErr == nil {
			return resolvedFeeds{Feeds: feeds, Source: remoteFeedSourceRemote, CacheData: body}, true, nil
		}
		fetchErr = parseErr
	}

	if cached, err := os.ReadFile(cfg.Remote.CachePath); err == nil {
		if feeds, parseErr := parseRemoteFeedConfig(cached, cfg); parseErr == nil {
			return resolvedFeeds{Feeds: feeds, Source: remoteFeedSourceCache}, true, fetchErr
		}
	}

	return resolvedFeeds{}, false, fetchErr
}
```

Periodic refresh must not fall back to local or empty. If neither remote nor cache is valid, keep the current active feed set.

- [ ] **Step 2.9: Add resolver tests**

Create `cmd/podsync/remote_config_test.go`.

Add fake client helpers:

```go
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) Do(req *http.Request) (*http.Response, error) {
	return f(req)
}

func textResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}
```

Tests:

- `TestRemoteConfigURLAppendsAPIPath`
  - base `https://podcast.example.com/base/`.
  - expect `https://podcast.example.com/base/api/nas/config.toml`.

- `TestResolveFeedsUsesRemoteAndReturnsCacheCandidate`
  - local config has `[remote]` and Bilibili cookie profile.
  - fake client asserts path `/api/nas/config.toml`, `Authorization: Bearer secret`, and `Accept`.
  - remote TOML contains `[feeds."bili.feed-1"]`, `cookie_profile = "main"`, and `filters = { not_title = "直播" }`.
  - assert source `remote`, feed ID set, Bilibili cookies mapped, filter preserved, `CacheData` equals body.
  - call `writeAcceptedRemoteConfigCache` and assert cache file equals remote body.

- `TestResolveFeedsAcceptsEmptyRemoteFeedSet`
  - fake client returns whitespace or empty TOML.
  - assert source `remote`, zero feeds, `CacheData != nil`, and `len(CacheData) == 0` when the response body is truly empty.
  - call `writeAcceptedRemoteConfigCache` and assert the cache file exists with zero bytes.

- `TestResolveFeedsFallsBackToCache`
  - fake client returns HTTP 500.
  - cache file contains valid feed TOML.
  - assert source `cache`, feed from cache, and non-nil error so startup can log the remote failure.

- `TestResolveFeedsInvalidRemoteDoesNotOverwriteCache`
  - cache file contains valid TOML.
  - fake client returns invalid TOML.
  - call resolver and cache writer only when `CacheData` is set.
  - assert source `cache` and cache file remains original.

- `TestResolveFeedsFallsBackToOriginalLocalFeeds`
  - fake client returns HTTP 500.
  - no cache.
  - local feed exists.
  - set `cfg.Feeds` to a different remote-looking map before calling resolver.
  - assert source `local_fallback` uses `cfg.LocalFeeds`, not `cfg.Feeds`, and returns non-nil error.

- `TestResolveFeedsReturnsEmptyWhenNoFallback`
  - fake client returns HTTP 500.
  - no cache.
  - no local feeds.
  - assert source `empty`, empty feed map, and non-nil error.

- `TestRefreshFeedsKeepsCurrentWhenRemoteAndCacheFail`
  - fake client returns HTTP 500.
  - no cache.
  - assert `apply == false`.

- `TestRefreshFeedsCanApplyEmptyRemoteFeedSet`
  - fake client returns whitespace.
  - assert `apply == true`, source `remote`, zero feeds.

- `TestFetchRemoteConfigHonorsContextTimeout`
  - fake client waits on `req.Context().Done()`.
  - use a parent context with a very short timeout, such as `context.WithTimeout(context.Background(), 10*time.Millisecond)`, so the test does not wait for `defaultRemoteFetchTimeout`.
  - assert returned error is non-nil.

- [ ] **Step 2.10: Run resolver tests**

Run:

```bash
go test ./cmd/podsync -run 'TestRemoteConfigURL|TestResolveFeeds|TestRefreshFeeds|TestFetchRemoteConfig|TestLoadRemoteConfig|TestCookieProfile'
```

Expected: PASS.

---

### Task 3: Feed Scheduler Reconcile And Updater Feed Snapshot

**Files:**

- Modify: `cmd/podsync/scheduler.go`
- Create: `cmd/podsync/scheduler_test.go`
- Modify: `services/update/updater.go`
- Modify: `services/update/updater_test.go`

- [ ] **Step 3.1: Make updater feed map replaceable**

Modify `services/update/updater.go`:

- Add `sync.RWMutex` to `Manager`.
- Add:

```go
func (u *Manager) SetFeeds(feeds map[string]*feed.Config) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.feeds = feeds
}

func (u *Manager) Feed(id string) (*feed.Config, bool) {
	u.mu.RLock()
	defer u.mu.RUnlock()
	feedConfig, ok := u.feeds[id]
	return feedConfig, ok
}

func (u *Manager) feedSnapshot() map[string]*feed.Config {
	u.mu.RLock()
	defer u.mu.RUnlock()
	feeds := make(map[string]*feed.Config, len(u.feeds))
	for id, cfg := range u.feeds {
		feeds[id] = cfg
	}
	return feeds
}
```

- Update `buildOPML`:

```go
opml, err := feed.BuildOPML(ctx, u.feedSnapshot(), u.db, u.hostname)
```

The update listener will use `Feed(id)` to drop queued stale feed updates after remote deletion/disable.

- [ ] **Step 3.2: Add updater tests**

Add tests in `services/update/updater_test.go`:

- `TestSetFeedsReplacesFeedSnapshot`
- `TestFeedSnapshotDoesNotExposeInternalMap`
- `TestFeedReturnsCurrentFeedAndRejectsRemovedFeed`

`TestFeedReturnsCurrentFeedAndRejectsRemovedFeed`:

```go
func TestFeedReturnsCurrentFeedAndRejectsRemovedFeed(t *testing.T) {
	manager := &Manager{feeds: map[string]*feed.Config{
		"old": {ID: "old"},
	}}
	manager.SetFeeds(map[string]*feed.Config{
		"new": {ID: "new"},
	})

	_, ok := manager.Feed("old")
	require.False(t, ok)
	feedConfig, ok := manager.Feed("new")
	require.True(t, ok)
	require.Equal(t, "new", feedConfig.ID)
}
```

- [ ] **Step 3.3: Extend scheduler helpers**

Extend `cmd/podsync/scheduler.go` created in Task 2:

```go
type scheduledFeed struct {
	entryID  cron.EntryID
	schedule string
}
```

Add reconcile. It receives `updates` only so scheduled cron callbacks can enqueue later; it must return feeds to queue immediately after the caller releases locks:

```go
func reconcileFeedSchedules(c *cron.Cron, entries map[string]scheduledFeed, feeds map[string]*feed.Config, updates chan<- *feed.Config) ([]*feed.Config, error) {
	if err := validateFeedSchedules(feeds); err != nil {
		return nil, err
	}

	for id, entry := range entries {
		if _, ok := feeds[id]; !ok {
			c.Remove(entry.entryID)
			delete(entries, id)
		}
	}

	var queue []*feed.Config
	for id, feedConfig := range feeds {
		schedule, hasExplicitCronSchedule := feedCronSchedule(feedConfig)
		if existing, ok := entries[id]; ok {
			if existing.schedule == schedule {
				continue
			}
			c.Remove(existing.entryID)
		}

		cronFeed := feedConfig
		entryID, err := c.AddFunc(schedule, func() {
			updates <- cronFeed
		})
		if err != nil {
			return nil, err
		}
		entries[id] = scheduledFeed{entryID: entryID, schedule: schedule}

		if !hasExplicitCronSchedule {
			queue = append(queue, cronFeed)
		}
	}

	return queue, nil
}
```

`validateFeedSchedules` runs before mutation so invalid remote schedules do not partially alter cron entries or become cacheable. `reconcileFeedSchedules` must never send initial updates directly; callers enqueue returned feeds after manager state is updated and after scheduler locks are released.

Add:

```go
func enqueueFeedUpdates(updates chan<- *feed.Config, feeds []*feed.Config) {
	for _, feedConfig := range feeds {
		updates <- feedConfig
	}
}
```

- [ ] **Step 3.4: Add scheduler tests**

Create `cmd/podsync/scheduler_test.go`.

Tests:

- `TestValidateFeedSchedulesRejectsInvalidCron`
  - feed has `CronSchedule = "not a cron"`.
  - assert error contains feed ID.

- `TestValidateFeedSchedulesAllowsEmptySet`
  - pass empty map.
  - assert no error.

- `TestReconcileFeedSchedulesAddsFeedsAndQueuesInitialUpdate`
  - two feeds, one with empty `CronSchedule`, one with explicit cron.
  - assert two entries.
  - assert returned queue contains only the non-explicit feed.

- `TestReconcileFeedSchedulesRemovesDeletedFeeds`
  - reconcile with feed A and B.
  - drain initial queue.
  - reconcile with only B.
  - assert entries only contains B.

- `TestReconcileFeedSchedulesUpdatesChangedSchedule`
  - reconcile feed A with `UpdatePeriod = time.Hour`.
  - remember entry ID.
  - reconcile feed A with `UpdatePeriod = 2 * time.Hour`.
  - assert entry ID changed and returned queue contains A once.

- `TestReconcileFeedSchedulesDoesNotDuplicateUnchangedFeed`
  - reconcile same feed twice without schedule change.
  - assert entry ID unchanged and second reconcile returns empty queue.

- `TestReconcileFeedSchedulesRejectsInvalidChangeWithoutMutatingEntries`
  - start with valid feed A.
  - reconcile with feed A invalid cron.
  - assert error and existing entry remains unchanged.

- `TestReconcileFeedSchedulesReturnsLargeInitialQueueWithoutBlocking`
  - create more feeds than the runtime updates channel buffer, such as 32 feeds.
  - call `reconcileFeedSchedules` with an updates channel that has no active consumer.
  - assert it returns immediately with a 32-item queue and does not send during the reconcile call.

- `TestReconcileFeedSchedulesCronCallbackStillEnqueues`
  - reconcile one feed with `CronSchedule = "@every 1ms"` and a buffered updates channel.
  - start the cron, defer `c.Stop()`, and wait up to `200ms`.
  - assert the cron callback sends that feed to the updates channel.

- [ ] **Step 3.5: Run scheduler tests**

Run:

```bash
go test ./cmd/podsync ./services/update -run 'TestValidateFeedSchedules|TestReconcileFeedSchedules|TestSetFeeds|TestFeedSnapshot|TestFeedReturnsCurrentFeed|TestProviderKey'
```

Expected: PASS.

---

### Task 4: Main Runtime Integration

**Files:**

- Modify: `cmd/podsync/main.go`

- [ ] **Step 4.1: Create remote HTTP client**

In `main.go`, after config/log setup:

```go
remoteClient := &http.Client{Timeout: defaultRemoteFetchTimeout + 5*time.Second}
```

`fetchRemoteConfig` still uses per-request context timeout. The client timeout is an extra safety net.

- [ ] **Step 4.2: Resolve active feeds without overwriting local fallback**

After database/storage setup and before filename migration:

```go
resolved, err := resolveFeeds(ctx, cfg, remoteClient)
if err != nil {
	log.WithError(err).Error("failed to resolve remote feeds")
}
activeFeeds := resolved.Feeds
if err := writeAcceptedRemoteConfigCache(cfg, resolved); err != nil {
	log.WithError(err).Warn("failed to write accepted remote config cache")
}
log.WithField("source", resolved.Source).Info("resolved feed configuration")
```

Do not assign `cfg.Feeds = resolved.Feeds`. `cfg.Feeds` and `cfg.LocalFeeds` remain the original local config for emergency fallback. Use `activeFeeds` for migration, headless, updater construction, and scheduler.

- [ ] **Step 4.3: Route existing flows through activeFeeds**

Replace:

```go
migration := migrate.New(cfg.Feeds, database, storage, opts.MigrateFilenamesDryRun)
```

with:

```go
migration := migrate.New(activeFeeds, database, storage, opts.MigrateFilenamesDryRun)
```

Replace updater construction:

```go
manager, err := update.NewUpdater(activeFeeds, keys, cfg.Server.Hostname, downloader, database, storage)
```

Replace headless loop:

```go
for _, _feed := range activeFeeds {
	if err := manager.Update(ctx, _feed); err != nil {
		log.WithError(err).Errorf("failed to update feed: %s", _feed.URL)
	}
}
```

- [ ] **Step 4.4: Declare schedule state outside goroutines**

Before starting goroutines:

```go
entries := make(map[string]scheduledFeed)
var entriesMu sync.RWMutex
```

Add `sync` import. Both update listener and scheduler refresh must use this same lock.

- [ ] **Step 4.5: Drop stale queued updates**

In the update listener, replace direct `manager.Update(ctx, _feed)` with:

```go
entriesMu.RLock()
currentFeed, ok := manager.Feed(_feed.ID)
entry, entryOK := entries[_feed.ID]
entriesMu.RUnlock()
if !ok {
	log.WithField("feed_id", _feed.ID).Info("skipping stale queued feed update")
	continue
}
if err := manager.Update(ctx, currentFeed); err != nil {
	log.WithError(err).Errorf("failed to update feed: %s", currentFeed.URL)
} else {
	if entryOK {
		log.Infof("next update of %s: %s", currentFeed.ID, c.Entry(entry.entryID).Next)
	}
}
```

This prevents a queued update for a removed feed from running after remote disable/delete. The listener must not hold `entriesMu` while running `manager.Update`.

- [ ] **Step 4.6: Initial scheduler reconcile**

Inside the scheduler goroutine before `c.Start()`:

```go
entriesMu.Lock()
feedsToQueue, err := reconcileFeedSchedules(c, entries, activeFeeds, updates)
if err != nil {
	entriesMu.Unlock()
	log.WithError(err).Fatal("can't reconcile cron tasks")
}
entriesMu.Unlock()
enqueueFeedUpdates(updates, feedsToQueue)
c.Start()
```

The initial `activeFeeds` already passed validation; fatal here means an unexpected scheduler error. Initial queueing happens after the lock is released to avoid deadlock when the number of feeds exceeds the updates channel buffer.

- [ ] **Step 4.7: Add remote refresh ticker**

Inside the scheduler goroutine:

```go
var refresh <-chan time.Time
var ticker *time.Ticker
if cfg.Remote.Enabled {
	ticker = time.NewTicker(cfg.Remote.ConfigRefreshInterval)
	refresh = ticker.C
	defer ticker.Stop()
}
```

In the select loop:

```go
case <-refresh:
	resolved, apply, err := refreshFeeds(ctx, cfg, remoteClient)
	if err != nil {
		log.WithError(err).Error("failed to refresh remote feeds")
	}
	if !apply {
		log.Info("keeping current feed configuration")
		continue
	}

	entriesMu.Lock()
	feedsToQueue, err := reconcileFeedSchedules(c, entries, resolved.Feeds, updates)
	if err != nil {
		entriesMu.Unlock()
		log.WithError(err).Error("failed to reconcile remote feed schedules")
		continue
	}
	manager.SetFeeds(resolved.Feeds)
	activeFeeds = resolved.Feeds
	entriesMu.Unlock()

	if err := writeAcceptedRemoteConfigCache(cfg, resolved); err != nil {
		log.WithError(err).Warn("failed to write accepted remote config cache")
	}
	enqueueFeedUpdates(updates, feedsToQueue)
	log.WithField("source", resolved.Source).Info("refreshed feed configuration")
```

Refresh failure without a valid cache keeps the current active set. Remote success with zero feeds applies and removes all schedules. This phase does not cancel an update that has already passed the stale check and entered `manager.Update`; it prevents queued or future stale updates from starting after the new feed map is applied.

- [ ] **Step 4.8: Run main package tests**

Run:

```bash
go test ./cmd/podsync
```

Expected: PASS.

---

### Task 5: Phase 2 Quality Gate And Commit

**Files:**

- All files touched in Tasks 1-4

- [ ] **Step 5.1: Run full Go gate**

Run:

```bash
go test ./...
go test -race ./cmd/podsync ./services/update
go build -trimpath -tags netgo -o /tmp/podsync-check ./cmd/podsync
```

Expected: PASS.

- [ ] **Step 5.2: Run Worker regression gate**

Run:

```bash
cd cloudflare/worker
npm run check
npm run d1:check
npm run wrangler:check
```

Expected: PASS if Worker dependencies are installed. If dependencies are missing in a clean checkout, run `npm ci` first. If Wrangler requires external Cloudflare credentials or resource ids, record that exact blocker and keep the Go gate as the required Phase 2 gate.

- [ ] **Step 5.3: Diff scope review**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- Go runtime/config/scheduler files changed.
- Phase 2 plan file changed.
- `cloudflare/worker/**` unchanged except ignored local artifacts.
- No NAS live config, Dockerfile, GitHub Actions, or R2/outbox implementation changes.

- [ ] **Step 5.4: Sub-agent implementation review**

Dispatch two read-only reviewers:

```text
Spec reviewer:
  Verify Phase 2A/2B/2C from docs/remote-control-plane.md are implemented:
  [remote] config, parse-only [r2], [cookie_profiles], remote TOML fetch/cache/fallback,
  empty remote feed set as valid authoritative snapshot, preserved original local fallback,
  invalid TOML/schedule/profile cache protection, refresh keeps current set on failure,
  scheduler add/remove/update reconcile, stale queued update skip,
  updater OPML uses current feed map, and remote disabled local behavior is preserved.

Quality reviewer:
  Review race safety, HTTP timeout behavior, cache file atomicity, error/fallback semantics,
  scheduler entry map locking, manager feed snapshot locking, test coverage,
  and absence of R2/outbox/tombstone scope creep.
```

Expected: no blocking or important findings. Fix and re-review any blocking or important findings before commit.

- [ ] **Step 5.5: Commit Phase 2**

Commit after all gates and reviews pass:

```bash
git add cmd/podsync pkg/feed services/update docs/superpowers/plans/2026-07-06-remote-runtime-config.md
git commit -m "feat: resolve remote runtime config"
```

Do not push unless explicitly requested.
