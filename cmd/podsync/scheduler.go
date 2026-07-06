package main

import (
	"fmt"

	"github.com/pkg/errors"
	"github.com/robfig/cron/v3"

	"github.com/mxpv/podsync/pkg/feed"
)

type scheduledFeed struct {
	entryID  cron.EntryID
	schedule string
}

func feedCronSchedule(feedConfig *feed.Config) (string, bool) {
	if feedConfig.CronSchedule != "" {
		return feedConfig.CronSchedule, true
	}
	return fmt.Sprintf("@every %s", feedConfig.UpdatePeriod.String()), false
}

func validateFeedSchedules(feeds map[string]*feed.Config) error {
	c := cron.New()
	for id, feedConfig := range feeds {
		schedule, _ := feedCronSchedule(feedConfig)
		entryID, err := c.AddFunc(schedule, func() {})
		if err != nil {
			return errors.Wrapf(err, "invalid cron_schedule for %q", id)
		}
		c.Remove(entryID)
	}
	return nil
}

func reconcileFeedSchedules(c *cron.Cron, entries map[string]scheduledFeed, feeds map[string]*feed.Config, updates chan<- *feed.Config) ([]*feed.Config, error) {
	if err := validateFeedSchedules(feeds); err != nil {
		return nil, err
	}

	for id, entry := range entries {
		if _, ok := feeds[id]; !ok {
			c.Remove(entry.entryID)
			delete(entries, id)
		}
	}

	var queue []*feed.Config
	for id, feedConfig := range feeds {
		schedule, hasExplicitCronSchedule := feedCronSchedule(feedConfig)
		if existing, ok := entries[id]; ok {
			if existing.schedule == schedule {
				continue
			}
			c.Remove(existing.entryID)
		}

		cronFeed := feedConfig
		entryID, err := c.AddFunc(schedule, func() {
			updates <- cronFeed
		})
		if err != nil {
			return nil, err
		}
		entries[id] = scheduledFeed{entryID: entryID, schedule: schedule}

		if !hasExplicitCronSchedule {
			queue = append(queue, cronFeed)
		}
	}

	return queue, nil
}

func enqueueFeedUpdates(updates chan<- *feed.Config, feeds []*feed.Config) {
	for _, feedConfig := range feeds {
		updates <- feedConfig
	}
}
