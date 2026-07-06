ALTER TABLE feeds ADD COLUMN public_path TEXT;
ALTER TABLE opml_tokens ADD COLUMN public_path TEXT;

CREATE UNIQUE INDEX idx_feeds_public_path ON feeds(public_path);
CREATE UNIQUE INDEX idx_opml_tokens_public_path ON opml_tokens(public_path);
