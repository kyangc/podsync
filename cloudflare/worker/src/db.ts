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

export interface AdminFeedStatusRequest {
  feed_id: string;
  enabled?: boolean;
  include_in_opml?: boolean;
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
