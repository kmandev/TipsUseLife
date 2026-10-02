-- 0006_product_suggestions.sql  (Phase AM-2.3: product mapping suggestions)
--
-- Additive only: two NEW tables and their indexes. No ALTER, no DROP, no
-- data change. `products`, `content_mappings`, `comments`, `replies`,
-- `post_candidates` and `discovery_runs` are not touched, and the reply
-- pipeline never reads these tables.
--
-- product_suggestions: one AI suggestion for one logical post/Reel, for
-- HUMAN review. A suggestion never creates or changes a content mapping;
-- the operator maps through the existing manual mapping form.
--   subject_key            'r:<canonical_reel_id>' or 'p:<post_id>' (AM-2.2 logical identity)
--   representative_post_id the representative source id at suggestion time (never fabricated)
--   product_id             NULL = the AI found no suitable product in the closed candidate set
--   status                 PENDING / REJECTED / SUPERSEDED in AM-2.3; APPROVED is reserved
--                          for a later, explicit approval phase
--   source                 AI in AM-2.3; PREFILTER is reserved
-- Uniqueness: one row per (page, subject, product-or-no-match, content hash).
-- COALESCE(product_id, 0) makes a no-match row unique too (SQLite treats
-- NULLs as distinct; real product ids start at 1).
--
-- suggestion_runs: one row per manual generation run -- counters, safe
-- error category, and the lock that stops two runs overlapping.

CREATE TABLE IF NOT EXISTS product_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  representative_post_id TEXT NOT NULL,
  product_id INTEGER,
  rank INTEGER NOT NULL DEFAULT 1 CHECK (rank BETWEEN 1 AND 3),
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  prefilter_score INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('PREFILTER', 'AI')),
  reason TEXT,
  model TEXT,
  prompt_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_suggestions_identity
  ON product_suggestions(page_id, subject_key, COALESCE(product_id, 0), content_hash);

CREATE INDEX IF NOT EXISTS idx_product_suggestions_status
  ON product_suggestions(page_id, status, id);

CREATE TABLE IF NOT EXISTS suggestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'OK', 'PARTIAL', 'FAILED')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  eligible INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  suggested INTEGER NOT NULL DEFAULT 0,
  no_match INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  superseded INTEGER NOT NULL DEFAULT 0,
  -- Safe category only (e.g. HERMES_TIMEOUT, AI_INVALID_OUTPUT); never prompt or response text.
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_suggestion_runs_page
  ON suggestion_runs(page_id, id DESC);
