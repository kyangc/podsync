package db

import (
	"context"
	"strings"
	"time"

	"github.com/dgraph-io/badger"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

type remoteTombstoneCursor struct {
	Value     int64     `json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
}

type remoteTombstoneMarker struct {
	FeedID         string                      `json:"feed_id"`
	LocalEpisodeID string                      `json:"local_episode_id"`
	Status         model.RemoteEpisodeStatus   `json:"status"`
	Action         model.RemoteTombstoneAction `json:"action"`
	Sequence       int64                       `json:"sequence"`
	CreatedAt      string                      `json:"created_at"`
	AppliedAt      time.Time                   `json:"applied_at"`
}

func (b *Badger) GetRemoteTombstoneCursor(_ context.Context) (int64, error) {
	var cursor remoteTombstoneCursor
	err := b.db.View(func(txn *badger.Txn) error {
		return b.getObj(txn, b.getKey(remoteTombstoneCursorPath), &cursor)
	})
	if err == model.ErrNotFound {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return cursor.Value, nil
}

func (b *Badger) ApplyRemoteTombstones(_ context.Context, batch *model.RemoteTombstoneBatch, now time.Time) error {
	if batch == nil {
		return errors.New("remote tombstone batch is required")
	}
	return b.db.Update(func(txn *badger.Txn) error {
		current, err := b.getRemoteTombstoneCursor(txn)
		if err != nil {
			return err
		}
		if batch.Cursor != current {
			return errors.Errorf("remote tombstone cursor mismatch: got %d current %d", batch.Cursor, current)
		}
		if batch.NextCursor < current {
			return errors.Errorf("remote tombstone cursor moved backwards: got %d current %d", batch.NextCursor, current)
		}
		for _, change := range batch.Changes {
			if err := b.applyRemoteTombstoneChange(txn, change, now); err != nil {
				return err
			}
		}
		return b.setObj(txn, b.getKey(remoteTombstoneCursorPath), &remoteTombstoneCursor{
			Value:     batch.NextCursor,
			UpdatedAt: now,
		}, true)
	})
}

func (b *Badger) IsRemoteEpisodeTombstoned(_ context.Context, feedID, localEpisodeID string) (bool, error) {
	var marker remoteTombstoneMarker
	err := b.db.View(func(txn *badger.Txn) error {
		return b.getObj(txn, b.remoteTombstoneEpisodeKey(feedID, localEpisodeID), &marker)
	})
	if err == model.ErrNotFound {
		return false, nil
	}
	return err == nil, err
}

func (b *Badger) getRemoteTombstoneCursor(txn *badger.Txn) (int64, error) {
	var cursor remoteTombstoneCursor
	err := b.getObj(txn, b.getKey(remoteTombstoneCursorPath), &cursor)
	if err == model.ErrNotFound {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return cursor.Value, nil
}

func (b *Badger) applyRemoteTombstoneChange(txn *badger.Txn, change model.RemoteTombstoneChange, now time.Time) error {
	if strings.TrimSpace(change.FeedID) == "" || strings.TrimSpace(change.LocalEpisodeID) == "" {
		return errors.New("remote tombstone identity is required")
	}
	if !change.HasConsistentStatusAction() {
		return errors.Errorf("remote tombstone status/action mismatch: %s/%s", change.Status, change.Action)
	}
	key := b.remoteTombstoneEpisodeKey(change.FeedID, change.LocalEpisodeID)
	if change.Status == model.RemoteEpisodeStatusVisible && change.Action == model.RemoteTombstoneActionRestore {
		err := txn.Delete(key)
		if err == badger.ErrKeyNotFound {
			return nil
		}
		return err
	}
	if !change.Status.IsTombstoned() {
		return errors.Errorf("remote tombstone status is not tombstoned: %s", change.Status)
	}
	marker := remoteTombstoneMarker{
		FeedID:         change.FeedID,
		LocalEpisodeID: change.LocalEpisodeID,
		Status:         change.Status,
		Action:         change.Action,
		Sequence:       change.Sequence,
		CreatedAt:      change.CreatedAt,
		AppliedAt:      now,
	}
	if err := b.setObj(txn, key, &marker, true); err != nil {
		return err
	}
	return b.failPendingRemotePublishTask(txn, model.RemotePublishTaskID(change.FeedID, change.LocalEpisodeID), now)
}

func (b *Badger) remoteEpisodeTombstoned(txn *badger.Txn, feedID, localEpisodeID string) (bool, error) {
	var marker remoteTombstoneMarker
	err := b.getObj(txn, b.remoteTombstoneEpisodeKey(feedID, localEpisodeID), &marker)
	if err == model.ErrNotFound {
		return false, nil
	}
	return err == nil, err
}

func (b *Badger) remoteTombstoneEpisodeKey(feedID, localEpisodeID string) []byte {
	return b.getKey(remoteTombstoneEpisodePath, model.RemotePublishTaskID(feedID, localEpisodeID))
}
