package db

import (
	"context"
	"time"

	"github.com/dgraph-io/badger"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

func (b *Badger) EnqueueRemotePublishTask(_ context.Context, task *model.RemotePublishTask) error {
	if task.FeedID == "" {
		return errors.New("remote publish task feed_id is required")
	}
	if task.LocalEpisodeID == "" {
		return errors.New("remote publish task local_episode_id is required")
	}
	if task.MediaPath == "" {
		return errors.New("remote publish task media_path is required")
	}

	now := time.Now().UTC()
	newTask := *task
	newTask.ID = model.RemotePublishTaskID(task.FeedID, task.LocalEpisodeID)
	newTask.Status = model.RemotePublishPending
	newTask.Attempts = 0
	newTask.NextAttemptAt = now
	newTask.LastError = ""
	newTask.CreatedAt = now
	newTask.UpdatedAt = now

	key := b.getKey(remotePublishTaskPath, newTask.ID)
	return b.db.Update(func(txn *badger.Txn) error {
		var existing model.RemotePublishTask
		err := b.getObj(txn, key, &existing)
		switch err {
		case nil:
			existing.Provider = task.Provider
			existing.SourceEpisodeID = task.SourceEpisodeID
			existing.MediaPath = task.MediaPath
			existing.Size = task.Size
			existing.Title = task.Title
			existing.Description = task.Description
			existing.Thumbnail = task.Thumbnail
			existing.Duration = task.Duration
			existing.SourceURL = task.SourceURL
			existing.PublishedAt = task.PublishedAt
			existing.UpdatedAt = now
			return b.setObj(txn, key, &existing, true)
		case model.ErrNotFound:
			return b.setObj(txn, key, &newTask, false)
		default:
			return err
		}
	})
}

func (b *Badger) GetRemotePublishTask(_ context.Context, id string) (*model.RemotePublishTask, error) {
	var task model.RemotePublishTask
	err := b.db.View(func(txn *badger.Txn) error {
		return b.getRemotePublishTask(txn, id, &task)
	})
	return &task, err
}

func (b *Badger) DueRemotePublishTasks(_ context.Context, now time.Time, limit int) ([]*model.RemotePublishTask, error) {
	if limit <= 0 {
		limit = 1
	}

	tasks := make([]*model.RemotePublishTask, 0, limit)
	err := b.db.View(func(txn *badger.Txn) error {
		opts := badger.DefaultIteratorOptions
		opts.Prefix = b.getKey(remotePublishTaskPrefix)
		opts.PrefetchValues = true
		return b.iterator(txn, opts, func(item *badger.Item) error {
			if len(tasks) >= limit {
				return nil
			}
			task := &model.RemotePublishTask{}
			if err := b.unmarshalObj(item, task); err != nil {
				return err
			}
			if task.Status != model.RemotePublishPending {
				return nil
			}
			if !task.NextAttemptAt.IsZero() && task.NextAttemptAt.After(now) {
				return nil
			}
			tasks = append(tasks, task)
			return nil
		})
	})
	return tasks, err
}

func (b *Badger) PrepareRemotePublishAttempt(_ context.Context, id string, r2Key string, assetToken string, mimeType string, now time.Time) (*model.RemotePublishTask, error) {
	var task model.RemotePublishTask
	err := b.db.Update(func(txn *badger.Txn) error {
		if err := b.getRemotePublishTask(txn, id, &task); err != nil {
			return err
		}
		if task.Status != model.RemotePublishPending {
			return model.ErrNotFound
		}
		task.R2Key = r2Key
		task.AssetToken = assetToken
		task.MimeType = mimeType
		task.Attempts++
		task.LastError = ""
		task.UpdatedAt = now
		return b.setObj(txn, b.getKey(remotePublishTaskPath, id), &task, true)
	})
	return &task, err
}

func (b *Badger) CompleteRemotePublishTask(_ context.Context, id string, serverStatus string, now time.Time) error {
	return b.db.Update(func(txn *badger.Txn) error {
		var task model.RemotePublishTask
		if err := b.getRemotePublishTask(txn, id, &task); err != nil {
			return err
		}
		task.Status = model.RemotePublishSucceeded
		task.LastError = ""
		task.NextAttemptAt = time.Time{}
		if serverStatus != "" {
			task.ServerStatus = serverStatus
			task.UpsertedAt = now
		}
		task.CompletedAt = now
		task.UpdatedAt = now
		return b.setObj(txn, b.getKey(remotePublishTaskPath, id), &task, true)
	})
}

func (b *Badger) RetryRemotePublishTask(_ context.Context, id string, cause error, now time.Time) error {
	return b.db.Update(func(txn *badger.Txn) error {
		var task model.RemotePublishTask
		if err := b.getRemotePublishTask(txn, id, &task); err != nil {
			return err
		}
		task.Status = model.RemotePublishPending
		task.LastError = remotePublishErrorMessage(cause)
		task.NextAttemptAt = model.RemotePublishNextAttempt(now, task.Attempts)
		task.UpdatedAt = now
		return b.setObj(txn, b.getKey(remotePublishTaskPath, id), &task, true)
	})
}

func (b *Badger) DeferRemotePublishTask(_ context.Context, id string, cause error, now time.Time) error {
	return b.db.Update(func(txn *badger.Txn) error {
		var task model.RemotePublishTask
		if err := b.getRemotePublishTask(txn, id, &task); err != nil {
			return err
		}
		if task.Status != model.RemotePublishPending {
			return model.ErrNotFound
		}
		task.Attempts++
		task.LastError = remotePublishErrorMessage(cause)
		task.NextAttemptAt = model.RemotePublishNextAttempt(now, task.Attempts)
		task.UpdatedAt = now
		return b.setObj(txn, b.getKey(remotePublishTaskPath, id), &task, true)
	})
}

func (b *Badger) FailRemotePublishTask(_ context.Context, id string, cause error, now time.Time) error {
	return b.db.Update(func(txn *badger.Txn) error {
		var task model.RemotePublishTask
		if err := b.getRemotePublishTask(txn, id, &task); err != nil {
			return err
		}
		task.Status = model.RemotePublishFailed
		task.LastError = remotePublishErrorMessage(cause)
		task.NextAttemptAt = time.Time{}
		task.UpdatedAt = now
		return b.setObj(txn, b.getKey(remotePublishTaskPath, id), &task, true)
	})
}

func (b *Badger) WalkRemotePublishTasks(_ context.Context, status model.RemotePublishStatus, cb func(*model.RemotePublishTask) error) error {
	return b.db.View(func(txn *badger.Txn) error {
		opts := badger.DefaultIteratorOptions
		opts.Prefix = b.getKey(remotePublishTaskPrefix)
		opts.PrefetchValues = true
		return b.iterator(txn, opts, func(item *badger.Item) error {
			task := &model.RemotePublishTask{}
			if err := b.unmarshalObj(item, task); err != nil {
				return err
			}
			if status != "" && task.Status != status {
				return nil
			}
			return cb(task)
		})
	})
}

func (b *Badger) getRemotePublishTask(txn *badger.Txn, id string, task *model.RemotePublishTask) error {
	return b.getObj(txn, b.getKey(remotePublishTaskPath, id), task)
}

func remotePublishErrorMessage(cause error) string {
	if cause == nil {
		return ""
	}
	return cause.Error()
}
