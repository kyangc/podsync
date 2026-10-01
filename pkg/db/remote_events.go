package db

import (
	"context"
	"sort"

	"github.com/dgraph-io/badger"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

const remoteEventRunPrefix = "remote/events/"
const remoteEventRunPath = "remote/events/%s"

func (database *Badger) SaveRemoteEventRun(_ context.Context, state *model.RemoteEventRunState) error {
	if state == nil || state.Run.ID == "" || state.NextSequence < 1 {
		return errors.New("invalid remote event run state")
	}
	return database.db.Update(func(transaction *badger.Txn) error {
		return database.setObj(transaction, database.getKey(remoteEventRunPath, state.Run.ID), state, true)
	})
}

func (database *Badger) PendingRemoteEventRuns(_ context.Context) ([]*model.RemoteEventRunState, error) {
	states := make([]*model.RemoteEventRunState, 0)
	err := database.db.View(func(transaction *badger.Txn) error {
		options := badger.DefaultIteratorOptions
		options.Prefix = database.getKey(remoteEventRunPrefix)
		options.PrefetchValues = true
		return database.iterator(transaction, options, func(item *badger.Item) error {
			state := &model.RemoteEventRunState{}
			if err := database.unmarshalObj(item, state); err != nil {
				return err
			}
			states = append(states, state)
			return nil
		})
	})
	sort.Slice(states, func(first, second int) bool {
		if states[first].Run.StartedAt == states[second].Run.StartedAt {
			return states[first].Run.ID < states[second].Run.ID
		}
		return states[first].Run.StartedAt < states[second].Run.StartedAt
	})
	return states, err
}

func (database *Badger) DeleteRemoteEventRun(_ context.Context, runID string) error {
	return database.db.Update(func(transaction *badger.Txn) error {
		return transaction.Delete(database.getKey(remoteEventRunPath, runID))
	})
}
