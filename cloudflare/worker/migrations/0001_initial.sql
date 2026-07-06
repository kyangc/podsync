CREATE TABLE feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('youtube', 'bilibili')),
  url TEXT NOT NULL,
  title_override TEXT,
  description_override TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  include_in_opml INTEGER NOT NULL DEFAULT 1 CHECK (include_in_opml IN (0, 1)),
  private_feed INTEGER NOT NULL DEFAULT 1 CHECK (private_feed IN (0, 1)),
  update_period TEXT NOT NULL DEFAULT '1h',
  page_size INTEGER NOT NULL DEFAULT 25,
  keep_last INTEGER NOT NULL DEFAULT 25,
  cookie_profile TEXT,
  feed_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE feed_filters (
  feed_id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  not_title TEXT,
  description TEXT,
  not_description TEXT,
  min_duration INTEGER,
  max_duration INTEGER,
  min_age INTEGER,
  max_age INTEGER,
  FOREIGN KEY (feed_id) REFERENCES feeds(feed_id) ON DELETE CASCADE
);

CREATE TABLE global_downloader_defaults (
  provider TEXT PRIMARY KEY NOT NULL,
  socket_timeout INTEGER NOT NULL,
  retries INTEGER NOT NULL,
  fragment_retries INTEGER NOT NULL
);

INSERT INTO global_downloader_defaults (provider, socket_timeout, retries, fragment_retries)
VALUES ('youtube', 12, 1, 1);

CREATE TABLE opml_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'default',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE feed_metadata (
  feed_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('youtube', 'bilibili')),
  source_url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  image_url TEXT,
  link TEXT,
  author TEXT,
  category TEXT,
  language TEXT,
  explicit INTEGER CHECK (explicit IS NULL OR explicit IN (0, 1)),
  last_source_update_at TEXT,
  reported_at TEXT NOT NULL,
  FOREIGN KEY (feed_id) REFERENCES feeds(feed_id) ON DELETE CASCADE
);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('youtube', 'bilibili')),
  source_episode_id TEXT NOT NULL,
  local_episode_id TEXT NOT NULL,
  source_url TEXT,
  thumbnail TEXT,
  title TEXT,
  description TEXT,
  published_at TEXT,
  duration INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'visible', 'hidden', 'delete_pending', 'purged')),
  r2_key TEXT,
  size INTEGER,
  mime_type TEXT,
  asset_token TEXT,
  deleted_at TEXT,
  purge_after TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(feed_id, local_episode_id),
  FOREIGN KEY (feed_id) REFERENCES feeds(feed_id) ON DELETE CASCADE
);

CREATE TABLE tombstone_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT NOT NULL,
  local_episode_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('hidden', 'delete_pending', 'purged', 'visible')),
  action TEXT NOT NULL CHECK (action IN ('hide', 'delete', 'purge', 'restore')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  feeds_updated INTEGER NOT NULL DEFAULT 0,
  episodes_downloaded INTEGER NOT NULL DEFAULT 0,
  episodes_uploaded INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_time TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  type TEXT NOT NULL,
  feed_id TEXT,
  local_episode_id TEXT,
  message TEXT,
  error_code TEXT,
  error_detail TEXT,
  UNIQUE(run_id, sequence)
);

CREATE INDEX idx_feeds_enabled_opml ON feeds(enabled, include_in_opml);
CREATE INDEX idx_episodes_feed_status ON episodes(feed_id, status, published_at);
CREATE INDEX idx_tombstone_sequence ON tombstone_changes(sequence);
CREATE INDEX idx_events_time ON events(event_time);
