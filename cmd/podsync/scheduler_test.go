package main

import (
	"testing"
	"time"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/robfig/cron/v3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateFeedSchedulesRejectsInvalidCron(t *testing.T) {
	feeds := map[string]*feed.Config{
		"bad": {ID: "bad", CronSchedule: "not a cron"},
	}

	err := validateFeedSchedules(feeds)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "bad")
}

func TestValidateFeedSchedulesAllowsEmptySet(t *testing.T) {
	require.NoError(t, validateFeedSchedules(map[string]*feed.Config{}))
}

func TestReconcileFeedSchedulesAddsFeedsAndQueuesInitialUpdate(t *testing.T) {
	c := cron.New()
	updates := make(chan *feed.Config, 4)
	entries := map[string]scheduledFeed{}
	feeds := map[string]*feed.Config{
		"implicit": {ID: "implicit", UpdatePeriod: time.Hour},
		"explicit": {ID: "explicit", CronSchedule: "0 * * * *"},
	}

	queue, err := reconcileFeedSchedules(c, entries, feeds, updates)

	require.NoError(t, err)
	require.Len(t, entries, 2)
	require.Len(t, queue, 1)
	assert.Equal(t, "implicit", queue[0].ID)
	assert.Len(t, updates, 0)
}

func TestReconcileFeedSchedulesRemovesDeletedFeeds(t *testing.T) {
	c := cron.New()
	updates := make(chan *feed.Config, 4)
	entries := map[string]scheduledFeed{}
	initial := map[string]*feed.Config{
		"A": {ID: "A", UpdatePeriod: time.Hour},
		"B": {ID: "B", UpdatePeriod: time.Hour},
	}
	_, err := reconcileFeedSchedules(c, entries, initial, updates)
	require.NoError(t, err)

	_, err = reconcileFeedSchedules(c, entries, map[string]*feed.Config{
		"B": {ID: "B", UpdatePeriod: time.Hour},
	}, updates)

	require.NoError(t, err)
	assert.NotContains(t, entries, "A")
	assert.Contains(t, entries, "B")
}

func TestReconcileFeedSchedulesUpdatesChangedSchedule(t *testing.T) {
	c := cron.New()
	updates := make(chan *feed.Config, 4)
	entries := map[string]scheduledFeed{}
	feeds := map[string]*feed.Config{"A": {ID: "A", UpdatePeriod: time.Hour}}
	queue, err := reconcileFeedSchedules(c, entries, feeds, updates)
	require.NoError(t, err)
	require.Len(t, queue, 1)
	firstEntry := entries["A"].entryID

	queue, err = reconcileFeedSchedules(c, entries, map[string]*feed.Config{
		"A": {ID: "A", UpdatePeriod: 2 * time.Hour},
	}, updates)

	require.NoError(t, err)
	require.Len(t, queue, 1)
	assert.NotEqual(t, firstEntry, entries["A"].entryID)
	assert.Equal(t, "A", queue[0].ID)
}

func TestReconcileFeedSchedulesDoesNotDuplicateUnchangedFeed(t *testing.T) {
	c := cron.New()
	updates := make(chan *feed.Config, 4)
	entries := map[string]scheduledFeed{}
	feeds := map[string]*feed.Config{"A": {ID: "A", UpdatePeriod: time.Hour}}
	queue, err := reconcileFeedSchedules(c, entries, feeds, updates)
	require.NoError(t, err)
	require.Len(t, queue, 1)
	firstEntry := entries["A"].entryID

	queue, err = reconcileFeedSchedules(c, entries, feeds, updates)

	require.NoError(t, err)
	assert.Equal(t, firstEntry, entries["A"].entryID)
	assert.Empty(t, queue)
}

func TestReconcileFeedSchedulesRejectsInvalidChangeWithoutMutatingEntries(t *testing.T) {
	c := cron.New()
	updates := make(chan *feed.Config, 4)
	entries := map[string]scheduledFeed{}
	feeds := map[string]*feed.Config{"A": {ID: "A", UpdatePeriod: time.Hour}}
	_, err := reconcileFeedSchedules(c, entries, feeds, updates)
	require.NoError(t, err)
	firstEntry := entries["A"]

	_, err = reconcileFeedSchedules(c, entries, map[string]*feed.Config{
		"A": {ID: "A", CronSchedule: "not a cron"},
	}, updates)

	require.Error(t, err)
	assert.Equal(t, firstEntry, entries["A"])
}

func TestReconcileFeedSchedulesReturnsLargeInitialQueueWithoutBlocking(t *testing.T) {
	c := cron.New()
	updates := make(chan *feed.Config, 1)
	entries := map[string]scheduledFeed{}
	feeds := make(map[string]*feed.Config)
	for i := 0; i < 32; i++ {
		id := string(rune('a' + i))
		feeds[id] = &feed.Config{ID: id, UpdatePeriod: time.Hour}
	}

	queue, err := reconcileFeedSchedules(c, entries, feeds, updates)

	require.NoError(t, err)
	assert.Len(t, queue, 32)
	assert.Len(t, updates, 0)
}

func TestReconcileFeedSchedulesCronCallbackStillEnqueues(t *testing.T) {
	c := cron.New()
	updates := make(chan *feed.Config, 4)
	entries := map[string]scheduledFeed{}
	feeds := map[string]*feed.Config{"A": {ID: "A", CronSchedule: "@every 1s"}}
	_, err := reconcileFeedSchedules(c, entries, feeds, updates)
	require.NoError(t, err)

	c.Entry(entries["A"].entryID).Job.Run()

	select {
	case got := <-updates:
		assert.Equal(t, "A", got.ID)
	default:
		t.Fatal("cron callback did not enqueue feed")
	}
}
