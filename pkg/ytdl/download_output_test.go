package ytdl

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDownloadOutputHandlesChunkBoundaries(t *testing.T) {
	metadata := downloadMetadataPrefix + `{"stage":"media","format_id":"18","acodec":null,"protocol":"https"}`
	for _, chunkSize := range []int{1, 7, 31, 4096} {
		t.Run(fmt.Sprint(chunkSize), func(t *testing.T) {
			capture := newDownloadOutput()
			raw := "[youtube] extracting\r\n" + metadata + "\r\n" +
				"ERROR: \r[download] Got error: The read operation timed out. Giving up after 1 retries\n"
			for start := 0; start < len(raw); start += chunkSize {
				_, err := capture.Write([]byte(raw[start:min(len(raw), start+chunkSize)]))
				require.NoError(t, err)
			}
			output, summary := capture.result()
			assert.Equal(t, "[youtube] extracting\r\nERROR: \r[download] Got error: The read operation timed out. Giving up after 1 retries\n", output)
			assert.Equal(t, "18", summary.FormatID)
			assert.Equal(t, "media", summary.Stage)
			assert.Equal(t, int64(len(raw)), summary.OutputBytes)
			assert.Equal(t, "read_timeout", capture.retryReason)
		})
	}
}

func TestDownloadOutputBoundsAnUnterminatedLine(t *testing.T) {
	capture := newDownloadOutput()
	_, err := capture.Write([]byte("Cookie: " + strings.Repeat("private-secret", 200000)))
	require.NoError(t, err)
	output, summary := capture.result()
	assert.True(t, summary.OutputTruncated)
	assert.NotContains(t, output, "private-secret")
	assert.LessOrEqual(t, cap(capture.line), maxDownloadLineBytes)
	assert.LessOrEqual(t, cap(capture.diagnostic.head)+cap(capture.diagnostic.tail), maxDownloadOutputBytes)
}

func TestDownloadOutputMetadataCannotTriggerRetry(t *testing.T) {
	for _, payload := range []string{
		`{"format_id":"18","secret":"HTTP Error 403; The handshake operation timed out"}`,
		strings.Repeat("HTTP Error 429 private-secret ", 1000),
	} {
		capture := newDownloadOutput()
		_, err := capture.Write([]byte(downloadMetadataPrefix + payload + "\nERROR: Requested format is not available\n"))
		require.NoError(t, err)
		output, _ := capture.result()
		assert.Equal(t, "", capture.retryReason)
		assert.False(t, capture.rateLimited)
		assert.NotContains(t, output, "private-secret")
		assert.NotContains(t, output, "HTTP Error")
	}
}

func TestDownloadKeepsSignalsOutsideRetainedOutput(t *testing.T) {
	for _, test := range []struct{ name, signal, reason string }{
		{"tls", "WARNING: The handshake operation timed out", "tls_transport"},
		{"403", "HTTP Error 403: Forbidden", "http_403"},
		{"read timeout", "[download] Got error: The read operation timed out. Giving up after 1 retries", "read_timeout"},
		{"warning only", "WARNING: The read operation timed out. Retrying (1/3)", ""},
		{"429", "HTTP Error 429: Too Many Requests", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			noise := strings.Repeat("verbose diagnostic padding line\r", 10000)
			raw := "diagnostic beginning\n" + noise + test.signal + "\n" +
				downloadMetadataPrefix + `{"stage":"media","format_id":"18","protocol":"https"}` + "\n" +
				noise + "ERROR: Requested format is not available\n"
			path := filepath.Join(t.TempDir(), "output.txt")
			require.NoError(t, os.WriteFile(path, []byte(raw), 0600))
			t.Setenv("PODSYNC_TEST_CAPTURE_FILE", path)
			dl := commandFixture(t, "cat \"$PODSYNC_TEST_CAPTURE_FILE\"\nexit 1\n")
			dl.timeout = 5 * time.Second
			_, err := dl.Download(context.Background(), &feed.Config{Format: model.FormatAudio}, &model.Episode{ID: "episode"})
			require.Error(t, err)
			if test.name == "429" {
				assert.Same(t, ErrTooManyRequests, err)
				return
			}
			assert.NotContains(t, err.Error(), test.signal)
			assert.Contains(t, err.Error(), "ERROR: Requested format is not available")
			assert.LessOrEqual(t, len(err.Error()), maxDownloadOutputBytes)
			assert.Equal(t, test.reason, err.(RetryReasonProvider).DownloadRetryReason())
			summary := err.(SummaryProvider).DownloadSummary()
			assert.True(t, summary.OutputTruncated)
			assert.Equal(t, int64(len(raw)), summary.OutputBytes)
			assert.Equal(t, "18", summary.FormatID)
		})
	}
}

func TestMetadataJSONOutputIsNotTruncated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metadata.json")
	title := strings.Repeat("title", 30000)
	require.NoError(t, os.WriteFile(path, []byte(`{"title":"`+title+`"}`), 0600))
	t.Setenv("PODSYNC_TEST_CAPTURE_FILE", path)
	dl := commandFixture(t, "cat \"$PODSYNC_TEST_CAPTURE_FILE\"\n")
	metadata, err := dl.PlaylistMetadata(context.Background(), "https://example.invalid/playlist")
	require.NoError(t, err)
	assert.Equal(t, title, metadata.Title)
}
