package remote

import (
	"regexp"
	"strings"
)

var sensitiveTextPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+`),
	regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`(?i)((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+`),
	regexp.MustCompile(`(?i)([?&](?:access_token|token|api_key|key|secret|session|sessdata|bili_jct|buvid3|dedeuserid|sid|asset_token)=)[^&\s]+`),
	regexp.MustCompile(`(?i)((?:access_token|token|api[_-]?key|key|secret|session|sessdata|bili_jct|buvid3|dedeuserid|sid|asset_token)\s*[:=]\s*)[^\s,;&]+`),
}

var quotedSensitiveFieldPattern = regexp.MustCompile(`(?i)("(?:access_token|token|api[_-]?key|key|secret|session|sessdata|bili_jct|buvid3|dedeuserid|sid|asset_token)"\s*:\s*")[^"]+(")`)

func scrubSensitiveText(value string, redactions []string) string {
	for _, secret := range redactions {
		secret = strings.TrimSpace(secret)
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	for _, pattern := range sensitiveTextPatterns {
		value = pattern.ReplaceAllString(value, `${1}[redacted]`)
	}
	return quotedSensitiveFieldPattern.ReplaceAllString(value, `${1}[redacted]${2}`)
}
