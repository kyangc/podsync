export interface FeedRow {
  feed_id: string;
  provider: "youtube" | "bilibili";
  url: string;
  title_override: string | null;
  description_override: string | null;
  enabled: number;
  include_in_opml: number;
  private_feed: number;
  update_period: string;
  page_size: number;
  keep_last: number;
  cookie_profile: string | null;
  feed_token_hash: string;
}

export interface FeedFilterRow {
  feed_id: string;
  title: string | null;
  not_title: string | null;
  description: string | null;
  not_description: string | null;
  min_duration: number | null;
  max_duration: number | null;
  min_age: number | null;
  max_age: number | null;
}

export interface FeedTomlRow extends FeedRow, Partial<Omit<FeedFilterRow, "feed_id">> {}

export interface DownloaderDefaults {
  socket_timeout: number;
  retries: number;
  fragment_retries: number;
}

export interface PublicFeedRow {
  feed_id: string;
  provider: "youtube" | "bilibili";
  url: string;
  title_override: string | null;
  description_override: string | null;
  page_size: number;
  title: string | null;
  description: string | null;
  link: string | null;
}

export interface AdminFeedListRow {
  feed_id: string;
  provider: "youtube" | "bilibili";
  url: string;
  title_override: string | null;
  description_override: string | null;
  enabled: number;
  include_in_opml: number;
  private_feed: number;
  update_period: string;
  page_size: number;
  keep_last: number;
  cookie_profile: string | null;
  public_path: string | null;
  metadata_title: string | null;
  metadata_description: string | null;
  title: string | null;
  not_title: string | null;
  description: string | null;
  not_description: string | null;
  min_duration: number | null;
  max_duration: number | null;
  min_age: number | null;
  max_age: number | null;
}

export type EpisodeStatus = "pending" | "visible" | "hidden" | "delete_pending" | "purged";

export interface AdminEpisodeListRow {
  local_episode_id: string;
  source_episode_id: string;
  source_url: string | null;
  title: string | null;
  published_at: string | null;
  duration: number | null;
  status: EpisodeStatus;
  r2_key: string | null;
  size: number | null;
  mime_type: string | null;
  updated_at: string;
}

export interface PublicOpmlFeedRow {
  feed_id: string;
  title: string | null;
  title_override: string | null;
  public_path: string | null;
}

export interface AdminSubscriptionFeedRow {
  feed_id: string;
  title: string | null;
  title_override: string | null;
  public_path: string | null;
}

export interface AdminSubscriptionOpmlRow {
  label: string;
  public_path: string | null;
}

export type SyncRunStatus = "running" | "success" | "partial" | "failed";
export type EventLevel = "debug" | "info" | "warn" | "error";

export type RemoteEventType =
  | "sync_run_started"
  | "sync_run_finished"
  | "remote_config_fetched"
  | "remote_config_fallback_used"
  | "remote_config_invalid"
  | "feed_update_started"
  | "feed_update_finished"
  | "feed_update_failed"
  | "episode_discovered"
  | "episode_download_finished"
  | "episode_download_failed"
  | "episode_upload_finished"
  | "episode_upload_failed"
  | "episode_report_finished"
  | "episode_report_failed"
  | "tombstone_fetched"
  | "tombstone_applied"
  | "tombstone_apply_failed"
  | "r2_probe_failed"
  | "remote_api_failed"
  | "cookie_profile_missing"
  | "cookie_profile_invalid";

export interface SyncRunUpsertRequest {
  id: string;
  started_at: string;
  finished_at?: string | null;
  status: SyncRunStatus;
  feeds_updated: number;
  episodes_downloaded: number;
  episodes_uploaded: number;
  errors_count: number;
}

export interface RemoteEventInput {
  sequence: number;
  event_time: string;
  level: EventLevel;
  type: RemoteEventType;
  feed_id?: string | null;
  local_episode_id?: string | null;
  message?: string | null;
  error_code?: string | null;
  error_detail?: string | null;
}

export interface EventBatchRequest {
  run: SyncRunUpsertRequest;
  events: RemoteEventInput[];
}

export interface FeedMetadataUpsertRequest {
  feed_id: string;
  provider: "youtube" | "bilibili";
  source_url: string;
  title?: string;
  description?: string;
  image_url?: string;
  link?: string;
  author?: string;
  category?: string;
  language?: string;
  explicit?: boolean;
  last_source_update_at?: string;
  reported_at: string;
}

export interface AdminSyncRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: SyncRunStatus;
  feeds_updated: number;
  episodes_downloaded: number;
  episodes_uploaded: number;
  errors_count: number;
}

export interface AdminEventRow {
  run_id: string;
  sequence: number;
  event_time: string;
  level: EventLevel;
  type: RemoteEventType;
  feed_id: string | null;
  local_episode_id: string | null;
  message: string | null;
  error_code: string | null;
  error_detail: string | null;
}

export interface AdminFeedStatusRequest {
  feed_id: string;
  enabled?: boolean;
  include_in_opml?: boolean;
}

export interface AdminFeedFilters {
  title: string | null;
  not_title: string | null;
  description: string | null;
  not_description: string | null;
  min_duration: number | null;
  max_duration: number | null;
  min_age: number | null;
  max_age: number | null;
}

export interface AdminFeedConfigUpsertRequest {
  feed_id: string;
  provider: "youtube" | "bilibili";
  url: string;
  title_override: string | null;
  description_override: string | null;
  enabled: boolean;
  include_in_opml: boolean;
  private_feed: boolean;
  update_period: string;
  page_size: number;
  keep_last: number;
  cookie_profile: string | null;
  filters: AdminFeedFilters;
}

export interface FeedStatusRow {
  feed_id: string;
  enabled: number;
  include_in_opml: number;
}

export type AdminEpisodeAction = "hide" | "delete" | "restore";

export interface AdminEpisodeStatusRequest {
  feed_id: string;
  local_episode_id: string;
  action: AdminEpisodeAction;
}

export interface EpisodeAdminRow {
  feed_id: string;
  local_episode_id: string;
  status: EpisodeStatus;
  r2_key: string | null;
}

export interface TombstoneChangeRow {
  sequence: number;
  feed_id: string;
  local_episode_id: string;
  status: EpisodeStatus;
  action: "hide" | "delete" | "purge" | "restore";
  created_at: string;
}

export interface MaxSequenceRow {
  max_sequence: number | null;
}

export interface EpisodeUpsertRequest {
  feed_id: string;
  provider: "youtube" | "bilibili";
  source_episode_id: string;
  local_episode_id: string;
  source_url?: string;
  thumbnail?: string;
  title?: string;
  description?: string;
  published_at?: string;
  duration?: number;
  r2_key: string;
  size: number;
  mime_type: string;
  asset_token: string;
}

export interface EpisodeStatusRow {
  status: EpisodeStatus;
}

export interface PublicEpisodeRow {
  local_episode_id: string;
  source_url: string | null;
  title: string | null;
  description: string | null;
  published_at: string | null;
  duration: number | null;
  r2_key: string;
  size: number;
  mime_type: string;
}
