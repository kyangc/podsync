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
			existing.MediaPath = task.MediaPath
			existing.Size = task.Size
			existing.Title = task.Title
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
		return b.getObj(txn, b.getKey(remotePublishTaskPath, id), &task)
	})
	return &task, err
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
