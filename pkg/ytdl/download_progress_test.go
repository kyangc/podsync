package ytdl

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDownloadProgressCannotDisplaceDiagnostics(t *testing.T) {
	noise := strings.Repeat("[download] 53.4% progress\r", 10000)
	warning := "WARNING: The handshake operation timed out"
	raw := "diagnostic beginning\n" + noise + warning + "\n" + noise + "ERROR: Requested format is not available\n"
	capture := newDownloadOutput()
	_, err := capture.Write([]byte(raw))
	require.NoError(t, err)
	output, summary := capture.result()
	assert.Equal(t, "diagnostic beginning\n"+warning+"\nERROR: Requested format is not available\n", output)
	assert.Equal(t, int64(len(raw)), summary.OutputBytes)
	assert.False(t, summary.OutputTruncated)
	assert.Equal(t, "media", summary.Stage)
	assert.Equal(t, "tls_transport", capture.retryReason)
}

func TestDownloadProgressFilteringHandlesChunksAndDelimiters(t *testing.T) {
	for _, chunkSize := range []int{1, 7, 31, 4096} {
		t.Run(fmt.Sprint(chunkSize), func(t *testing.T) {
			raw := "[youtube] extracting\r\n" +
				"  [download] 0.0% progress\r\n[download]\t10% progress\r[download] 99.5% progress\n" +
				"[download] Got error: The read operation timed out. Giving up after 1 retries\r\n" +
				"[download] 100% complete"
			capture := newDownloadOutput()
			for start := 0; start < len(raw); start += chunkSize {
				_, err := capture.Write([]byte(raw[start:min(len(raw), start+chunkSize)]))
				require.NoError(t, err)
			}
			output, summary := capture.result()
			assert.Equal(t, "[youtube] extracting\r\n[download] Got error: The read operation timed out. Giving up after 1 retries\r\n", output)
			assert.Equal(t, int64(len(raw)), summary.OutputBytes)
			assert.Equal(t, "read_timeout", capture.retryReason)
		})
	}
}

func TestDownloadProgressFilteringKeepsOtherDownloadLines(t *testing.T) {
	for _, line := range []string{"[download] Destination: media", "[download] Got error: HTTP Error 403", "[download] 12.", "[download] 5.% invalid", "[download]12% no space", "[download] unknown progress"} {
		capture := newDownloadOutput()
		for i := range len(line) {
			_, _ = capture.Write([]byte(line[i : i+1]))
		}
		output, _ := capture.result()
		assert.Equal(t, line, output)
	}
}
