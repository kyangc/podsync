import type {
  AdminEpisodeAction,
  AdminFeedConfigUpsertRequest,
  EpisodeAdminRow,
  EpisodeStatus,
} from "./db";
import { r2KeyBlank } from "./media";

export const eventRetentionDays = 30;
export const syncRunRetentionDays = 180;
export const retentionGraceDays = 3;

export interface EpisodeTransition {
  changed: boolean;
  status: EpisodeStatus;
  action: "hide" | "delete" | "restore";
  conflict?: string;
}

export function episodeTransition(current: EpisodeStatus, action: AdminEpisodeAction): EpisodeTransition {
  if (action === "hide") {
    if (current === "hidden") return { changed: false, status: "hidden", action: "hide" };
    if (current === "pending" || current === "visible") return { changed: true, status: "hidden", action: "hide" };
    return { changed: false, status: current, action: "hide", conflict: "episode cannot be hidden from current status" };
  }
  if (action === "delete") {
    if (current === "delete_pending") return { changed: false, status: "delete_pending", action: "delete" };
    if (current === "pending" || current === "visible" || current === "hidden") {
      return { changed: true, status: "delete_pending", action: "delete" };
    }
    return { changed: false, status: current, action: "delete", conflict: "episode cannot be deleted from current status" };
  }
  if (current === "visible") return { changed: false, status: "visible", action: "restore" };
  if (current === "hidden" || current === "delete_pending") return { changed: true, status: "visible", action: "restore" };
  return { changed: false, status: current, action: "restore", conflict: "episode cannot be restored from current status" };
}


export function episodeStatusUpdateSQL(action: AdminEpisodeAction, episode?: EpisodeAdminRow): string {
  if (action === "delete") {
    return `UPDATE episodes
               SET status = 'delete_pending',
                   deleted_at = CURRENT_TIMESTAMP,
                   purge_after = datetime(CURRENT_TIMESTAMP, '+${retentionGraceDays} days'),
                   updated_at = CURRENT_TIMESTAMP
             WHERE feed_id = ?
               AND local_episode_id = ?
               AND status IN ('pending', 'visible', 'hidden')
               AND EXISTS (
                 SELECT 1 FROM feeds
                  WHERE feeds.feed_id = episodes.feed_id
                    AND feeds.deleted_at IS NULL
               )`;
  }
  if (action === "restore") {
    const statusPredicate = episode?.status === "hidden"
      ? "status = 'hidden'"
      : r2KeyBlank(episode?.r2_key ?? null)
        ? "status = 'delete_pending' AND (r2_key IS NULL OR r2_key = '')"
        : "status = 'delete_pending' AND r2_key = ?";
    return `UPDATE episodes
               SET status = 'visible',
                   deleted_at = NULL,
                   purge_after = NULL,
                   updated_at = CURRENT_TIMESTAMP
             WHERE feed_id = ?
               AND local_episode_id = ?
               AND ${statusPredicate}
               AND EXISTS (
                 SELECT 1 FROM feeds
                  WHERE feeds.feed_id = episodes.feed_id
                    AND feeds.deleted_at IS NULL
               )`;
  }
  return `UPDATE episodes
             SET status = 'hidden',
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND local_episode_id = ?
             AND status IN ('pending', 'visible')
             AND EXISTS (
               SELECT 1 FROM feeds
                WHERE feeds.feed_id = episodes.feed_id
                  AND feeds.deleted_at IS NULL
             )`;
}

export function episodeStatusUpdateBindings(action: AdminEpisodeAction, episode: EpisodeAdminRow, feedID: string, localEpisodeID: string): unknown[] {
  const base = [feedID, localEpisodeID];
  if (action === "restore" && episode.status === "delete_pending" && !r2KeyBlank(episode.r2_key)) {
    return [...base, episode.r2_key];
  }
  return base;
}

