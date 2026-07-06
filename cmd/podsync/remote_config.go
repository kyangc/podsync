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

	"github.com/hashicorp/go-multierror"
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

func readRemoteConfigCache(cfg *Config) (map[string]*feed.Config, error) {
	cached, err := os.ReadFile(cfg.Remote.CachePath)
	if err != nil {
		return nil, errors.Wrap(err, "failed to read remote config cache")
	}
	feeds, err := parseRemoteFeedConfig(cached, cfg)
	if err != nil {
		return nil, errors.Wrap(err, "failed to parse remote config cache")
	}
	return feeds, nil
}

func appendRemoteConfigError(err error, extra error) error {
	if err == nil {
		return extra
	}
	if extra == nil {
		return err
	}
	return multierror.Append(err, extra)
}

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

	if feeds, err := readRemoteConfigCache(cfg); err == nil {
		return resolvedFeeds{Feeds: feeds, Source: remoteFeedSourceCache}, fetchErr
	} else {
		fetchErr = appendRemoteConfigError(fetchErr, err)
	}

	if len(cfg.LocalFeeds) > 0 {
		return resolvedFeeds{Feeds: cfg.LocalFeeds, Source: remoteFeedSourceLocalFallback}, fetchErr
	}

	return resolvedFeeds{Feeds: map[string]*feed.Config{}, Source: remoteFeedSourceEmpty}, fetchErr
}

func refreshFeeds(ctx context.Context, cfg *Config, client remoteHTTPClient) (resolvedFeeds, bool, error) {
	body, fetchErr := fetchRemoteConfig(ctx, cfg.Remote, client)
	if fetchErr == nil {
		feeds, parseErr := parseRemoteFeedConfig(body, cfg)
		if parseErr == nil {
			return resolvedFeeds{Feeds: feeds, Source: remoteFeedSourceRemote, CacheData: body}, true, nil
		}
		fetchErr = parseErr
	}

	if feeds, err := readRemoteConfigCache(cfg); err == nil {
		return resolvedFeeds{Feeds: feeds, Source: remoteFeedSourceCache}, true, fetchErr
	} else {
		fetchErr = appendRemoteConfigError(fetchErr, err)
	}

	return resolvedFeeds{}, false, fetchErr
}
