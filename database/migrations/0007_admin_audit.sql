-- 0007_admin_audit.sql  (Upgrade U8: admin change history)
--
-- Additive only: one new table + index. No existing table is altered, no
-- data is rewritten. Older Worker versions never read this table.
--
-- One row per admin action that changes state (mapping, product, suggestion
-- decision, comment retry/reconcile). before_json / after_json hold only the
-- whitelisted business fields (ids, names, product_id, active, note, URL of
-- the affiliate product) -- never a token, secret, cookie or comment text.
-- There is a single admin password, so "who" is not recorded.

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('MAPPING', 'PRODUCT', 'SUGGESTION', 'COMMENT')),
  target_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_page ON admin_audit(page_id, id DESC);
