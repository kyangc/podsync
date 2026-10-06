package httpretry

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDoRetriesOnlyTransientErrors(t *testing.T) {
	tests := []struct {
		name  string
		err   error
		retry bool
	}{
		{"EOF", io.EOF, true},
		{"truncated body", fmt.Errorf("read body: %w", io.ErrUnexpectedEOF), true},
		{"connection reset", &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}, true},
		{"connection aborted", syscall.ECONNABORTED, true},
		{"broken pipe", syscall.EPIPE, true},
		{"TLS handshake timeout", &url.Error{Op: "Get", URL: "https://example.com", Err: timeoutError{}}, true},
		{"unknown certificate", x509.UnknownAuthorityError{}, false},
		{"DNS name not found", &net.DNSError{IsNotFound: true}, false},
		{"validation", errors.New("response cursor mismatch"), false},
		{"HTTP quota", errors.New("HTTP 429"), false},
		{"canceled", context.Canceled, false},
		{"deadline", context.DeadlineExceeded, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			result, err := Do(context.Background(), func(context.Context) (string, error) {
				calls++
				if calls == 1 {
					return "", tt.err
				}
				return "success", nil
			})
			if tt.retry {
				require.NoError(t, err)
				assert.Equal(t, "success", result)
				assert.Equal(t, 2, calls)
			} else {
				assert.ErrorIs(t, err, tt.err)
				assert.Equal(t, 1, calls)
			}
		})
	}
}

func TestDoRetainsFinalErrorWhenRetriesAreExhausted(t *testing.T) {
	calls := 0
	lastError := fmt.Errorf("second connection: %w", io.EOF)
	_, err := Do(context.Background(), func(context.Context) (string, error) {
		calls++
		if calls == 1 {
			return "", io.EOF
		}
		return "", lastError
	})
	assert.Equal(t, 2, calls)
	assert.ErrorIs(t, err, lastError)
}

func TestDoSharesOneDeadlineAcrossAttempts(t *testing.T) {
	started := time.Now()
	var deadlines []time.Time
	_, err := Do(context.Background(), func(ctx context.Context) (string, error) {
		deadline, ok := ctx.Deadline()
		require.True(t, ok)
		deadlines = append(deadlines, deadline)
		if len(deadlines) == 1 {
			return "", io.EOF
		}
		return "success", nil
	})
	require.NoError(t, err)
	require.Len(t, deadlines, 2)
	assert.Equal(t, deadlines[0], deadlines[1])
	assert.WithinDuration(t, started.Add(30*time.Second), deadlines[0], time.Second)
}

func TestDoHonorsCancellationDuringBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	_, err := Do(ctx, func(context.Context) (string, error) {
		calls++
		go cancel()
		return "", io.EOF
	})
	assert.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, 1, calls)
}

func TestDoHonorsShorterCallerDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	calls := 0
	_, err := Do(ctx, func(ctx context.Context) (string, error) {
		calls++
		<-ctx.Done()
		return "", ctx.Err()
	})
	assert.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Equal(t, 1, calls)
}

func TestDoDoesNotStartCanceledRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Do(ctx, func(context.Context) (string, error) {
		t.Fatal("request started after cancellation")
		return "", nil
	})
	assert.ErrorIs(t, err, context.Canceled)
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "net/http: TLS handshake timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
