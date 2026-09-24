-- 0003_affiliate_catalog.sql
--
-- Additive only. No DROP, no column removal, no destructive rewrite.
--
-- 1. products: generalise the Shopee-only catalog into an affiliate catalog.
--    `shopee_url` is kept (backward compatible) and copied into the new
--    `affiliate_url`, which becomes the column the application reads.
--    `deleted_at` enables soft delete, so a product that content mappings
--    or historical comments reference is never physically removed.
-- 2. content_mappings: Facebook Page post/reel -> affiliate product.
--    The Graph API exposes no field for Shop products tagged on a Facebook
--    Page post or reel, so the mapping is managed from the Dashboard
--    (see docs/ARCHITECTURE.md, "Product link decision").
-- 3. comments / replies: audit fields for how a product was chosen and
--    which trusted URL was appended.
-- 4. A partial UNIQUE index guarantees at most one SENT reply per comment
--    at the database level -- the last line of defence against a double
--    post even if application logic regressed.
--
-- D1 has no row-level security; the database is reachable only through
-- the Worker's `DB` binding, and every admin route is session-authenticated.

ALTER TABLE products ADD COLUMN affiliate_url TEXT;
ALTER TABLE products ADD COLUMN platform TEXT NOT NULL DEFAULT 'shopee';
ALTER TABLE products ADD COLUMN image_url TEXT;
ALTER TABLE products ADD COLUMN deleted_at TEXT;

UPDATE products
   SET affiliate_url = shopee_url
 WHERE affiliate_url IS NULL
   AND shopee_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facebook_page_id TEXT NOT NULL,
  facebook_post_id TEXT NOT NULL,
  facebook_content_type TEXT NOT NULL DEFAULT 'POST'
    CHECK (facebook_content_type IN ('POST', 'REEL')),
  product_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (facebook_page_id, facebook_post_id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_content_mappings_product
  ON content_mappings(product_id);

ALTER TABLE comments ADD COLUMN facebook_post_permalink TEXT;
ALTER TABLE comments ADD COLUMN product_source TEXT;
ALTER TABLE comments ADD COLUMN ai_action TEXT;

ALTER TABLE replies ADD COLUMN affiliate_url TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_post
  ON comments(page_id, facebook_post_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_one_sent_per_comment
  ON replies(comment_id)
  WHERE status = 'SENT';
