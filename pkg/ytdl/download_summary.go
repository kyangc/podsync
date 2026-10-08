package ytdl

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	log "github.com/sirupsen/logrus"
)

const downloadMetadataPrefix = "__PODSYNC_DOWNLOAD_META__"

// Both print stages run after extraction, so they do not imply simulation.
// Missing extractor fields must be JSON null, rather than yt-dlp's bare NA.
const downloadMetadataFields = `"format_id":%(format_id|null)j,"acodec":%(acodec|null)j,"protocol":%(protocol|null)j}`
const downloadMetadataTemplate = downloadMetadataPrefix + `{"stage":"media",` + downloadMetadataFields
const downloadCompletionTemplate = downloadMetadataPrefix + `{"stage":"complete",` + downloadMetadataFields

var summaryFieldPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+,-]{0,63}$`)

// DownloadSummary contains only selected, bounded diagnostic fields. Stage is
// the last observed milestone, not a claim about the underlying failure cause.
type DownloadSummary struct {
	FormatID               string
	AudioCodec             string
	Protocol               string
	ConfiguredPlayerClient string
	Stage                  string
	Elapsed                time.Duration
	QueueWait              time.Duration
	OutputBytes            int64
	OutputTruncated        bool
}

type SummaryProvider interface {
	DownloadSummary() DownloadSummary
}

func (s DownloadSummary) LogFields() log.Fields {
	fields := log.Fields{"last_stage": "unknown", "attempt_elapsed_ms": s.Elapsed.Milliseconds(),
		"queue_wait_ms": s.QueueWait.Milliseconds(), "output_bytes": s.OutputBytes, "output_truncated": s.OutputTruncated}
	switch s.Stage {
	case "queued", "extract", "media", "postprocess", "complete", "open_output":
		fields["last_stage"] = s.Stage
	}
	metadataAvailable := false
	for key, value := range map[string]string{
		"format_id": s.FormatID, "audio_codec": s.AudioCodec, "protocol": s.Protocol,
	} {
		if summaryFieldPattern.MatchString(value) {
			fields[key] = value
			metadataAvailable = true
		}
	}
	fields["metadata_available"] = metadataAvailable
	if summaryFieldPattern.MatchString(s.ConfiguredPlayerClient) {
		fields["configured_player_client"] = s.ConfiguredPlayerClient
	}
	return fields
}

type downloadError struct {
	message     string
	summary     DownloadSummary
	cause       error
	retryReason string
}

// RetryReasonProvider keeps classification independent of retained error text.
// An empty reason is authoritative; it must not fall back to truncated text.
type RetryReasonProvider interface {
	DownloadRetryReason() string
}

func (e *downloadError) Error() string                    { return e.message }
func (e *downloadError) Unwrap() error                    { return e.cause }
func (e *downloadError) DownloadSummary() DownloadSummary { return e.summary }
func (e *downloadError) DownloadRetryReason() string      { return e.retryReason }

func commandErrorDetail(output string, err error) string {
	if strings.TrimSpace(output) == "" {
		return err.Error()
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return strings.TrimRight(output, "\r\n") + "\nERROR: " + err.Error()
	}
	return output
}

func (dl *YoutubeDl) detectSummarySupport(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	help, err := dl.exec(ctx, "--help")
	dl.summarySupported = err == nil && strings.Contains(help, "--print [WHEN:]TEMPLATE")
}

func configuredPlayerClient(args []string) string {
	client := ""
	for i, arg := range args {
		value := ""
		if arg == "--extractor-args" && i+1 < len(args) {
			value = args[i+1]
		} else if strings.HasPrefix(arg, "--extractor-args=") {
			value = strings.TrimPrefix(arg, "--extractor-args=")
		}
		extractor, options, found := strings.Cut(value, ":")
		if !found || !strings.EqualFold(extractor, "youtube") {
			continue
		}
		for _, option := range strings.Split(options, ";") {
			key, value, found := strings.Cut(option, "=")
			if found && key == "player_client" {
				client = value
			}
		}
	}
	return client
}

func parseDownloadOutput(output string) (string, DownloadSummary) {
	outputCapture := newDownloadOutput()
	_, _ = outputCapture.Write([]byte(output))
	return outputCapture.result()
}

func (s *DownloadSummary) observeMetadata(line string) {
	var metadata struct {
		Stage      string `json:"stage"`
		FormatID   string `json:"format_id"`
		AudioCodec string `json:"acodec"`
		Protocol   string `json:"protocol"`
	}
	payload := strings.TrimPrefix(strings.TrimSpace(line), downloadMetadataPrefix)
	if len(payload) > 1024 || json.Unmarshal([]byte(payload), &metadata) != nil {
		return
	}
	s.FormatID, s.AudioCodec, s.Protocol = metadata.FormatID, metadata.AudioCodec, metadata.Protocol
	if metadata.Stage == "media" || metadata.Stage == "complete" {
		s.Stage = metadata.Stage
	}
}

func (s *DownloadSummary) observeDiagnostic(line string) {
	switch {
	case strings.Contains(line, "[ExtractAudio]") || strings.Contains(line, "[Merger]"):
		s.Stage = "postprocess"
	case strings.Contains(line, "[download]"):
		s.Stage = "media"
	case s.Stage == "" && strings.Contains(line, "[youtube]"):
		s.Stage = "extract"
	}
}

// YouTubeDownloadRetryReason classifies diagnostic output. Provider selection
// and context termination take precedence at the manager's call site.
func YouTubeDownloadRetryReason(message string) string {
	message = strings.ToLower(message)
	switch {
	case strings.Contains(message, "http error 403"):
		return "http_403"
	case strings.Contains(message, "unexpected_eof") || strings.Contains(message, "unexpected eof") ||
		strings.Contains(message, "handshake operation timed out"):
		return "tls_transport"
	case strings.Contains(message, "[download] got error: the read operation timed out. giving up after "):
		return "read_timeout"
	}
	return ""
}
