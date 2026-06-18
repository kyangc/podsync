package ytdl

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildArgs(t *testing.T) {
	tests := []struct {
		name         string
		format       model.Format
		customFormat feed.CustomFormat
		quality      model.Quality
		maxHeight    int
		output       string
		videoURL     string
		ytdlArgs     []string
		bilibili     feed.BilibiliConfig
		expect       []string
	}{
		{
			name:     "Audio unknown quality",
			format:   model.FormatAudio,
			output:   "/tmp/1",
			videoURL: "http://url",
			expect:   []string{"--extract-audio", "--audio-format", "mp3", "--format", "bestaudio", "--output", "/tmp/1", "http://url"},
		},
		{
			name:     "Audio low quality",
			format:   model.FormatAudio,
			quality:  model.QualityLow,
			output:   "/tmp/1",
			videoURL: "http://url",
			expect:   []string{"--extract-audio", "--audio-format", "mp3", "--format", "worstaudio", "--output", "/tmp/1", "http://url"},
		},
		{
			name:     "Audio best quality",
			format:   model.FormatAudio,
			quality:  model.QualityHigh,
			output:   "/tmp/1",
			videoURL: "http://url",
			expect:   []string{"--extract-audio", "--audio-format", "mp3", "--format", "bestaudio", "--output", "/tmp/1", "http://url"},
		},
		{
			name:     "Audio Bilibili with default headers",
			format:   model.FormatAudio,
			output:   "/tmp/1",
			videoURL: "https://www.bilibili.com/video/BV1e3JK6ZEjF",
			expect: []string{
				"--extract-audio", "--audio-format", "mp3", "--format", "bestaudio",
				"--add-header", "Referer:https://www.bilibili.com/",
				"--add-header", "Origin:https://www.bilibili.com",
				"--add-header", "Accept-Language:zh-CN,zh;q=0.9,en;q=0.8",
				"--output", "/tmp/1", "https://www.bilibili.com/video/BV1e3JK6ZEjF",
			},
		},
		{
			name:     "Audio Bilibili with browser cookies",
			format:   model.FormatAudio,
			output:   "/tmp/1",
			videoURL: "https://www.bilibili.com/video/BV1tGjV68E7h",
			ytdlArgs: []string{"--cookies-from-browser", "chrome"},
			expect: []string{
				"--extract-audio", "--audio-format", "mp3", "--format", "bestaudio",
				"--add-header", "Referer:https://www.bilibili.com/",
				"--add-header", "Origin:https://www.bilibili.com",
				"--add-header", "Accept-Language:zh-CN,zh;q=0.9,en;q=0.8",
				"--cookies-from-browser", "chrome",
				"--output", "/tmp/1", "https://www.bilibili.com/video/BV1tGjV68E7h",
			},
		},
		{
			name:     "Audio Bilibili with cookies file",
			format:   model.FormatAudio,
			output:   "/tmp/1",
			videoURL: "https://www.bilibili.com/video/BV1tGjV68E7h",
			bilibili: feed.BilibiliConfig{CookiesFile: "/app/config/bilibili-cookies.txt"},
			expect: []string{
				"--extract-audio", "--audio-format", "mp3", "--format", "bestaudio",
				"--add-header", "Referer:https://www.bilibili.com/",
				"--add-header", "Origin:https://www.bilibili.com",
				"--add-header", "Accept-Language:zh-CN,zh;q=0.9,en;q=0.8",
				"--cookies", "/app/config/bilibili-cookies.txt",
				"--output", "/tmp/1", "https://www.bilibili.com/video/BV1tGjV68E7h",
			},
		},
		{
			name:     "Video unknown quality",
			format:   model.FormatVideo,
			output:   "/tmp/1",
			videoURL: "http://url",
			expect:   []string{"--format", "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best", "--output", "/tmp/1", "http://url"},
		},
		{
			name:      "Video unknown quality with maxheight",
			format:    model.FormatVideo,
			maxHeight: 720,
			output:    "/tmp/1",
			videoURL:  "http://url",
			expect:    []string{"--format", "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best", "--output", "/tmp/1", "http://url"},
		},
		{
			name:     "Video low quality",
			format:   model.FormatVideo,
			quality:  model.QualityLow,
			output:   "/tmp/2",
			videoURL: "http://url",
			expect:   []string{"--format", "worstvideo[ext=mp4][vcodec^=avc1]+worstaudio[ext=m4a]/worst[ext=mp4][vcodec^=avc1]/worst[ext=mp4]/worst", "--output", "/tmp/2", "http://url"},
		},
		{
			name:      "Video low quality with maxheight",
			format:    model.FormatVideo,
			quality:   model.QualityLow,
			maxHeight: 720,
			output:    "/tmp/2",
			videoURL:  "http://url",
			expect:    []string{"--format", "worstvideo[ext=mp4][vcodec^=avc1]+worstaudio[ext=m4a]/worst[ext=mp4][vcodec^=avc1]/worst[ext=mp4]/worst", "--output", "/tmp/2", "http://url"},
		},
		{
			name:     "Video high quality",
			format:   model.FormatVideo,
			quality:  model.QualityHigh,
			output:   "/tmp/2",
			videoURL: "http://url1",
			expect:   []string{"--format", "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best", "--output", "/tmp/2", "http://url1"},
		},
		{
			name:      "Video high quality with maxheight",
			format:    model.FormatVideo,
			quality:   model.QualityHigh,
			maxHeight: 1024,
			output:    "/tmp/2",
			videoURL:  "http://url1",
			expect:    []string{"--format", "bestvideo[height<=1024][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1024][ext=mp4][vcodec^=avc1]/best[ext=mp4]/best", "--output", "/tmp/2", "http://url1"},
		},
		{
			name:     "Video high quality with custom youtube-dl arguments",
			format:   model.FormatVideo,
			quality:  model.QualityHigh,
			output:   "/tmp/2",
			videoURL: "http://url1",
			ytdlArgs: []string{"--write-sub", "--embed-subs", "--sub-lang", "en,en-US,en-GB"},
			expect:   []string{"--format", "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best", "--write-sub", "--embed-subs", "--sub-lang", "en,en-US,en-GB", "--output", "/tmp/2", "http://url1"},
		},
		{
			name:         "Custom format",
			format:       model.FormatCustom,
			customFormat: feed.CustomFormat{YouTubeDLFormat: "bestaudio[ext=m4a]", Extension: "m4a"},
			quality:      model.QualityHigh,
			output:       "/tmp/2",
			videoURL:     "http://url1",
			expect:       []string{"--audio-format", "m4a", "--format", "bestaudio[ext=m4a]", "--output", "/tmp/2", "http://url1"},
		},
	}

	for _, tst := range tests {
		t.Run(tst.name, func(t *testing.T) {
			result := buildArgs(&feed.Config{
				Format:        tst.format,
				Quality:       tst.quality,
				CustomFormat:  tst.customFormat,
				MaxHeight:     tst.maxHeight,
				YouTubeDLArgs: tst.ytdlArgs,
				Bilibili:      tst.bilibili,
			}, &model.Episode{
				VideoURL: tst.videoURL,
			}, tst.output)

			assert.EqualValues(t, tst.expect, result)
		})
	}
}

