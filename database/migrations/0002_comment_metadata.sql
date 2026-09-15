-- 0002_comment_metadata.sql
--
-- Additive only. No DROP, no data rewrite, no column removal.
-- Stores the Facebook thread metadata that the normalized event carries
-- but 0001 had nowhere to put.
--
-- SQLite/D1 note: ALTER TABLE ... ADD COLUMN is safe and non-blocking.
-- If a column already exists the statement errors; re-running this
-- migration is therefore not idempotent by itself and is guarded by the
-- wrangler migrations table.

ALTER TABLE comments ADD COLUMN facebook_parent_id TEXT;

ALTER TABLE comments ADD COLUMN facebook_created_time TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_facebook_comment_id
  ON comments(facebook_comment_id);

CREATE INDEX IF NOT EXISTS idx_replies_mode_status
  ON replies(mode, status);
