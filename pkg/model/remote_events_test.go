package model

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRemoteEventTypesMatchPhase5BWhitelist(t *testing.T) {
	got := []RemoteEventType{
		RemoteEventSyncRunStarted,
		RemoteEventSyncRunFinished,
		RemoteEventConfigFetched,
		RemoteEventConfigFallbackUsed,
		RemoteEventConfigInvalid,
		RemoteEventFeedUpdateStarted,
		RemoteEventFeedUpdateFinished,
		RemoteEventFeedUpdateFailed,
		RemoteEventEpisodeDiscovered,
		RemoteEventDownloadFinished,
		RemoteEventDownloadFailed,
		RemoteEventUploadFinished,
		RemoteEventUploadFailed,
		RemoteEventReportFinished,
		RemoteEventReportFailed,
		RemoteEventTombstoneFetched,
		RemoteEventTombstoneApplied,
		RemoteEventTombstoneApplyFailed,
	}

	assert.Equal(t, []RemoteEventType{
		"sync_run_started",
		"sync_run_finished",
		"remote_config_fetched",
		"remote_config_fallback_used",
		"remote_config_invalid",
		"feed_update_started",
		"feed_update_finished",
		"feed_update_failed",
		"episode_discovered",
		"episode_download_finished",
		"episode_download_failed",
		"episode_upload_finished",
		"episode_upload_failed",
		"episode_report_finished",
		"episode_report_failed",
		"tombstone_fetched",
		"tombstone_applied",
		"tombstone_apply_failed",
	}, got)
}
