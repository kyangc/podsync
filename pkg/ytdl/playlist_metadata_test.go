package ytdl

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPlaylistMetadataRejectsInvalidJSON(t *testing.T) {
	for _, output := range []string{"", `{"title":`, "null", "[]", `{"title":42}`} {
		t.Run(output, func(t *testing.T) {
			t.Setenv("PODSYNC_TEST_METADATA", output)
			dl := commandFixture(t, "printf '%s' \"$PODSYNC_TEST_METADATA\"\n")
			_, err := dl.PlaylistMetadata(context.Background(), "https://example.invalid/playlist")
			require.Error(t, err)
			assert.Contains(t, err.Error(), "playlist metadata")
		})
	}
}

func TestPlaylistMetadataSeparatesJSONFromDiagnostics(t *testing.T) {
	dl := commandFixture(t, `printf '%s\n' '{"title":"valid playlist"}'
printf 'WARNING: custom downloader diagnostic\n' >&2
`)
	metadata, err := dl.PlaylistMetadata(context.Background(), "https://example.invalid/playlist")
	require.NoError(t, err)
	assert.Equal(t, "valid playlist", metadata.Title)
}

func TestPlaylistMetadataPreservesRunningCancellation(t *testing.T) {
	for _, output := range []string{"WARNING: extractor transport failure", "HTTP Error 429: Too Many Requests"} {
		t.Run(output, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "ready")
			t.Setenv("PODSYNC_TEST_METADATA_READY", marker)
			t.Setenv("PODSYNC_TEST_METADATA", output)
			dl := commandFixture(t, `printf '%s\n' "$PODSYNC_TEST_METADATA" >&2
: > "$PODSYNC_TEST_METADATA_READY"
exec sleep 30
`)
			dl.timeout = 10 * time.Second
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := dl.PlaylistMetadata(ctx, "https://example.invalid/playlist"); done <- err }()
			require.Eventually(t, func() bool { _, err := os.Stat(marker); return err == nil }, 2*time.Second, 5*time.Millisecond)
			cancel()
			select {
			case err := <-done:
				require.ErrorIs(t, err, context.Canceled)
				assert.Contains(t, err.Error(), output)
			case <-time.After(time.Second):
				t.Fatal("canceled metadata command did not stop")
			}
		})
	}
}

func TestPlaylistMetadataPreservesProcessDeadline(t *testing.T) {
	dl := commandFixture(t, "printf 'HTTP Error 429: Too Many Requests\\n' >&2\nexec sleep 30\n")
	dl.timeout = 2 * time.Second
	_, err := dl.PlaylistMetadata(context.Background(), "https://example.invalid/playlist")
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Contains(t, err.Error(), "HTTP Error 429")
}

func TestPlaylistMetadataPreservesSilentFailureAndRateLimit(t *testing.T) {
	t.Run("silent failure", func(t *testing.T) {
		dl := commandFixture(t, "exit 1\n")
		_, err := dl.PlaylistMetadata(context.Background(), "https://example.invalid/playlist")
		var exitError *exec.ExitError
		require.ErrorAs(t, err, &exitError)
		assert.Contains(t, err.Error(), "exit status 1")
	})
	t.Run("rate limit", func(t *testing.T) {
		dl := commandFixture(t, "printf 'HTTP Error 429: Too Many Requests\\n' >&2\nexit 1\n")
		_, err := dl.PlaylistMetadata(context.Background(), "https://example.invalid/playlist")
		assert.Same(t, ErrTooManyRequests, err)
	})
}
