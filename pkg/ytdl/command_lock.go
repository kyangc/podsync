package ytdl

import (
	"context"
	"sync"

	"golang.org/x/sync/semaphore"
)

// A zero-value commandLock preserves serialization while allowing canceled
// callers to leave the queue without starting a command.
type commandLock struct {
	once sync.Once
	gate *semaphore.Weighted
}

func (l *commandLock) Lock(ctx context.Context) error {
	l.once.Do(func() { l.gate = semaphore.NewWeighted(1) })
	return l.gate.Acquire(ctx, 1)
}

func (l *commandLock) Unlock() { l.gate.Release(1) }
