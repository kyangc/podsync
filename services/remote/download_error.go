package remote

import (
	"regexp"
	"strings"
)

var downloadProgressLine = regexp.MustCompile(`^\[download\]\s+\d+(?:\.\d+)?%`)

// Keep the diagnostic beginning and terminal error after redacting the full text.
// Progress updates are not useful in a bounded remote error record.
func summarizeDownloadError(value string, redactions []string) string {
	value = scrubSensitiveText(value, redactions)
	lines := strings.FieldsFunc(value, func(r rune) bool { return r == '\r' || r == '\n' })
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" && !downloadProgressLine.MatchString(line) {
			kept = append(kept, line)
		}
	}
	value = strings.Join(kept, "\n")
	runes := []rune(value)
	if len(runes) <= maxRemoteEventDetail {
		return value
	}
	const omitted = "\n[... omitted ...]\n"
	budget := maxRemoteEventDetail - len([]rune(omitted))
	head := budget / 3
	return string(runes[:head]) + omitted + string(runes[len(runes)-(budget-head):])
}
