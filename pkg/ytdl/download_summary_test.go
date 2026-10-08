package ytdl

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fakeSummaryDownloader(t *testing.T, help, metadata, failure string) *YoutubeDl {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell downloader fixture requires POSIX")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "youtube-dl")
	script := `#!/bin/sh
case "$1" in
--version) echo 2026.08.19; exit 0;;
--help) printf '%s\n' '` + help + `'; exit 0;;
esac
output=''
cookies=''
previous=''
summary=0
for arg do
 if [ "$previous" = '--output' ]; then output="$arg"; fi
 if [ "$previous" = '--cookies' ]; then cookies="$arg"; fi
 case "$arg" in *__PODSYNC_DOWNLOAD_META__*) summary=1;; esac
 previous="$arg"
done
if [ -n "$cookies" ]; then printf 'rewritten-cookie' > "$cookies"; fi
if [ "$summary" = 1 ]; then printf '%s\n' '__PODSYNC_DOWNLOAD_META__` + metadata + `'; fi
`
	if failure != "" {
		script += "printf '%s\\n' '" + failure + "'\nexit 1\n"
	} else {
		script += "printf audio > \"${output%.*}.mp3\"\n"
	}
	require.NoError(t, os.WriteFile(path, []byte(script), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte("#!/bin/sh\necho fake-ffmpeg\n"), 0700))
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	downloader, err := New(context.Background(), Config{CustomBinary: path})
	require.NoError(t, err)
	return downloader
}

func TestDownloadStructuredSummaryDoesNotChangeDelivery(t *testing.T) {
	for _, test := range []struct {
		name, help, metadata string
		available            bool
	}{
		{"yt-dlp", "--print [WHEN:]TEMPLATE", `{"format_id":"18","acodec":"mp4a.40.2","protocol":"https","token":"private-token","url":"https://private.example/media"}`, true},
		{"malformed metadata", "--print [WHEN:]TEMPLATE", `not-json-private-token`, false},
		{"legacy youtube-dl", "--dump-json", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			downloader := fakeSummaryDownloader(t, test.help, test.metadata, "")
			reader, err := downloader.Download(context.Background(), &feed.Config{
				Format:        model.FormatAudio,
				YouTubeDLArgs: []string{"--extractor-args", "youtube:player_client=mweb;po_token=private-token"},
			}, &model.Episode{ID: "episode", VideoURL: "https://www.youtube.com/watch?v=episode"})
			require.NoError(t, err)
			body, err := io.ReadAll(reader)
			require.NoError(t, err)
			assert.Equal(t, "audio", string(body))
			_, seekable := reader.(io.Seeker)
			assert.True(t, seekable, "preserve the original file reader's capabilities")
			file := reader.(*tempFile)
			fields := file.DownloadSummary().LogFields()
			assert.Equal(t, test.available, fields["metadata_available"])
			assert.Equal(t, "complete", fields["last_stage"])
			assert.Equal(t, "mweb", fields["configured_player_client"])
			if test.available {
				assert.Equal(t, "18", fields["format_id"])
				assert.Equal(t, "mp4a.40.2", fields["audio_codec"])
				assert.Equal(t, "https", fields["protocol"])
			}
			assert.NotContains(t, fields, "token")
			assert.NotContains(t, fields, "url")
			require.NoError(t, reader.Close())
			_, err = os.Stat(file.dir)
			assert.True(t, os.IsNotExist(err))
		})
	}
}

func TestDownloadSummaryPreservesTerminalErrorAndStripsMetadata(t *testing.T) {
	terminal := "ERROR: [download] Got error: The read operation timed out. Giving up after 1 retries"
	downloader := fakeSummaryDownloader(t, "--print [WHEN:]TEMPLATE",
		`{"format_id":"18","acodec":"mp4a.40.2","protocol":"https","cookie":"private-cookie"}`, terminal)
	reader, err := downloader.Download(context.Background(), &feed.Config{Format: model.FormatAudio},
		&model.Episode{ID: "episode", VideoURL: "https://www.youtube.com/watch?v=episode"})
	require.Error(t, err)
	assert.Nil(t, reader)
	assert.Equal(t, terminal+"\n", err.Error())
	assert.NotContains(t, err.Error(), "private-cookie")
	provider := err.(SummaryProvider)
	fields := provider.DownloadSummary().LogFields()
	assert.Equal(t, "media", fields["last_stage"])
	assert.Equal(t, "18", fields["format_id"])
}

func TestDownloadSummaryKeepsSourceBilibiliCookiesUnchanged(t *testing.T) {
	downloader := fakeSummaryDownloader(t, "--print [WHEN:]TEMPLATE", `{}`, "")
	path := filepath.Join(t.TempDir(), "cookies.txt")
	require.NoError(t, os.WriteFile(path, []byte("source-cookie"), 0600))
	reader, err := downloader.Download(context.Background(), &feed.Config{
		Format: model.FormatAudio, Bilibili: feed.BilibiliConfig{CookiesFile: path},
	}, &model.Episode{ID: "episode", VideoURL: "https://www.bilibili.com/video/BVtest"})
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	contents, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "source-cookie", string(contents))
}

func TestDownloadSummaryRejectsUnsafeMetadataFields(t *testing.T) {
	output := downloadMetadataPrefix + `{"format_id":"https://private.example/media?token=secret","acodec":"Bearer secret","protocol":"https","token":"secret"}` + "\n"
	cleaned, summary := parseDownloadOutput(output)
	assert.Empty(t, strings.TrimSpace(cleaned))
	fields := summary.LogFields()
	assert.NotContains(t, fields, "format_id")
	assert.NotContains(t, fields, "audio_codec")
	assert.NotContains(t, fields, "token")
	assert.Equal(t, "https", fields["protocol"])
}

func TestDownloadSummaryKeepsAvailableFieldsWhenCodecIsMissing(t *testing.T) {
	output := downloadMetadataPrefix + `{"stage":"complete","format_id":"mp4","acodec":null,"protocol":"http"}` + "\n"
	cleaned, summary := parseDownloadOutput(output)
	assert.Empty(t, strings.TrimSpace(cleaned))
	fields := summary.LogFields()
	assert.Equal(t, true, fields["metadata_available"])
	assert.Equal(t, "complete", fields["last_stage"])
	assert.Equal(t, "mp4", fields["format_id"])
	assert.Equal(t, "http", fields["protocol"])
	assert.NotContains(t, fields, "audio_codec")
}

func TestDownloadOutputIsBoundedAndKeepsMetadata(t *testing.T) {
	output := "WARNING: diagnostic beginning\n" + strings.Repeat("progress output\r", 50000) +
		downloadMetadataPrefix + `{"stage":"media","format_id":"18","acodec":"mp4a.40.2","protocol":"https"}` + "\n" +
		strings.Repeat("more progress\r", 50000) + "ERROR: terminal download failure\n"
	cleaned, summary := parseDownloadOutput(output)
	assert.LessOrEqual(t, len(cleaned), 128*1024)
	assert.Contains(t, cleaned, "WARNING: diagnostic beginning")
	assert.Contains(t, cleaned, "ERROR: terminal download failure")
	assert.NotContains(t, cleaned, downloadMetadataPrefix)
	assert.Equal(t, "18", summary.FormatID)
}