func TestPrepareBilibiliCookiesFileUsesTemporaryCopy(t *testing.T) {
	sourceDir := t.TempDir()
	sourcePath := filepath.Join(sourceDir, "bilibili-cookies.txt")
	require.NoError(t, os.WriteFile(sourcePath, []byte("login-cookie"), 0600))

	tmpDir := t.TempDir()
	cookiesFile, err := prepareBilibiliCookiesFile(&feed.Config{
		Bilibili: feed.BilibiliConfig{CookiesFile: sourcePath},
	}, &model.Episode{
		VideoURL: "https://www.bilibili.com/video/BV1tGjV68E7h",
	}, tmpDir)

	require.NoError(t, err)
	assert.Equal(t, filepath.Join(tmpDir, "bilibili-cookies.txt"), cookiesFile)
	assert.NotEqual(t, sourcePath, cookiesFile)

	copied, err := os.ReadFile(cookiesFile)
	require.NoError(t, err)
	assert.Equal(t, "login-cookie", string(copied))

	require.NoError(t, os.WriteFile(cookiesFile, []byte("anonymous-cookie"), 0600))
	source, err := os.ReadFile(sourcePath)
	require.NoError(t, err)
	assert.Equal(t, "login-cookie", string(source))
}

func TestPrepareBilibiliCookiesFileSkipsNonBilibiliEpisodes(t *testing.T) {
	sourcePath := filepath.Join(t.TempDir(), "cookies.txt")
	require.NoError(t, os.WriteFile(sourcePath, []byte("login-cookie"), 0600))

	cookiesFile, err := prepareBilibiliCookiesFile(&feed.Config{
		Bilibili: feed.BilibiliConfig{CookiesFile: sourcePath},
	}, &model.Episode{
		VideoURL: "https://youtube.com/watch?v=abc",
	}, t.TempDir())

	require.NoError(t, err)
	assert.Empty(t, cookiesFile)
}
