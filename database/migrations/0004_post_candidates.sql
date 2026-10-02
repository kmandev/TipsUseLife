-- 0004_post_candidates.sql  (Phase AM-2: read-only post discovery)
--
-- Additive only. No DROP, no ALTER of existing tables, no data rewrite.
-- `products`, `content_mappings`, `comments` and `replies` are NOT touched,
-- and the comment-reply pipeline never reads the tables created here.
--
-- 1. post_candidates: Facebook Page posts / reels found by the manual,
--    read-only discovery run (src/discovery.js). One row per
--    (page_id, post_id). Discovery never creates a mapping.
-- 2. discovery_runs: one row per manual run -- the summary, safe error
--    categories, and the lock that stops two runs overlapping.
--
-- D1 has no row-level security; the database is reachable only through the
-- Worker's `DB` binding and every admin route is session-authenticated.

CREATE TABLE IF NOT EXISTS post_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  -- NULL = not reliably identifiable (never guessed).
  content_type TEXT CHECK (content_type IS NULL OR content_type IN ('POST', 'REEL')),
  message TEXT,
  permalink TEXT,
  fb_created_time TEXT,
  -- Graph `status_type`, informational only.
  source_status_type TEXT,
  -- SHA-256 (hex) of the full message text; detects edits.
  content_hash TEXT NOT NULL,
  -- Which Graph edge reported it: 'posts' or 'reels'.
  discovery_source TEXT NOT NULL CHECK (discovery_source IN ('posts', 'reels')),
  -- DISCOVERED: first seen, content unchanged since.
  -- UPDATED:    content changed after first discovery.
  status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN ('DISCOVERED', 'UPDATED')),
  revision INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_changed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (page_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_post_candidates_status
  ON post_candidates(page_id, status);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  -- RUNNING, OK, PARTIAL (some sources failed), FAILED.
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'OK', 'PARTIAL', 'FAILED')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  discovered INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  -- Safe JSON: per-source {source, ok, error_code, graph_code, pages, items, complete}.
  -- Never contains a token, a Graph error message or a request header.
  detail TEXT,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_page
  ON discovery_runs(page_id, id DESC);
