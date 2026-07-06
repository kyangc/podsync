package remote

import (
	"context"
	"errors"
	"io"
	"os"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/model"
)

type Outbox interface {
	DueRemotePublishTasks(ctx context.Context, now time.Time, limit int) ([]*model.RemotePublishTask, error)
	PrepareRemotePublishAttempt(ctx context.Context, id string, r2Key string, assetToken string, mimeType string, now time.Time) (*model.RemotePublishTask, error)
	CompleteRemotePublishTask(ctx context.Context, id string, serverStatus string, now time.Time) error
	RetryRemotePublishTask(ctx context.Context, id string, cause error, now time.Time) error
	DeferRemotePublishTask(ctx context.Context, id string, cause error, now time.Time) error
	FailRemotePublishTask(ctx context.Context, id string, cause error, now time.Time) error
}

type Publisher interface {
	Upload(ctx context.Context, task *model.RemotePublishTask, reader io.ReadSeeker) error
}

type MediaStore interface {
	Open(name string) (ReadSeekCloser, error)
}

type Processor struct {
	Outbox    Outbox
	Publisher Publisher
	Upserter  EpisodeUpserter
	Store     MediaStore
	Prefix    string
	Limit     int
	Now       func() time.Time
}

func (p *Processor) ProcessDue(ctx context.Context) error {
	now := p.now()
	limit := p.Limit
	if limit <= 0 {
		limit = 1
	}
	tasks, err := p.Outbox.DueRemotePublishTasks(ctx, now, limit)
	if err != nil {
		return err
	}
	for _, task := range tasks {
		if err := p.processOne(ctx, task, now); err != nil {
			log.WithError(err).WithField("task_id", task.ID).Warn("remote publish task failed")
		}
	}
	return nil
}

func (p *Processor) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now().UTC()
}

func (p *Processor) processOne(ctx context.Context, task *model.RemotePublishTask, now time.Time) error {
	reader, err := p.Store.Open(task.MediaPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrUnsafeMediaPath) {
			return p.Outbox.FailRemotePublishTask(ctx, task.ID, err, now)
		}
		return p.Outbox.DeferRemotePublishTask(ctx, task.ID, err, now)
	}
	defer reader.Close()

	assetToken := task.AssetToken
	if assetToken == "" {
		assetToken, err = NewAssetToken()
		if err != nil {
			return p.Outbox.DeferRemotePublishTask(ctx, task.ID, err, now)
		}
	}
	r2Key := task.R2Key
	if r2Key == "" {
		r2Key = BuildR2Key(p.Prefix, task, assetToken)
	}
	mimeType, err := DetectMimeType(reader)
	if err != nil {
		return p.Outbox.DeferRemotePublishTask(ctx, task.ID, err, now)
	}

	prepared, err := p.Outbox.PrepareRemotePublishAttempt(ctx, task.ID, r2Key, assetToken, mimeType, now)
	if err != nil {
		return err
	}
	if err := p.Publisher.Upload(ctx, prepared, reader); err != nil {
		if retryErr := p.Outbox.RetryRemotePublishTask(ctx, task.ID, err, now); retryErr != nil {
			return retryErr
		}
		return err
	}
	serverStatus := ""
	if p.Upserter != nil {
		result, err := p.Upserter.UpsertEpisode(ctx, prepared)
		if err != nil {
			if IsNonRetryable(err) {
				return p.Outbox.FailRemotePublishTask(ctx, task.ID, err, now)
			}
			if retryErr := p.Outbox.RetryRemotePublishTask(ctx, task.ID, err, now); retryErr != nil {
				return retryErr
			}
			return err
		}
		serverStatus = result.Status
	}
	return p.Outbox.CompleteRemotePublishTask(ctx, task.ID, serverStatus, now)
}
