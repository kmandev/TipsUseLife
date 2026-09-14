PRAGMA foreign_keys = ON;

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  keywords TEXT NOT NULL DEFAULT '',
  shopee_url TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facebook_comment_id TEXT NOT NULL UNIQUE,
  facebook_post_id TEXT,
  page_id TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  comment_text TEXT NOT NULL,
  matched_product_id INTEGER,
  ai_response TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (
      status IN (
        'RECEIVED',
        'PROCESSED',
        'REPLIED',
        'SKIPPED',
        'ERROR'
      )
    ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (matched_product_id) REFERENCES products(id)
);

CREATE TABLE replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  response_text TEXT NOT NULL,
  mode TEXT NOT NULL
    CHECK (mode IN ('DRY_RUN', 'LIVE')),
  facebook_reply_id TEXT,
  status TEXT NOT NULL DEFAULT 'GENERATED'
    CHECK (
      status IN (
        'GENERATED',
        'SENT',
        'FAILED',
        'SKIPPED'
      )
    ),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (comment_id) REFERENCES comments(id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_comments_page_created
  ON comments(page_id, created_at DESC);

CREATE INDEX idx_comments_status
  ON comments(status);

CREATE INDEX idx_replies_comment
  ON replies(comment_id);

CREATE INDEX idx_products_active
  ON products(active);
