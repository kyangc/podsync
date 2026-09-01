package remote

import (
	"context"
	"os"

	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

type RemotePublishTaskWalker interface {
	WalkRemotePublishTasks(ctx context.Context, status model.RemotePublishStatus, cb func(*model.RemotePublishTask) error) error
}

type HardlinkBackfill struct {
	Tasks       RemotePublishTaskWalker
	Publisher   *HardlinkPublisher
	AllowedKeys map[string]struct{}
	DryRun      bool
}

type HardlinkBackfillResult struct {
	Scanned           int
	Selected          int
	Skipped           int
	AlreadyLinked     int
	WouldLink         int
	Linked            int
	Failed            int
	MissingTasks      int
	MissingSource     int
	SizeMismatch      int
	UnsafePath        int
	ConflictingTarget int
	OtherFailure      int
}

func (r *HardlinkBackfillResult) recordFailure(err error) {
	r.Failed++
	switch {
	case errors.Is(err, os.ErrNotExist):
		r.MissingSource++
	case errors.Is(err, ErrHardlinkSourceSizeMismatch):
		r.SizeMismatch++
	case errors.Is(err, ErrUnsafeMediaPath):
		r.UnsafePath++
	case errors.Is(err, ErrHardlinkTargetConflict):
		r.ConflictingTarget++
	default:
		r.OtherFailure++
	}
}

func (b *HardlinkBackfill) Run(ctx context.Context) (HardlinkBackfillResult, error) {
	result := HardlinkBackfillResult{}
	if b.Tasks == nil || b.Publisher == nil {
		return result, errors.New("hardlink backfill tasks and publisher are required")
	}
	if b.AllowedKeys == nil {
		return result, errors.New("hardlink backfill allowed keys are required")
	}
	seenAllowedKeys := make(map[string]struct{}, len(b.AllowedKeys))
	err := b.Tasks.WalkRemotePublishTasks(ctx, model.RemotePublishSucceeded, func(task *model.RemotePublishTask) error {
		result.Scanned++
		if task == nil {
			result.Skipped++
			return nil
		}
		if _, allowed := b.AllowedKeys[task.R2Key]; !allowed {
			result.Skipped++
			return nil
		}
		result.Selected++
		seenAllowedKeys[task.R2Key] = struct{}{}
		linked, err := b.Publisher.Published(task)
		if err != nil {
			result.recordFailure(err)
			return nil
		}
		if linked {
			result.AlreadyLinked++
			return nil
		}
		if b.DryRun {
			result.WouldLink++
			return nil
		}
		if err := b.Publisher.Upload(ctx, task, nil); err != nil {
			result.recordFailure(err)
			return nil
		}
		result.Linked++
		return nil
	})
	if err != nil {
		return result, err
	}
	result.MissingTasks = len(b.AllowedKeys) - len(seenAllowedKeys)
	if result.Failed > 0 || result.MissingTasks > 0 {
		return result, errors.Errorf(
			"hardlink backfill incomplete: %d selected task(s) failed and %d allowed key(s) had no succeeded task",
			result.Failed,
			result.MissingTasks,
		)
	}
	return result, nil
}
