package ytdl

import (
	"bytes"
	"strings"
)

const (
	maxDownloadOutputBytes = 128 * 1024
	maxDownloadLineBytes   = 8 * 1024
	outputOmission         = "\n[... download output omitted ...]\n"
	outputHeadBytes        = (maxDownloadOutputBytes - len(outputOmission)) / 4
	outputTailBytes        = maxDownloadOutputBytes - len(outputOmission) - outputHeadBytes
)

// Output is continuously drained even after the diagnostic buffer is full.
// Metadata and retry signals are extracted independently of retained text.
type downloadOutput struct {
	diagnostic  boundedDiagnostic
	summary     DownloadSummary
	line        []byte
	lineBytes   int
	decided     bool
	metadata    bool
	progress    bool
	skipLF      bool
	scanTail    string
	retryReason string
	rateLimited bool
	rawBytes    int64
}

func newDownloadOutput() *downloadOutput {
	return &downloadOutput{line: make([]byte, 0, maxDownloadLineBytes)}
}

func (o *downloadOutput) Write(p []byte) (int, error) {
	n := len(p)
	o.rawBytes += int64(n)
	for len(p) > 0 {
		end := bytes.IndexAny(p, "\r\n")
		if end < 0 {
			o.consume(p)
			break
		}
		if o.skipLF && end == 0 && p[0] == '\n' {
			o.skipLF = false
		} else {
			o.consume(p[:end])
			o.finishLine(p[end])
		}
		p = p[end+1:]
	}
	return n, nil
}

func (o *downloadOutput) consume(p []byte) {
	if len(p) != 0 {
		o.skipLF = false
	}
	for len(p) > 0 {
		fragment := p[:min(len(p), 4096)]
		p = p[len(fragment):]
		o.lineBytes += len(fragment)
		take := min(len(fragment), maxDownloadLineBytes-len(o.line))
		o.line = append(o.line, fragment[:take]...)
		if o.decided {
			if !o.metadata {
				o.observeDiagnostic(fragment)
			}
			continue
		}
		trimmed := bytes.TrimLeft(o.line, " \t")
		prefix := []byte(downloadMetadataPrefix)
		progress, pendingProgress := downloadProgressPrefix(trimmed)
		pendingMetadata := len(trimmed) < len(prefix) && bytes.HasPrefix(prefix, trimmed)
		if (pendingMetadata || pendingProgress) && len(o.line) < maxDownloadLineBytes {
			continue
		}
		o.decided = true
		o.metadata = bytes.HasPrefix(trimmed, prefix)
		o.progress = progress
		if !o.metadata {
			o.observeDiagnostic(o.line)
			if take < len(fragment) {
				o.observeDiagnostic(fragment[take:])
			}
		}
	}
}

func (o *downloadOutput) observeDiagnostic(p []byte) {
	if !o.progress {
		o.diagnostic.write(p)
	}
	window := o.scanTail + string(p)
	o.summary.observeDiagnostic(window)
	if strings.Contains(window, "HTTP Error 429") {
		o.rateLimited = true
	}
	reason := YouTubeDownloadRetryReason(window)
	if retryPriority(reason) > retryPriority(o.retryReason) {
		o.retryReason = reason
	}
	// The longest retry pattern is shorter than 128 bytes; retain only overlap.
	o.scanTail = window[max(0, len(window)-128):]
}

func retryPriority(reason string) int {
	switch reason {
	case "http_403":
		return 3
	case "tls_transport":
		return 2
	case "read_timeout":
		return 1
	}
	return 0
}

func (o *downloadOutput) finishLine(delimiter byte) {
	if !o.decided {
		o.metadata = strings.HasPrefix(strings.TrimSpace(string(o.line)), downloadMetadataPrefix)
		o.progress, _ = downloadProgressPrefix(bytes.TrimLeft(o.line, " \t"))
		if !o.metadata {
			o.observeDiagnostic(o.line)
		}
	}
	if o.metadata {
		if o.lineBytes <= maxDownloadLineBytes {
			o.summary.observeMetadata(string(o.line))
		}
	} else if !o.progress && delimiter != 0 {
		o.diagnostic.write([]byte{delimiter})
	}
	o.skipLF = (o.metadata || o.progress) && delimiter == '\r'
	o.line = o.line[:0]
	o.lineBytes, o.decided, o.metadata, o.progress, o.scanTail = 0, false, false, false, ""
}

// Delay classification while a chunk can still become a percentage progress
// prefix. Error and destination lines beginning with [download] stay intact.
func downloadProgressPrefix(p []byte) (matched, pending bool) {
	prefix := []byte("[download]")
	if len(p) < len(prefix) {
		return false, bytes.HasPrefix(prefix, p)
	}
	if !bytes.HasPrefix(p, prefix) {
		return false, false
	}
	p = p[len(prefix):]
	if len(p) == 0 {
		return false, true
	}
	if p[0] != ' ' && p[0] != '\t' && p[0] != '\f' {
		return false, false
	}
	for len(p) > 0 && (p[0] == ' ' || p[0] == '\t' || p[0] == '\f') {
		p = p[1:]
	}
	if len(p) == 0 {
		return false, true
	}
	for part := 0; part < 2; part++ {
		digits := 0
		for len(p) > 0 && p[0] >= '0' && p[0] <= '9' {
			digits++
			p = p[1:]
		}
		if len(p) == 0 {
			return false, true
		}
		if digits == 0 {
			return false, false
		}
		if part == 0 && p[0] == '.' {
			p = p[1:]
			continue
		}
		return p[0] == '%', false
	}
	return false, false
}

func (o *downloadOutput) result() (string, DownloadSummary) {
	if o.lineBytes > 0 {
		o.finishLine(0)
	}
	o.summary.OutputBytes = o.rawBytes
	o.summary.OutputTruncated = o.diagnostic.truncated()
	return o.diagnostic.text(), o.summary
}

type boundedDiagnostic struct {
	head, tail []byte
	position   int
	total      int64
}

func (b *boundedDiagnostic) write(p []byte) {
	b.total += int64(len(p))
	if b.head == nil && len(p) > 0 {
		b.head = make([]byte, 0, outputHeadBytes)
	}
	take := min(len(p), outputHeadBytes-len(b.head))
	b.head = append(b.head, p[:take]...)
	p = p[take:]
	if b.tail == nil && len(p) > 0 {
		b.tail = make([]byte, 0, outputTailBytes)
	}
	if len(p) >= outputTailBytes {
		b.tail = append(b.tail[:0], p[len(p)-outputTailBytes:]...)
		b.position = 0
		return
	}
	take = min(len(p), outputTailBytes-len(b.tail))
	b.tail = append(b.tail, p[:take]...)
	p = p[take:]
	if len(p) > 0 {
		copied := copy(b.tail[b.position:], p)
		copy(b.tail, p[copied:])
		b.position = (b.position + len(p)) % outputTailBytes
	}
}

func (b *boundedDiagnostic) truncated() bool {
	return b.total > int64(outputHeadBytes+outputTailBytes)
}

func (b *boundedDiagnostic) text() string {
	head := string(b.head)
	tail := string(b.tail[b.position:]) + string(b.tail[:b.position])
	if !b.truncated() {
		return head + tail
	}
	// Keep complete lines so truncation cannot expose a secret fragment whose
	// authorization/cookie prefix or configured redaction was removed.
	head = head[:strings.LastIndexAny(head, "\r\n")+1]
	if end := strings.IndexAny(tail, "\r\n"); end >= 0 {
		tail = tail[end+1:]
	} else {
		tail = ""
	}
	return head + outputOmission + tail
}