export function syncRunUpsertSQL(): string {
  return `INSERT INTO sync_runs (
            id, started_at, finished_at, status, feeds_updated,
            episodes_downloaded, episodes_uploaded, errors_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            started_at = CASE
              WHEN sync_runs.status = 'running' AND excluded.started_at < sync_runs.started_at THEN excluded.started_at
              ELSE sync_runs.started_at
            END,
            finished_at = CASE
              WHEN sync_runs.status = 'running' THEN excluded.finished_at
              ELSE sync_runs.finished_at
            END,
            status = CASE
              WHEN sync_runs.status = 'running' THEN excluded.status
              ELSE sync_runs.status
            END,
            feeds_updated = max(sync_runs.feeds_updated, excluded.feeds_updated),
            episodes_downloaded = max(sync_runs.episodes_downloaded, excluded.episodes_downloaded),
            episodes_uploaded = max(sync_runs.episodes_uploaded, excluded.episodes_uploaded),
            errors_count = max(sync_runs.errors_count, excluded.errors_count)`;
}

export function eventInsertSQL(): string {
  return `INSERT OR IGNORE INTO events (
            run_id, sequence, event_time, level, type, feed_id,
            local_episode_id, message, error_code, error_detail
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

export function oldEventsDeleteSQL(): string {
  return `DELETE FROM events
           WHERE datetime(event_time) < datetime(?, '-${eventRetentionDays} days')`;
}

export function oldSyncRunsDeleteSQL(): string {
  return `DELETE FROM sync_runs
           WHERE status <> 'running'
             AND datetime(COALESCE(finished_at, started_at)) < datetime(?, '-${syncRunRetentionDays} days')`;
}

export function retentionCandidatesSQL(): string {
  return `WITH ranked AS (
            SELECT e.feed_id,
                   e.local_episode_id,
                   e.status,
                   COALESCE(datetime(e.published_at), datetime(e.updated_at)) AS episode_time,
                   f.keep_last,
                   ROW_NUMBER() OVER (
                     PARTITION BY e.feed_id
                     ORDER BY COALESCE(datetime(e.published_at), datetime(e.updated_at)) DESC,
                              e.local_episode_id DESC
                   ) AS retention_rank
              FROM episodes e
              JOIN feeds f ON f.feed_id = e.feed_id
             WHERE f.deleted_at IS NULL
               AND f.keep_last > 0
               AND e.status IN ('visible', 'hidden')
          )
          SELECT feed_id, local_episode_id, status
            FROM ranked
           WHERE retention_rank > keep_last
           ORDER BY episode_time ASC, feed_id ASC, local_episode_id ASC
           LIMIT ?`;
}

export function retentionEpisodeUpdateSQL(): string {
  return `UPDATE episodes
             SET status = 'delete_pending',
                 deleted_at = ?,
                 purge_after = ?,
                 updated_at = ?
           WHERE feed_id = ?
             AND local_episode_id = ?
             AND status = ?
             AND EXISTS (
               SELECT 1 FROM feeds
                WHERE feeds.feed_id = episodes.feed_id
                  AND feeds.deleted_at IS NULL
                  AND feeds.keep_last > 0
                  AND (
                    SELECT COUNT(*)
                      FROM episodes newer
                     WHERE newer.feed_id = episodes.feed_id
                       AND newer.status IN ('visible', 'hidden')
                       AND (
                         COALESCE(datetime(newer.published_at), datetime(newer.updated_at), '0001-01-01 00:00:00') >
                           COALESCE(datetime(episodes.published_at), datetime(episodes.updated_at), '0001-01-01 00:00:00')
                         OR (
                           COALESCE(datetime(newer.published_at), datetime(newer.updated_at), '0001-01-01 00:00:00') =
                             COALESCE(datetime(episodes.published_at), datetime(episodes.updated_at), '0001-01-01 00:00:00')
                           AND newer.local_episode_id > episodes.local_episode_id
                         )
                       )
                  ) >= feeds.keep_last
             )`;
}

export function retentionTombstoneInsertSQL(): string {
  return `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
          SELECT ?, ?, 'delete_pending', 'delete', ?
           WHERE changes() = 1`;
}

export function purgeCandidatesSQL(): string {
  return `SELECT feed_id, local_episode_id, r2_key
            FROM episodes
           WHERE status = 'delete_pending'
             AND purge_after IS NOT NULL
             AND datetime(purge_after) <= datetime(?)
           ORDER BY datetime(purge_after) ASC, feed_id ASC, local_episode_id ASC
           LIMIT ?`;
}

export function purgeEpisodeUpdateSQL(): string {
  return `UPDATE episodes
             SET status = 'purged',
                 purge_after = NULL,
                 updated_at = ?
           WHERE feed_id = ?
             AND local_episode_id = ?
             AND status = 'delete_pending'
             AND (
               (r2_key IS NULL AND ? IS NULL)
               OR r2_key = ?
             )
             AND purge_after IS NOT NULL
             AND datetime(purge_after) <= datetime(?)`;
}

export function purgeTombstoneInsertSQL(): string {
  return `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
          SELECT ?, ?, 'purged', 'purge', ?
           WHERE changes() = 1`;
}

export function feedMetadataUpsertSQL(): string {
  return `INSERT INTO feed_metadata (
            feed_id, provider, source_url, title, description, image_url, link,
            author, category, language, explicit, last_source_update_at, reported_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM feeds
              WHERE feed_id = ?
                AND deleted_at IS NULL
           )
          ON CONFLICT(feed_id) DO UPDATE SET
            provider = excluded.provider,
            source_url = excluded.source_url,
            title = excluded.title,
            description = excluded.description,
            image_url = excluded.image_url,
            link = excluded.link,
            author = excluded.author,
            category = excluded.category,
            language = excluded.language,
            explicit = excluded.explicit,
            last_source_update_at = excluded.last_source_update_at,
            reported_at = excluded.reported_at
           WHERE EXISTS (
             SELECT 1 FROM feeds
              WHERE feeds.feed_id = feed_metadata.feed_id
                AND feeds.deleted_at IS NULL
           )`;
}

export function feedConfigInsertSQL(): string {
  return `INSERT INTO feeds (
            feed_id, provider, url, title_override, description_override,
            enabled, include_in_opml, private_feed, update_period, page_size,
            keep_last, cookie_profile, bilibili_include_upower_exclusive, feed_token_hash,
            public_path, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
}

export function feedConfigUpdateSQL(): string {
  return `UPDATE feeds
             SET url = ?,
                 title_override = ?,
                 description_override = ?,
                 enabled = ?,
                 include_in_opml = ?,
                 private_feed = ?,
                 update_period = ?,
                 page_size = ?,
                 keep_last = ?,
                 cookie_profile = ?,
                 bilibili_include_upower_exclusive = ?,
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND deleted_at IS NULL`;
}

export function feedFiltersUpsertSQL(): string {
  return `INSERT INTO feed_filters (
            feed_id, title, not_title, description, not_description,
            min_duration, max_duration, min_age, max_age
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(feed_id) DO UPDATE SET
            title = excluded.title,
            not_title = excluded.not_title,
            description = excluded.description,
            not_description = excluded.not_description,
            min_duration = excluded.min_duration,
            max_duration = excluded.max_duration,
            min_age = excluded.min_age,
            max_age = excluded.max_age`;
}

export function feedDeleteCandidateCountSQL(): string {
  return `SELECT COUNT(*) AS candidate_count
            FROM episodes
           WHERE feed_id = ?
             AND status IN ('pending', 'visible', 'hidden')`;
}

export function feedDeleteTombstoneInsertSQL(): string {
  return `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
          SELECT feed_id, local_episode_id, 'delete_pending', 'delete', CURRENT_TIMESTAMP
            FROM episodes
           WHERE feed_id = ?
             AND status IN ('pending', 'visible', 'hidden')`;
}

export function assertPreviousChangesSQL(): string {
  return `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
          SELECT NULL, NULL, 'delete_pending', 'delete', CURRENT_TIMESTAMP
           WHERE changes() <> ?`;
}

export function feedDeleteEpisodeUpdateSQL(): string {
  return `UPDATE episodes
             SET status = 'delete_pending',
                 deleted_at = CURRENT_TIMESTAMP,
                 purge_after = datetime(CURRENT_TIMESTAMP, '+${retentionGraceDays} days'),
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND status IN ('pending', 'visible', 'hidden')`;
}

export function feedDeleteUpdateSQL(): string {
  return `UPDATE feeds
             SET deleted_at = CURRENT_TIMESTAMP,
                 enabled = 0,
                 include_in_opml = 0,
                 public_path = NULL,
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND deleted_at IS NULL`;
}


export function feedFilterBindings(feed: AdminFeedConfigUpsertRequest): unknown[] {
  return [
    feed.feed_id,
    feed.filters.title,
    feed.filters.not_title,
    feed.filters.description,
    feed.filters.not_description,
    feed.filters.min_duration,
    feed.filters.max_duration,
    feed.filters.min_age,
    feed.filters.max_age,
  ];
}

