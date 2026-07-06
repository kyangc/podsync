package main

import (
	"os"
	"testing"
	"time"

	"github.com/mxpv/podsync/services/web"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

func TestLoadConfig(t *testing.T) {
	const file = `
[tokens]
youtube = "123"
vimeo = ["321", "456"]

[server]
port = 80
data_dir = "test/data/"
health_max_feed_age = "2h"

[database]
dir = "/home/user/db/"

[downloader]
self_update = true
timeout = 15

[feeds]
  [feeds.XYZ]
  url = "https://youtube.com/watch?v=ygIUF678y40"
  page_size = 48
  filename_template = "{{pub_date}}_{{title}}_{{id}}"
  update_period = "5h"
  format = "audio"
  quality = "low"
	# duration filters are in seconds
	# max_age is in days
	# min_age is in days
  filters = { title = "regex for title here", min_duration = 0, max_duration = 86400, max_age = 365, min_age = 1}
  playlist_sort = "desc"
  clean = { keep_last = 10 }
  [feeds.XYZ.custom]
  cover_art = "http://img"
  cover_art_quality = "high"
  category = "TV"
  subcategories = ["1", "2"]
  explicit = true
  lang = "en"
  author = "Mrs. Smith (mrs@smith.org)"
  ownerName = "Mrs. Smith"
  ownerEmail = "mrs@smith.org"
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	assert.NoError(t, err)
	require.NotNil(t, config)

	assert.Equal(t, "test/data/", config.Server.DataDir)
	assert.EqualValues(t, 80, config.Server.Port)
	assert.EqualValues(t, 2*time.Hour, config.Server.HealthMaxFeedAge)

	assert.Equal(t, "/home/user/db/", config.Database.Dir)

	require.Len(t, config.Tokens["youtube"], 1)
	assert.Equal(t, "123", config.Tokens["youtube"][0])
	require.Len(t, config.Tokens["vimeo"], 2)
	assert.Equal(t, "321", config.Tokens["vimeo"][0])
	assert.Equal(t, "456", config.Tokens["vimeo"][1])

	assert.Len(t, config.Feeds, 1)
	feed, ok := config.Feeds["XYZ"]
	assert.True(t, ok)
	assert.Equal(t, "https://youtube.com/watch?v=ygIUF678y40", feed.URL)
	assert.EqualValues(t, 48, feed.PageSize)
	assert.EqualValues(t, "{{pub_date}}_{{title}}_{{id}}", feed.FilenameTemplate)
	assert.EqualValues(t, 5*time.Hour, feed.UpdatePeriod)
	assert.EqualValues(t, "audio", feed.Format)
	assert.EqualValues(t, "low", feed.Quality)
	assert.EqualValues(t, "regex for title here", feed.Filters.Title)
	assert.EqualValues(t, 0, feed.Filters.MinDuration)
	assert.EqualValues(t, 86400, feed.Filters.MaxDuration)
	assert.EqualValues(t, 365, feed.Filters.MaxAge)
	assert.EqualValues(t, 1, feed.Filters.MinAge)
	require.NotNil(t, feed.Clean)
	assert.EqualValues(t, 10, feed.Clean.KeepLast)
	assert.EqualValues(t, model.SortingDesc, feed.PlaylistSort)

	assert.EqualValues(t, "http://img", feed.Custom.CoverArt)
	assert.EqualValues(t, "high", feed.Custom.CoverArtQuality)
	assert.EqualValues(t, "TV", feed.Custom.Category)
	assert.True(t, feed.Custom.Explicit)
	assert.EqualValues(t, "en", feed.Custom.Language)
	assert.EqualValues(t, "Mrs. Smith (mrs@smith.org)", feed.Custom.Author)
	assert.EqualValues(t, "Mrs. Smith", feed.Custom.OwnerName)
	assert.EqualValues(t, "mrs@smith.org", feed.Custom.OwnerEmail)

	assert.EqualValues(t, feed.Custom.Subcategories, []string{"1", "2"})

	assert.Nil(t, config.Database.Badger)

	assert.True(t, config.Downloader.SelfUpdate)
	assert.EqualValues(t, 15, config.Downloader.Timeout)
}

func TestRemoteDisabledDoesNotChangeLocalConfig(t *testing.T) {
	const base = `
[server]
port = 8080
data_dir = "/data"

[feeds]
  [feeds.local]
  url = "https://youtube.com/watch?v=ygIUF678y40"
  page_size = 12
  update_period = "2h"
  format = "audio"
  quality = "low"
  opml = false
  filters = { not_title = "直播", min_duration = 0, max_age = 30 }
  clean = { keep_last = 7 }
`
	const remoteDisabled = base + `
[remote]
enabled = false
base_url = "http://127.0.0.1:1"
token = "unused"
cache_path = "/tmp/podsync-remote-cache.toml"
config_refresh_interval = "5m"
`

	basePath := setup(t, base)
	defer os.Remove(basePath)
	remotePath := setup(t, remoteDisabled)
	defer os.Remove(remotePath)

	baseConfig, err := LoadConfig(basePath)
	require.NoError(t, err)
	remoteConfig, err := LoadConfig(remotePath)
	require.NoError(t, err)

	assert.Equal(t, baseConfig.Server.Hostname, remoteConfig.Server.Hostname)
	assert.Equal(t, baseConfig.Server.Port, remoteConfig.Server.Port)
	assert.Equal(t, baseConfig.Storage, remoteConfig.Storage)
	assert.Equal(t, baseConfig.Database, remoteConfig.Database)

	require.Len(t, baseConfig.Feeds, 1)
	require.Len(t, remoteConfig.Feeds, 1)
	baseFeed := baseConfig.Feeds["local"]
	remoteFeed := remoteConfig.Feeds["local"]
	require.NotNil(t, baseFeed)
	require.NotNil(t, remoteFeed)

	assert.Equal(t, baseFeed.ID, remoteFeed.ID)
	assert.Equal(t, baseFeed.URL, remoteFeed.URL)
	assert.Equal(t, baseFeed.Format, remoteFeed.Format)
	assert.Equal(t, baseFeed.Quality, remoteFeed.Quality)
	assert.Equal(t, baseFeed.PageSize, remoteFeed.PageSize)
	assert.Equal(t, baseFeed.UpdatePeriod, remoteFeed.UpdatePeriod)
	assert.Equal(t, baseFeed.OPML, remoteFeed.OPML)
	assert.Equal(t, baseFeed.Filters, remoteFeed.Filters)
	require.NotNil(t, baseFeed.Clean)
	require.NotNil(t, remoteFeed.Clean)
	assert.Equal(t, baseFeed.Clean.KeepLast, remoteFeed.Clean.KeepLast)
}

func TestLoadRemoteConfigAllowsNoLocalFeeds(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[remote]
enabled = true
base_url = "https://podcast.example.com"
token = "secret"
cache_path = "/tmp/podsync-remote.toml"
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	require.NoError(t, err)
	require.NotNil(t, config)

	assert.True(t, config.Remote.Enabled)
	assert.Equal(t, "https://podcast.example.com", config.Remote.BaseURL)
	assert.Equal(t, "secret", config.Remote.Token)
	assert.Equal(t, "/tmp/podsync-remote.toml", config.Remote.CachePath)
	assert.Equal(t, defaultRemoteConfigRefreshInterval, config.Remote.ConfigRefreshInterval)
	assert.Empty(t, config.Feeds)
	assert.Empty(t, config.LocalFeeds)
}

func TestLoadRemoteConfigRequiresConnectionFields(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[remote]
enabled = true
`
	path := setup(t, file)
	defer os.Remove(path)

	_, err := LoadConfig(path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "remote.base_url is required")
	assert.Contains(t, err.Error(), "remote.token is required")
	assert.Contains(t, err.Error(), "remote.cache_path is required")
}

func TestLoadRemoteConfigRejectsRelativeBaseURL(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[remote]
enabled = true
base_url = "podcast.example.com"
token = "secret"
cache_path = "/tmp/podsync-remote.toml"
`
	path := setup(t, file)
	defer os.Remove(path)

	_, err := LoadConfig(path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "remote.base_url must be an absolute URL")
}

func TestLoadRemoteConfigRejectsCachePathEqualToConfigPath(t *testing.T) {
	path := setup(t, "")
	defer os.Remove(path)
	file := `
[server]
data_dir = "/data"

[remote]
enabled = true
base_url = "https://podcast.example.com"
token = "secret"
cache_path = "` + path + `"
`
	require.NoError(t, os.WriteFile(path, []byte(file), 0o600))

	_, err := LoadConfig(path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "remote.cache_path must not be the main config file")
}

func TestCookieProfileMapsBilibiliCookiesFile(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[cookie_profiles.main]
provider = "bilibili"
path = "/app/config/bilibili-cookies.txt"
readonly = true

[feeds]
  [feeds.bili]
  url = "https://space.bilibili.com/10835521"
  cookie_profile = "main"
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	require.NoError(t, err)
	require.Equal(t, "/app/config/bilibili-cookies.txt", config.Feeds["bili"].Bilibili.CookiesFile)
	assert.Equal(t, "main", config.Feeds["bili"].CookieProfile)
}

func TestCookieProfileMustExist(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.bili]
  url = "https://space.bilibili.com/10835521"
  cookie_profile = "missing"
`
	path := setup(t, file)
	defer os.Remove(path)

	_, err := LoadConfig(path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `cookie profile "missing"`)
}

func TestCookieProfilePathMustNotBeEmpty(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[cookie_profiles.main]
provider = "bilibili"

[feeds]
  [feeds.bili]
  url = "https://space.bilibili.com/10835521"
  cookie_profile = "main"
`
	path := setup(t, file)
	defer os.Remove(path)

	_, err := LoadConfig(path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "empty path")
}

func TestLoadR2ConfigParseOnly(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[r2]
endpoint = "https://account.r2.cloudflarestorage.com"
bucket = "podcasts"
prefix = "audio"
access_key_id = "key-id"
secret_access_key = "secret"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	require.NoError(t, err)
	assert.Equal(t, "https://account.r2.cloudflarestorage.com", config.R2.Endpoint)
	assert.Equal(t, "podcasts", config.R2.Bucket)
	assert.Equal(t, "audio", config.R2.Prefix)
	assert.Equal(t, "key-id", config.R2.AccessKeyID)
	assert.Equal(t, "secret", config.R2.SecretAccessKey)
}

func TestFilenameTemplateValidation(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
  filename_template = "{{bad_token}}_{{id}}"
`
	path := setup(t, file)
	defer os.Remove(path)

	_, err := LoadConfig(path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid filename_template")
}

func TestCustomFormatExtensionValidation(t *testing.T) {
	t.Run("rejects invalid extension", func(t *testing.T) {
		const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
  format = "custom"
  [feeds.A.custom_format]
  extension = "../mp3"
`
		path := setup(t, file)
		defer os.Remove(path)

		_, err := LoadConfig(path)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid custom_format.extension")
	})

	t.Run("accepts normalized extension", func(t *testing.T) {
		const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
  format = "custom"
  [feeds.A.custom_format]
  extension = ".M4A"
`
		path := setup(t, file)
		defer os.Remove(path)

		_, err := LoadConfig(path)
		assert.NoError(t, err)
	})
}

func TestLoadEmptyKeyList(t *testing.T) {
	const file = `
[tokens]
vimeo = []

[server]
data_dir = "/data"
[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	assert.NoError(t, err)
	require.NotNil(t, config)

	require.Len(t, config.Tokens, 1)
	require.Len(t, config.Tokens["vimeo"], 0)
}

func TestNewKeyProvidersSkipsBilibiliTokens(t *testing.T) {
	keys, err := newKeyProviders(map[model.Provider]StringSlice{
		model.ProviderBilibili: {""},
		model.ProviderYoutube:  {"youtube-key"},
	})

	require.NoError(t, err)
	require.NotContains(t, keys, model.ProviderBilibili)
	require.Contains(t, keys, model.ProviderYoutube)
	assert.Equal(t, "youtube-key", keys[model.ProviderYoutube].Get())
}

func TestNewKeyProvidersRejectsEmptyNonBilibiliTokens(t *testing.T) {
	_, err := newKeyProviders(map[model.Provider]StringSlice{
		model.ProviderYoutube: {""},
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "youtube")
}

func TestLoadBilibiliFeedOptions(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.bili]
  url = "https://space.bilibili.com/10835521"
  [feeds.bili.bilibili]
  include_upower_exclusive = true
  cookies_file = "/app/config/bilibili-cookies.txt"
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	require.NoError(t, err)

	bili := config.Feeds["bili"].Bilibili
	assert.True(t, bili.IncludeUpowerExclusive)
	assert.Equal(t, "/app/config/bilibili-cookies.txt", bili.CookiesFile)
}

func TestApplyDefaults(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	assert.NoError(t, err)
	assert.NotNil(t, config)

	assert.Len(t, config.Feeds, 1)
	feed, ok := config.Feeds["A"]
	require.True(t, ok)

	assert.EqualValues(t, feed.UpdatePeriod, model.DefaultUpdatePeriod)
	assert.EqualValues(t, feed.PageSize, 50)
	assert.EqualValues(t, feed.Quality, "high")
	assert.EqualValues(t, feed.Custom.CoverArtQuality, "high")
	assert.EqualValues(t, feed.Format, "video")
}

func TestHttpServerListenAddress(t *testing.T) {
	const file = `
[server]
bind_address = "172.20.10.2"
port = 8080
path = "test"
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"

[database]
  badger = { truncate = true, file_io = true }
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	assert.NoError(t, err)
	require.NotNil(t, config)
	require.NotNil(t, config.Server.BindAddress)
	require.NotNil(t, config.Server.Path)
}

func TestDefaultHostname(t *testing.T) {
	cfg := Config{
		Server: web.Config{},
	}

	t.Run("empty hostname", func(t *testing.T) {
		cfg.applyDefaults("")
		assert.Equal(t, "http://localhost", cfg.Server.Hostname)
	})

	t.Run("empty hostname with port", func(t *testing.T) {
		cfg.Server.Hostname = ""
		cfg.Server.Port = 7979
		cfg.applyDefaults("")
		assert.Equal(t, "http://localhost:7979", cfg.Server.Hostname)
	})

	t.Run("skip overwrite", func(t *testing.T) {
		cfg.Server.Hostname = "https://my.host:4443"
		cfg.Server.Port = 80
		cfg.applyDefaults("")
		assert.Equal(t, "https://my.host:4443", cfg.Server.Hostname)
	})
}

func TestDefaultDatabasePath(t *testing.T) {
	cfg := Config{}
	cfg.applyDefaults("/home/user/podsync/config.toml")
	assert.Equal(t, "/home/user/podsync/db", cfg.Database.Dir)
}

func TestLoadBadgerConfig(t *testing.T) {
	const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"

[database]
  badger = { truncate = true, file_io = true }
`
	path := setup(t, file)
	defer os.Remove(path)

	config, err := LoadConfig(path)
	assert.NoError(t, err)
	require.NotNil(t, config)
	require.NotNil(t, config.Database.Badger)

	assert.True(t, config.Database.Badger.Truncate)
	assert.True(t, config.Database.Badger.FileIO)
}

func TestGlobalCleanupPolicy(t *testing.T) {
	t.Run("global cleanup policy applied to feeds without cleanup", func(t *testing.T) {
		const file = `
[cleanup]
keep_last = 25

[server]
data_dir = "/data"

[feeds]
  [feeds.FEED1]
  url = "https://youtube.com/channel/test1"
  
  [feeds.FEED2]
  url = "https://youtube.com/channel/test2"
  clean = { keep_last = 5 }
`
		path := setup(t, file)
		defer os.Remove(path)

		config, err := LoadConfig(path)
		assert.NoError(t, err)
		require.NotNil(t, config)

		// Global cleanup policy should be set
		require.NotNil(t, config.Cleanup)
		assert.EqualValues(t, 25, config.Cleanup.KeepLast)

		// FEED1 should inherit global cleanup policy
		feed1, ok := config.Feeds["FEED1"]
		assert.True(t, ok)
		require.NotNil(t, feed1.Clean)
		assert.EqualValues(t, 25, feed1.Clean.KeepLast)

		// FEED2 should keep its own cleanup policy
		feed2, ok := config.Feeds["FEED2"]
		assert.True(t, ok)
		require.NotNil(t, feed2.Clean)
		assert.EqualValues(t, 5, feed2.Clean.KeepLast)
	})

	t.Run("no global cleanup policy", func(t *testing.T) {
		const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.FEED1]
  url = "https://youtube.com/channel/test1"
  
  [feeds.FEED2]
  url = "https://youtube.com/channel/test2"
  clean = { keep_last = 5 }
`
		path := setup(t, file)
		defer os.Remove(path)

		config, err := LoadConfig(path)
		assert.NoError(t, err)
		require.NotNil(t, config)

		// Global cleanup policy should not be set
		assert.Nil(t, config.Cleanup)

		// FEED1 should have no cleanup policy
		feed1, ok := config.Feeds["FEED1"]
		assert.True(t, ok)
		assert.Nil(t, feed1.Clean)

		// FEED2 should keep its own cleanup policy
		feed2, ok := config.Feeds["FEED2"]
		assert.True(t, ok)
		require.NotNil(t, feed2.Clean)
		assert.EqualValues(t, 5, feed2.Clean.KeepLast)
	})

	t.Run("feed cleanup overrides global cleanup", func(t *testing.T) {
		const file = `
[cleanup]
keep_last = 100

[server]
data_dir = "/data"

[feeds]
  [feeds.FEED1]
  url = "https://youtube.com/channel/test1"
  clean = { keep_last = 10 }
`
		path := setup(t, file)
		defer os.Remove(path)

		config, err := LoadConfig(path)
		assert.NoError(t, err)
		require.NotNil(t, config)

		// Global cleanup policy should be set
		require.NotNil(t, config.Cleanup)
		assert.EqualValues(t, 100, config.Cleanup.KeepLast)

		// FEED1 should use its own cleanup policy, not the global one
		feed1, ok := config.Feeds["FEED1"]
		assert.True(t, ok)
		require.NotNil(t, feed1.Clean)
		assert.EqualValues(t, 10, feed1.Clean.KeepLast)
	})
}

