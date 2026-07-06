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
  url: string;
  title_override: string | null;
  description_override: string | null;
  title: string | null;
  description: string | null;
  link: string | null;
}
