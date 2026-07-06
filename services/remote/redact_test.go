package remote

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestScrubSensitiveTextRedactsConfiguredSecrets(t *testing.T) {
	got := scrubSensitiveText("bad secret-token and access-key", []string{"secret-token", "access-key"})

	assert.Equal(t, "bad [redacted] and [redacted]", got)
}

func TestScrubSensitiveTextRedactsAuthorizationAndCookieHeaders(t *testing.T) {
	tests := map[string]string{
		"Authorization: Bearer secret-token":     "Authorization: Bearer [redacted]",
		"bearer plain-token":                     "bearer [redacted]",
		"Cookie: SESSDATA=abc; bili_jct=def":     "Cookie: [redacted]",
		"Set-Cookie: SESSDATA=abc; Path=/; Http": "Set-Cookie: [redacted]",
	}

	for input, want := range tests {
		t.Run(input, func(t *testing.T) {
			assert.Equal(t, want, scrubSensitiveText(input, nil))
		})
	}
}

func TestScrubSensitiveTextRedactsSensitiveQueryAndFieldShapes(t *testing.T) {
	tests := map[string]string{
		"https://example.com/path?token=secret&safe=1": `https://example.com/path?token=[redacted]&safe=1`,
		"api_key=secret":        "api_key=[redacted]",
		"secret: value":         "secret: [redacted]",
		"session=value":         "session=[redacted]",
		"asset_token=value":     "asset_token=[redacted]",
		`{"token":"secret"}`:    `{"token":"[redacted]"}`,
		`{"api_key": "secret"}`: `{"api_key": "[redacted]"}`,
		`{"SESSDATA":"abc"}`:    `{"SESSDATA":"[redacted]"}`,
		`{"asset_token":"abc"}`: `{"asset_token":"[redacted]"}`,
	}

	for input, want := range tests {
		t.Run(input, func(t *testing.T) {
			assert.Equal(t, want, scrubSensitiveText(input, nil))
		})
	}
}