func TestEnvironmentVariables(t *testing.T) {
	t.Run("environment variables override config tokens", func(t *testing.T) {
		const file = `
[tokens]
youtube = "original_key"
vimeo = "original_vimeo_key"

[server]
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
`
		path := setup(t, file)
		defer os.Remove(path)

		// Set environment variables
		t.Setenv("PODSYNC_YOUTUBE_API_KEY", "env_youtube_key")
		t.Setenv("PODSYNC_VIMEO_API_KEY", "env_vimeo_key")

		config, err := LoadConfig(path)
		assert.NoError(t, err)
		require.NotNil(t, config)

		// Environment variables should override config values
		require.Len(t, config.Tokens[model.ProviderYoutube], 1)
		assert.Equal(t, "env_youtube_key", config.Tokens[model.ProviderYoutube][0])

		require.Len(t, config.Tokens[model.ProviderVimeo], 1)
		assert.Equal(t, "env_vimeo_key", config.Tokens[model.ProviderVimeo][0])
	})

	t.Run("environment variables support multiple keys", func(t *testing.T) {
		const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
`
		path := setup(t, file)
		defer os.Remove(path)

		// Set environment variable with multiple keys
		t.Setenv("PODSYNC_YOUTUBE_API_KEY", "key1 key2 key3")

		config, err := LoadConfig(path)
		assert.NoError(t, err)
		require.NotNil(t, config)

		// Should parse multiple keys from environment variable
		assert.ElementsMatch(t, []string{"key1", "key2", "key3"}, config.Tokens[model.ProviderYoutube])
	})
}

func TestNoIndexConfig(t *testing.T) {
	t.Run("disabled by default", func(t *testing.T) {
		const file = `
[server]
data_dir = "/data"

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
`
		path := setup(t, file)
		defer os.Remove(path)

		config, err := LoadConfig(path)
		assert.NoError(t, err)
		require.NotNil(t, config)
		assert.False(t, config.Server.NoIndex)
	})

	t.Run("enabled when configured", func(t *testing.T) {
		const file = `
[server]
data_dir = "/data"
no_index = true

[feeds]
  [feeds.A]
  url = "https://youtube.com/watch?v=ygIUF678y40"
`
		path := setup(t, file)
		defer os.Remove(path)

		config, err := LoadConfig(path)
		assert.NoError(t, err)
		require.NotNil(t, config)
		assert.True(t, config.Server.NoIndex)
	})
}

func setup(t *testing.T, file string) string {
	t.Helper()

	f, err := os.CreateTemp("", "")
	require.NoError(t, err)

	defer f.Close()

	_, err = f.WriteString(file)
	require.NoError(t, err)

	return f.Name()
}
