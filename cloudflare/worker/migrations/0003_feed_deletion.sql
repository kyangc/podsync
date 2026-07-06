ALTER TABLE feeds ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_feeds_deleted_enabled_opml ON feeds(deleted_at, enabled, include_in_opml);
