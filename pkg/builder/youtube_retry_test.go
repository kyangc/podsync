package builder

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/option"
	"google.golang.org/api/youtube/v3"

	"github.com/mxpv/podsync/pkg/model"
)

type youtubeRetryTransport func(*http.Request) (*http.Response, error)

func (f youtubeRetryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestYouTubeDiscoveryRetriesTransientConnectionFailure(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: youtubeRetryTransport(func(req *http.Request) (*http.Response, error) {
		calls++
		assert.Equal(t, "channel", req.URL.Query().Get("id"))
		assert.Equal(t, "test-api-key", req.URL.Query().Get("key"))
		if calls == 1 {
			return nil, io.EOF
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"items":[{"id":"channel"}]}`))}, nil
	})}
	service, err := youtube.NewService(context.Background(), option.WithHTTPClient(client))
	require.NoError(t, err)
	builder := &YouTubeBuilder{client: service, key: apiKey("test-api-key")}

	channel, err := builder.listChannels(context.Background(), model.TypeChannel, "channel", "id")

	require.NoError(t, err)
	assert.Equal(t, "channel", channel.Id)
	assert.Equal(t, 2, calls)
}
