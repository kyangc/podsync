// Package httpretry retries transient failures of small, idempotent HTTP operations.
package httpretry

import (
	"context"
	"errors"
	"io"
	"net"
	"syscall"
	"time"
)

const (
	requestTimeout = 30 * time.Second
	retryDelay     = 250 * time.Millisecond
)

// Do makes at most two attempts within one shared timeout. The operation must
// be idempotent and recreate its request and response state on each attempt,
// including reading and closing the response body before returning.
// HTTP status, validation, and certificate errors are left to the caller.
func Do[T any](ctx context.Context, operation func(context.Context) (T, error)) (T, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			var zero T
			return zero, err
		}
		result, err := operation(ctx)
		if err == nil || attempt == 1 || ctx.Err() != nil || !isTransient(err) {
			return result, err
		}
		timer := time.NewTimer(retryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			var zero T
			return zero, ctx.Err()
		case <-timer.C:
		}
	}
}

func isTransient(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) || errors.Is(err, syscall.EPIPE) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
}
