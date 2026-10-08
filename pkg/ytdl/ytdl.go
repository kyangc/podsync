package ytdl

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/pkg/errors"
	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/model"
)

const (
	DefaultDownloadTimeout = 10 * time.Minute
	UpdatePeriod           = 24 * time.Hour
	commandWaitDelay       = 2 * time.Second
)

type PlaylistMetadataThumbnail struct {
	Id         string `json:"id"`
	Url        string `json:"url"`
	Resolution string `json:"resolution"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

type PlaylistMetadata struct {
	Id          string                      `json:"id"`
	Title       string                      `json:"title"`
	Description string                      `json:"description"`
	Thumbnails  []PlaylistMetadataThumbnail `json:"thumbnails"`
	Channel     string                      `json:"channel"`
	ChannelId   string                      `json:"channel_id"`
	ChannelUrl  string                      `json:"channel_url"`
	WebpageUrl  string                      `json:"webpage_url"`
}

var (
	ErrTooManyRequests = errors.New(http.StatusText(http.StatusTooManyRequests))
)

// Config is a youtube-dl related configuration
type Config struct {
	// SelfUpdate toggles self update every 24 hour
	SelfUpdate bool `toml:"self_update"`
	// Timeout in minutes for youtube-dl process to finish download
	Timeout int `toml:"timeout"`
	// CustomBinary is a custom path to youtube-dl, this allows using various youtube-dl forks.
	CustomBinary string `toml:"custom_binary"`
}

type YoutubeDl struct {
	path             string
	timeout          time.Duration
	updateLock       commandLock // Don't call youtube-dl while self updating
	summarySupported bool
}

func New(ctx context.Context, cfg Config) (*YoutubeDl, error) {
	var (
		path string
		err  error
	)

	if cfg.CustomBinary != "" {
		path = cfg.CustomBinary

		// Don't update custom youtube-dl binaries.
		log.Warnf("using custom youtube-dl binary, turning self updates off")
		cfg.SelfUpdate = false
	} else {
		path, err = exec.LookPath("youtube-dl")
		if err != nil {
			return nil, errors.Wrap(err, "youtube-dl binary not found")
		}

		log.Debugf("found youtube-dl binary at %q", path)
	}

	timeout := DefaultDownloadTimeout
	if cfg.Timeout > 0 {
		timeout = time.Duration(cfg.Timeout) * time.Minute
	}

	log.Debugf("download timeout: %d min(s)", int(timeout.Minutes()))

	ytdl := &YoutubeDl{
		path:    path,
		timeout: timeout,
	}

	// Make sure youtube-dl exists
	version, err := ytdl.exec(ctx, "--version")
	if err != nil {
		return nil, errors.Wrap(err, "could not find youtube-dl")
	}

	log.Infof("using youtube-dl %s", version)

	if err := ytdl.ensureDependencies(ctx); err != nil {
		return nil, err
	}
	ytdl.detectSummarySupport(ctx)

	if cfg.SelfUpdate {
		// Do initial blocking update at launch
		if err := ytdl.Update(ctx); err != nil {
			log.WithError(err).Error("failed to update youtube-dl")
		}

		go ytdl.autoUpdate(ctx, UpdatePeriod)
	}

	return ytdl, nil
}

func (dl *YoutubeDl) ensureDependencies(ctx context.Context) error {
	found := false

	if path, err := exec.LookPath("ffmpeg"); err == nil {
		found = true

		output, err := exec.CommandContext(ctx, path, "-version").CombinedOutput()
		if err != nil {
			return errors.Wrap(err, "could not get ffmpeg version")
		}

		log.Infof("found ffmpeg: %s", output)
	}

	if path, err := exec.LookPath("avconv"); err == nil {
		found = true

		output, err := exec.CommandContext(ctx, path, "-version").CombinedOutput()
		if err != nil {
			return errors.Wrap(err, "could not get avconv version")
		}

		log.Infof("found avconv: %s", output)
	}

	if !found {
		return errors.New("either ffmpeg or avconv required to run Podsync")
	}

	return nil
}

func (dl *YoutubeDl) Update(ctx context.Context) error {
	if err := dl.updateLock.Lock(ctx); err != nil {
		return errors.Wrap(err, "waiting for downloader update")
	}
	defer dl.updateLock.Unlock()

	log.Info("updating youtube-dl")
	output, err := dl.exec(ctx, "--update", "--verbose")
	if err != nil {
		log.WithError(err).Error(output)
		return errors.Wrap(err, "failed to self update youtube-dl")
	}

	log.Info(output)
	dl.detectSummarySupport(ctx)
	return nil
}

func (dl *YoutubeDl) PlaylistMetadata(ctx context.Context, url string) (metadata PlaylistMetadata, err error) {
	log.Info("getting playlist metadata for: ", url)
	args := []string{
		"--playlist-items", "0",
		"-J",            // JSON output
		"-q",            // quiet mode
		"--no-warnings", // suppress warnings
		url,
	}
	if err := dl.updateLock.Lock(ctx); err != nil {
		return PlaylistMetadata{}, errors.Wrap(err, "waiting for playlist metadata")
	}
	defer dl.updateLock.Unlock()
	var stdout bytes.Buffer
	diagnostics := newDownloadOutput()
	err = dl.runSeparated(ctx, &stdout, diagnostics, args...)
	output := stdout.String()
	detail, _ := diagnostics.result()
	if err != nil {
		log.WithError(err).Errorf("youtube-dl error: %s", url)

		// YouTube might block host with HTTP Error 429: Too Many Requests
		if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) &&
			(diagnostics.rateLimited || strings.Contains(output, "HTTP Error 429")) {
			return PlaylistMetadata{}, ErrTooManyRequests
		}

		detail = strings.TrimSpace(output + "\n" + detail)
		if detail != "" {
			log.Error(detail)
			err = errors.WithMessage(err, detail)
		}
		return PlaylistMetadata{}, err
	}

	var playlistMetadata *PlaylistMetadata
	if err := json.Unmarshal([]byte(output), &playlistMetadata); err != nil {
		return PlaylistMetadata{}, errors.Wrap(err, "failed to decode playlist metadata")
	}
	if playlistMetadata == nil {
		return PlaylistMetadata{}, errors.New("empty playlist metadata JSON")
	}
	if strings.TrimSpace(detail) != "" {
		log.Warn(detail)
	}
	return *playlistMetadata, nil
}

func (dl *YoutubeDl) Download(ctx context.Context, feedConfig *feed.Config, episode *model.Episode) (r io.ReadCloser, err error) {
	queued := time.Now()
	err = dl.updateLock.Lock(ctx)
	queueWait := time.Since(queued)
	if err != nil {
		return nil, &downloadError{message: errors.Wrap(err, "waiting for downloader").Error(), cause: err,
			summary: DownloadSummary{Stage: "queued", QueueWait: queueWait}}
	}
	defer dl.updateLock.Unlock()

	tmpDir, err := os.MkdirTemp("", "podsync-")
	if err != nil {
		return nil, errors.Wrap(err, "failed to get temp dir for download")
	}

	defer func() {
		if err != nil {
			err1 := os.RemoveAll(tmpDir)
			if err1 != nil {
				log.Errorf("could not remove temp dir: %v", err1)
			}
		}
	}()

	baseName := feed.EpisodeBaseName(feedConfig, episode)
	// filePath with YoutubeDl template format
	filePath := filepath.Join(tmpDir, fmt.Sprintf("%s.%s", baseName, "%(ext)s"))

	downloadFeedConfig := feedConfig
	cookiesFile, err := prepareBilibiliCookiesFile(feedConfig, episode, tmpDir)
	if err != nil {
		return nil, err
	}
	if cookiesFile != "" {
		copiedConfig := *feedConfig
		copiedConfig.Bilibili.CookiesFile = cookiesFile
		downloadFeedConfig = &copiedConfig
	}

	args := buildArgs(downloadFeedConfig, episode, filePath)
	if dl.summarySupported {
		// Per-feed options still take precedence over the default verbosity.
		args = append([]string{"--print", "before_dl:" + downloadMetadataTemplate,
			"--print", "after_move:" + downloadCompletionTemplate, "--no-quiet"}, args...)
	}
	started := time.Now()
	capture := newDownloadOutput()
	err = dl.run(ctx, capture, args...)
	output, summary := capture.result()
	summary.Elapsed = time.Since(started)
	summary.QueueWait = queueWait
	summary.ConfiguredPlayerClient = configuredPlayerClient(feedConfig.YouTubeDLArgs)
	if err != nil {
		log.WithError(err).Errorf("youtube-dl error: %s", filePath)

		// YouTube might block host with HTTP Error 429: Too Many Requests
		if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) && capture.rateLimited {
			return nil, ErrTooManyRequests
		}

		log.Error(output)

		return nil, &downloadError{message: commandErrorDetail(output, err), summary: summary, cause: err, retryReason: capture.retryReason}
	}

	// filePath now with the final extension
	filePath = filepath.Join(tmpDir, feed.EpisodeName(feedConfig, episode))
	f, err := os.Open(filePath)
	if err != nil {
		summary.Stage = "open_output"
		cause := errors.Wrap(err, "failed to open downloaded file")
		return nil, &downloadError{message: cause.Error(), summary: summary, cause: cause}
	}

	summary.Stage = "complete"
	return &tempFile{File: f, dir: tmpDir, summary: summary}, nil
}

func (dl *YoutubeDl) exec(ctx context.Context, args ...string) (string, error) {
	var output bytes.Buffer
	err := dl.run(ctx, &output, args...)
	return output.String(), err
}

func (dl *YoutubeDl) run(ctx context.Context, output io.Writer, args ...string) error {
	return dl.runSeparated(ctx, output, output, args...)
}

func (dl *YoutubeDl) runSeparated(ctx context.Context, stdout, stderr io.Writer, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, dl.timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, dl.path, args...)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = commandWaitDelay
	cleanup := configureCommand(cmd)
	defer cleanup()
	err := cmd.Run()
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return errors.Wrap(err, "failed to execute youtube-dl")
	}

	return nil
}

func buildArgs(feedConfig *feed.Config, episode *model.Episode, outputFilePath string) []string {
	var args []string

	switch feedConfig.Format {
	case model.FormatVideo:
		// Video, mp4, high by default

		format := "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best"

		if feedConfig.Quality == model.QualityLow {
			format = "worstvideo[ext=mp4][vcodec^=avc1]+worstaudio[ext=m4a]/worst[ext=mp4][vcodec^=avc1]/worst[ext=mp4]/worst"
		} else if feedConfig.Quality == model.QualityHigh && feedConfig.MaxHeight > 0 {
			format = fmt.Sprintf("bestvideo[height<=%d][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=%d][ext=mp4][vcodec^=avc1]/best[ext=mp4]/best", feedConfig.MaxHeight, feedConfig.MaxHeight)
		}

		args = append(args, "--format", format)

	case model.FormatAudio:
		// Audio, mp3, high by default
		format := "bestaudio"
		if feedConfig.Quality == model.QualityLow {
			format = "worstaudio"
			if isBilibiliURL(episode.VideoURL) {
				format = "worstaudio/worst"
			}
		} else if isBilibiliURL(episode.VideoURL) {
			format = "bestaudio/best"
		}

		args = append(args, "--extract-audio", "--audio-format", "mp3", "--format", format)

	default:
		args = append(args, "--audio-format", feedConfig.CustomFormat.Extension, "--format", feedConfig.CustomFormat.YouTubeDLFormat)
	}

	args = append(args, defaultDownloadArgs(feedConfig, episode)...)

	// Insert additional per-feed youtube-dl arguments
	args = append(args, feedConfig.YouTubeDLArgs...)

	args = append(args, "--output", outputFilePath, episode.VideoURL)
	return args
}

func prepareBilibiliCookiesFile(feedConfig *feed.Config, episode *model.Episode, tmpDir string) (string, error) {
	if feedConfig.Bilibili.CookiesFile == "" || !isBilibiliURL(episode.VideoURL) {
		return "", nil
	}

	source, err := os.Open(feedConfig.Bilibili.CookiesFile)
	if err != nil {
		return "", errors.Wrap(err, "failed to open bilibili cookies file")
	}
	defer source.Close()

	cookiesFile := filepath.Join(tmpDir, "bilibili-cookies.txt")
	dest, err := os.OpenFile(cookiesFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return "", errors.Wrap(err, "failed to create temporary bilibili cookies file")
	}

	if _, err := io.Copy(dest, source); err != nil {
		dest.Close()
		return "", errors.Wrap(err, "failed to copy bilibili cookies file")
	}
	if err := dest.Close(); err != nil {
		return "", errors.Wrap(err, "failed to close temporary bilibili cookies file")
	}

	return cookiesFile, nil
}

func defaultDownloadArgs(feedConfig *feed.Config, episode *model.Episode) []string {
	if !isBilibiliURL(episode.VideoURL) {
		return nil
	}

	args := []string{
		"--add-header", "Referer:https://www.bilibili.com/",
		"--add-header", "Origin:https://www.bilibili.com",
		"--add-header", "Accept-Language:zh-CN,zh;q=0.9,en;q=0.8",
	}

	if feedConfig.Bilibili.CookiesFile != "" {
		args = append(args, "--cookies", feedConfig.Bilibili.CookiesFile)
	}

	return args
}

func isBilibiliURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}

	return strings.HasSuffix(parsed.Hostname(), "bilibili.com")
}
