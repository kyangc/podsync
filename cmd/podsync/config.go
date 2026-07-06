package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hashicorp/go-multierror"
	"github.com/pelletier/go-toml"
	"github.com/pkg/errors"
	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/db"
	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/fs"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/mxpv/podsync/pkg/ytdl"
	"github.com/mxpv/podsync/services/web"
)

type Config struct {
	// Server is the web server configuration
	Server web.Config `toml:"server"`
	// S3 is the optional configuration for S3-compatible storage provider
	Storage fs.Config `toml:"storage"`
	// Log is the optional logging configuration
	Log Log `toml:"log"`
	// Database configuration
	Database db.Config `toml:"database"`
	// Feeds is a list of feeds to host by this app.
	// ID will be used as feed ID in http://podsync.net/{FEED_ID}.xml
	Feeds map[string]*feed.Config
	// Tokens is API keys to use to access YouTube/Vimeo APIs.
	Tokens map[model.Provider]StringSlice `toml:"tokens"`
	// Downloader (youtube-dl) configuration
	Downloader ytdl.Config `toml:"downloader"`
	// Global cleanup policy applied to feeds that don't specify their own cleanup policy
	Cleanup *feed.Cleanup `toml:"cleanup"`
	// Remote controls whether feed definitions are loaded from a remote control plane.
	Remote RemoteConfig `toml:"remote"`
	// R2 is parsed for later remote publish phases.
	R2 R2Config `toml:"r2"`
	// CookieProfiles maps remote feed cookie_profile references to local cookie files.
	CookieProfiles map[string]CookieProfile `toml:"cookie_profiles"`
	// LocalFeeds preserves original local feeds for remote-mode emergency fallback.
	LocalFeeds map[string]*feed.Config `toml:"-"`
}

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

type Log struct {
	// Filename to write the log to (instead of stdout)
	Filename string `toml:"filename"`
	// MaxSize is the maximum size of the log file in MB
	MaxSize int `toml:"max_size"`
	// MaxBackups is the maximum number of log file backups to keep after rotation
	MaxBackups int `toml:"max_backups"`
	// MaxAge is the maximum number of days to keep the logs for
	MaxAge int `toml:"max_age"`
	// Compress old backups
	Compress bool `toml:"compress"`
	// Debug mode
	Debug bool `toml:"debug"`
}

// LoadConfig loads TOML configuration from a file path
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

func (c *Config) validate(configPath string) error {
	var result *multierror.Error

	if c.Server.DataDir != "" {
		log.Warnf(`server.data_dir is deprecated, and will be removed in a future release. Use the following config instead:

[storage]
  [storage.local]
  data_dir = "%s"

`, c.Server.DataDir)
		if c.Storage.Local.DataDir == "" {
			c.Storage.Local.DataDir = c.Server.DataDir
		}
	}

	if c.Server.Path != "" {
		var pathReg = regexp.MustCompile(model.PathRegex)
		if !pathReg.MatchString(c.Server.Path) {
			result = multierror.Append(result, errors.Errorf("Server handle path must be match %s or empty", model.PathRegex))
		}
	}

	switch c.Storage.Type {
	case "local":
		if c.Storage.Local.DataDir == "" {
			result = multierror.Append(result, errors.New("data directory is required for local storage"))
		}
	case "s3":
		if c.Storage.S3.EndpointURL == "" || c.Storage.S3.Region == "" || c.Storage.S3.Bucket == "" {
			result = multierror.Append(result, errors.New("S3 storage requires endpoint_url, region and bucket to be set"))
		}
	default:
		result = multierror.Append(result, errors.Errorf("unknown storage type: %s", c.Storage.Type))
	}

	if len(c.Feeds) == 0 && !c.Remote.Enabled {
		result = multierror.Append(result, errors.New("at least one feed must be specified"))
	}

	if c.Remote.Enabled {
		if c.Remote.BaseURL == "" {
			result = multierror.Append(result, errors.New("remote.base_url is required when remote is enabled"))
		} else if parsed, err := url.Parse(c.Remote.BaseURL); err != nil || parsed.Scheme == "" || parsed.Host == "" {
			result = multierror.Append(result, errors.New("remote.base_url must be an absolute URL"))
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

	if err := validateFeedMap(c.Feeds); err != nil {
		result = multierror.Append(result, err)
	}

	return result.ErrorOrNil()
}

func validateFeedMap(feeds map[string]*feed.Config) error {
	var result *multierror.Error
	for id, f := range feeds {
		if f.URL == "" {
			result = multierror.Append(result, errors.Errorf("URL is required for %q", id))
		}
		if err := feed.ValidateFilenameTemplate(f.FilenameTemplate); err != nil {
			result = multierror.Append(result, errors.Wrapf(err, "invalid filename_template for %q", id))
		}
		if f.Format == model.FormatCustom {
			if err := feed.ValidateCustomExtension(f.CustomFormat.Extension); err != nil {
				result = multierror.Append(result, errors.Wrapf(err, "invalid custom_format.extension for %q", id))
			}
		}
	}
	return result.ErrorOrNil()
}

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

		// Apply global cleanup policy if feed doesn't have its own
		if _feed.Clean == nil && c.Cleanup != nil {
			_feed.Clean = c.Cleanup
		}
	}
}

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

func samePath(a, b string) bool {
	absA, errA := filepath.Abs(a)
	absB, errB := filepath.Abs(b)
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return filepath.Clean(absA) == filepath.Clean(absB)
}

func (c *Config) applyEnv() {
	envVars := map[model.Provider]string{
		model.ProviderYoutube:    "PODSYNC_YOUTUBE_API_KEY",
		model.ProviderVimeo:      "PODSYNC_VIMEO_API_KEY",
		model.ProviderSoundcloud: "PODSYNC_SOUNDCLOUD_API_KEY",
		model.ProviderTwitch:     "PODSYNC_TWITCH_API_KEY",
	}

	// Replace API keys from config with environment variables
	for provider, envVar := range envVars {
		val, ok := os.LookupEnv(envVar)
		if ok {
			log.Infof("Found %s environment variable, replacing config token with it", envVar)
			// If no tokens are provided in the config.toml, we need to create a new map
			if c.Tokens == nil {
				c.Tokens = make(map[model.Provider]StringSlice)
			}
			// Support multiple keys separated by spaces for API key rotation
			keys := strings.Fields(val)
			c.Tokens[provider] = keys
		}
	}
}

// StringSlice is a toml extension that lets you to specify either a string
// value (a slice with just one element) or a string slice.
type StringSlice []string

func (s *StringSlice) UnmarshalTOML(v interface{}) error {
	if str, ok := v.(string); ok {
		*s = []string{str}
		return nil
	}

	return errors.New("failed to decode string slice field")
}
