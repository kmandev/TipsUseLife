-- 0005_post_candidates_canonical_reel.sql  (Phase AM-2.2)
--
-- Additive only: one nullable column and one NON-unique index on the
-- AM-2 table post_candidates. Nothing is dropped, no existing column or
-- constraint changes, and `products`, `content_mappings`, `comments` and
-- `replies` are not touched. UNIQUE(page_id, post_id) is unchanged.
--
-- canonical_reel_id: the numeric id of a Facebook Reel, taken ONLY from a
-- permalink of exactly the form https://www.facebook.com/reel/<digits>
-- (see src/facebook-posts.js canonicalReelIdFromPermalink). NULL for
-- everything else. It is a derived grouping key, never a mapping key: the
-- same logical Reel can legitimately appear under two source post_ids (the
-- posts edge `<page>_<n>` and the reels edge bare id), so it is deliberately
-- NOT unique. Existing rows stay NULL until the idempotent backfill
-- (src/discovery.js backfillCanonicalReelIds) populates them.

ALTER TABLE post_candidates ADD COLUMN canonical_reel_id TEXT;

CREATE INDEX IF NOT EXISTS idx_post_candidates_canonical_reel
  ON post_candidates(page_id, canonical_reel_id);
