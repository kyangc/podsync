ALTER TABLE feeds ADD COLUMN bilibili_include_upower_exclusive INTEGER NOT NULL DEFAULT 0 CHECK (bilibili_include_upower_exclusive IN (0, 1));
