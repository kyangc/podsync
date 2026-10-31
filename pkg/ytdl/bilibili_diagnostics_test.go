package ytdl

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBilibiliNoDataEvidenceSurvivesChunkingAndTruncation(t *testing.T) {
	output := newDownloadOutput()
	output.Write([]byte("[BiliBili] Extracting URL: https://PRIVATE\n"))
	output.Write([]byte("[download] Destination: PRIVATE\n"))
	output.Write([]byte(strings.Repeat("PRIVATE diagnostic\n", 20000)))
	output.Write([]byte("ERROR: Did not get any "))
	output.Write([]byte("data blocks\n"))
	_, summary := output.result()
	require.True(t, summary.NoDataBlocks)
	require.True(t, summary.OutputTruncated)
	require.Equal(t, "media", summary.Stage)
	require.GreaterOrEqual(t, summary.ExtractOffsetMS, int64(0))
	require.GreaterOrEqual(t, summary.MediaOffsetMS, summary.ExtractOffsetMS)
	require.Equal(t, "", output.retryReason, "diagnostic signal must not expand retry classification")
}
