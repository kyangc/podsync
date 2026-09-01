package remote

import (
	"context"

	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

type RemotePublishTaskWalker interface {
	WalkRemotePublishTasks(ctx context.Context, status model.RemotePublishStatus, cb func(*model.RemotePublishTask) error) error
}

type HardlinkBackfill struct {
	Tasks     RemotePublishTaskWalker
	Publisher *HardlinkPublisher
	DryRun    bool
}

type HardlinkBackfillResult struct {
	Scanned       int
	AlreadyLinked int
	WouldLink     int
	Linked        int
	Failed        int
}

func (b *HardlinkBackfill) Run(ctx context.Context) (HardlinkBackfillResult, error) {
	result := HardlinkBackfillResult{}
	if b.Tasks == nil || b.Publisher == nil {
		return result, errors.New("hardlink backfill tasks and publisher are required")
	}
	err := b.Tasks.WalkRemotePublishTasks(ctx, model.RemotePublishSucceeded, func(task *model.RemotePublishTask) error {
		result.Scanned++
		linked, err := b.Publisher.Published(task)
		if err != nil {
			result.Failed++
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
			result.Failed++
			return nil
		}
		result.Linked++
		return nil
	})
	if err != nil {
		return result, err
	}
	if result.Failed > 0 {
		return result, errors.Errorf("hardlink backfill incomplete: %d task(s) failed", result.Failed)
	}
	return result, nil
}
