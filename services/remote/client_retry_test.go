package remote

import (
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNASClientRetriesInterruptedTLSHandshake(t *testing.T) {
	var handshakes atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
		assert.Equal(t, "12", r.URL.Query().Get("cursor"))
		_, _ = w.Write([]byte(`{"cursor":12,"next_cursor":12,"has_more":false,"changes":[]}`))
	}))
	server.TLS = &tls.Config{GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		if handshakes.Add(1) == 1 {
			_ = hello.Conn.Close()
			return nil, io.EOF
		}
		return nil, nil
	}}
	server.StartTLS()
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	batch, err := client.FetchTombstones(context.Background(), 12, 100)

	require.NoError(t, err)
	assert.Equal(t, int64(12), batch.NextCursor)
	assert.EqualValues(t, 2, handshakes.Load())
}

func TestNASClientRetriesEventBatchWithSamePayloadAfterLostResponse(t *testing.T) {
	var mu sync.Mutex
	var payloads [][]byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
		body, err := io.ReadAll(r.Body)
		assert.NoError(t, err)
		mu.Lock()
		payloads = append(payloads, body)
		first := len(payloads) == 1
		mu.Unlock()
		if first {
			// The Worker may accept a batch before its response is lost. Replay must
			// preserve the run ID and event sequences used for deduplication.
			conn, _, err := w.(http.Hijacker).Hijack()
			assert.NoError(t, err)
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		_, _ = w.Write([]byte(`{"run_id":"run-1","accepted_events":1,"inserted_events":0,"duplicate_events":1}`))
	}))
	defer server.Close()
	client, err := NewNASClient(server.URL, "secret", server.Client())
	require.NoError(t, err)

	result, err := client.PostEventBatch(context.Background(), newEventBatch())

	require.NoError(t, err)
	assert.Equal(t, 1, result.DuplicateEvents)
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, payloads, 2)
	assert.Equal(t, payloads[0], payloads[1])
}

func TestNASClientDoesNotRetryHTTPOrProtocolErrors(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusOK} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			client, err := NewNASClient("https://example.com", "secret", retryTestHTTPClient(func(*http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"cursor":99}`))}, nil
			}))
			require.NoError(t, err)

			_, err = client.FetchTombstones(context.Background(), 12, 100)

			require.Error(t, err)
			assert.Equal(t, 1, calls)
		})
	}
}

type retryTestHTTPClient func(*http.Request) (*http.Response, error)

func (f retryTestHTTPClient) Do(req *http.Request) (*http.Response, error) { return f(req) }
