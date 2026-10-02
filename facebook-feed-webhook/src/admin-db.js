/**
 * D1 queries behind the Dashboard (products, content mappings, overview).
 *
 * Every value is a bound parameter. The only interpolated SQL fragments
 * are fixed literals chosen in this file. Callers validate input first
 * (admin-api.js); this layer assumes validated, typed values.
 */

const PRODUCT_COLUMNS = `id, name, description, keywords, platform, image_url,
  COALESCE(affiliate_url, shopee_url) AS affiliate_url,
  active, deleted_at, created_at, updated_at`;

/* ---------------------------- products ---------------------------- */

export async function listProducts(db, { search = null, active = null, includeDeleted = false } = {}) {
  const where = [];
  const params = [];
  if (!includeDeleted) where.push("deleted_at IS NULL");
  if (active === 0 || active === 1) {
    where.push("active = ?");
    params.push(active);
  }
  if (search) {
    where.push("(name LIKE ? OR keywords LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  const sql = `SELECT ${PRODUCT_COLUMNS},
      (SELECT COUNT(*) FROM content_mappings m WHERE m.product_id = products.id AND m.active = 1) AS mapping_count
     FROM products
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY deleted_at IS NOT NULL, active DESC, updated_at DESC, id DESC
     LIMIT 500`;
  const result = await db.prepare(sql).bind(...params).all();
  return result?.results ?? [];
}

export async function getProduct(db, id) {
  return (await db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).bind(id).first()) ?? null;
}

export async function createProduct(db, p) {
  const row = await db
    .prepare(
      `INSERT INTO products (name, description, keywords, platform, image_url, affiliate_url, shopee_url, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .bind(
      p.name,
      p.description,
      p.keywords,
      p.platform,
      p.image_url,
      p.affiliate_url,
      // Keep the legacy column in sync for backward compatibility.
      p.affiliate_url,
      p.active
    )
    .first();
  return Number(row.id);
}

export async function updateProduct(db, id, p) {
  const result = await db
    .prepare(
      `UPDATE products
          SET name = ?, description = ?, keywords = ?, platform = ?, image_url = ?,
              affiliate_url = ?, shopee_url = ?, active = ?, updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(p.name, p.description, p.keywords, p.platform, p.image_url, p.affiliate_url, p.affiliate_url, p.active, id)
    .run();
  return Number(result?.meta?.changes ?? 0);
}

export async function setProductActive(db, id, active) {
  const result = await db
    .prepare(`UPDATE products SET active = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`)
    .bind(active, id)
    .run();
  return Number(result?.meta?.changes ?? 0);
}

/**
 * Soft delete. The row stays (comments and mappings reference it), it is
 * deactivated and hidden, and every mapping pointing at it is switched off
 * so no reply can ever resolve to it again.
 */
export async function softDeleteProduct(db, id) {
  const result = await db
    .prepare(
      `UPDATE products
          SET active = 0, deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(id)
    .run();
  const changed = Number(result?.meta?.changes ?? 0);
  if (changed > 0) {
    await db
      .prepare(`UPDATE content_mappings SET active = 0, updated_at = datetime('now') WHERE product_id = ?`)
      .bind(id)
      .run();
  }
  return changed;
}

/* ------------------------- content mappings ------------------------ */

export async function listMappings(db, pageId) {
  const result = await db
    .prepare(
      `SELECT m.id, m.facebook_page_id, m.facebook_post_id, m.facebook_content_type,
              m.product_id, m.active, m.note, m.created_at, m.updated_at,
              p.name AS product_name, p.active AS product_active, p.deleted_at AS product_deleted_at,
              (SELECT COUNT(*) FROM comments c
                WHERE c.page_id = m.facebook_page_id AND c.facebook_post_id = m.facebook_post_id) AS comment_count,
              (SELECT c.facebook_post_permalink FROM comments c
                WHERE c.page_id = m.facebook_page_id AND c.facebook_post_id = m.facebook_post_id
                  AND c.facebook_post_permalink IS NOT NULL
                ORDER BY c.id DESC LIMIT 1) AS permalink
         FROM content_mappings m
         JOIN products p ON p.id = m.product_id
        WHERE m.facebook_page_id = ?
        ORDER BY m.updated_at DESC, m.id DESC
        LIMIT 500`
    )
    .bind(pageId)
    .all();
  return result?.results ?? [];
}

/** Posts/reels that received comments but have no mapping yet. */
export async function listUnmappedPosts(db, pageId) {
  const result = await db
    .prepare(
      `SELECT c.facebook_post_id AS facebook_post_id,
              COUNT(*) AS comment_count,
              MAX(c.created_at) AS last_comment_at,
              MAX(c.facebook_post_permalink) AS permalink
         FROM comments c
        WHERE c.page_id = ?
          AND c.facebook_post_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM content_mappings m
             WHERE m.facebook_page_id = c.page_id AND m.facebook_post_id = c.facebook_post_id)
        GROUP BY c.facebook_post_id
        ORDER BY last_comment_at DESC
        LIMIT 100`
    )
    .bind(pageId)
    .all();
  return result?.results ?? [];
}

export async function getMapping(db, id) {
  return (await db.prepare(`SELECT * FROM content_mappings WHERE id = ?`).bind(id).first()) ?? null;
}

/**
 * Create or replace the mapping for a post (one product per post/reel).
 * AM-2.5: no longer used by the admin API (create is insertMappingIfAbsent,
 * edits are updateMappingGuarded); kept for compatibility only.
 * @returns {Promise<number>} mapping id
 */
export async function upsertMapping(db, m) {
  const row = await db
    .prepare(
      `INSERT INTO content_mappings (facebook_page_id, facebook_post_id, facebook_content_type, product_id, active, note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(facebook_page_id, facebook_post_id) DO UPDATE SET
         facebook_content_type = excluded.facebook_content_type,
         product_id = excluded.product_id,
         active = excluded.active,
         note = excluded.note,
         updated_at = datetime('now')
       RETURNING id`
    )
    .bind(m.facebook_page_id, m.facebook_post_id, m.facebook_content_type, m.product_id, m.active, m.note)
    .first();
  return Number(row.id);
}

/* ----------------- AM-2.5 manual mapping safety helpers ----------------- */

/**
 * Every known physical source id of the logical subject `postId` belongs to
 * (AM-2.2 canonical Reel grouping, read from post_candidates). A post that
 * discovery has not seen -- or that has no canonical reel id -- is its own
 * subject: no sibling is guessed or fabricated.
 * @returns {Promise<string[]>} always includes postId
 */
export async function subjectSourcePostIds(db, pageId, postId) {
  const row = await db
    .prepare(`SELECT canonical_reel_id FROM post_candidates WHERE page_id = ? AND post_id = ? AND canonical_reel_id IS NOT NULL LIMIT 1`)
    .bind(pageId, postId)
    .first();
  if (!row?.canonical_reel_id) return [postId];
  const res = await db
    .prepare(`SELECT post_id FROM post_candidates WHERE page_id = ? AND canonical_reel_id = ?`)
    .bind(pageId, row.canonical_reel_id)
    .all();
  const ids = new Set([postId, ...(res?.results ?? []).map((r) => String(r.post_id))]);
  return [...ids];
}

/** Mapping rows (any state) on the given source ids, optionally excluding one mapping id. */
export async function mappingsForPosts(db, pageId, postIds, excludeId = null) {
  if (!postIds.length) return [];
  const marks = postIds.map(() => "?").join(",");
  const res = await db
    .prepare(
      `SELECT id, facebook_post_id, product_id, active FROM content_mappings
        WHERE facebook_page_id = ? AND facebook_post_id IN (${marks}) ${excludeId ? "AND id <> ?" : ""}`
    )
    .bind(pageId, ...postIds, ...(excludeId ? [excludeId] : []))
    .all();
  return res?.results ?? [];
}

/**
 * Create-only manual mapping (AM-2.5). One statement: the row is inserted only
 * if NO mapping (active or inactive) exists on any source id of the subject.
 * Never replaces an existing mapping (that is PATCH's job).
 * @returns {Promise<number|null>} new mapping id, or null when a mapping exists
 */
export async function insertMappingIfAbsent(db, m, sourcePostIds) {
  const ids = sourcePostIds.length ? sourcePostIds : [m.facebook_post_id];
  const marks = ids.map(() => "?").join(",");
  try {
    const row = await db
      .prepare(
        `INSERT INTO content_mappings (facebook_page_id, facebook_post_id, facebook_content_type, product_id, active, note)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM content_mappings WHERE facebook_page_id = ? AND facebook_post_id IN (${marks}))
         RETURNING id`
      )
      .bind(m.facebook_page_id, m.facebook_post_id, m.facebook_content_type, m.product_id, m.active, m.note, m.facebook_page_id, ...ids)
      .first();
    return row ? Number(row.id) : null;
  } catch (error) {
    if (/UNIQUE/i.test(String(error?.message))) return null; // lost a race: the exact post got mapped
    throw error;
  }
}

/**
 * Guarded PATCH (AM-2.5): one UPDATE statement. When the result is active, it
 * applies only if no OTHER active mapping exists on a sibling source id of the
 * same subject. Deactivation is never blocked by that guard.
 * @returns {Promise<number>} rows changed (0 = conflict or not found)
 */
export async function updateMappingGuarded(db, id, pageId, m, siblingPostIds) {
  const others = siblingPostIds.length ? siblingPostIds : ["__none__"];
  const marks = others.map(() => "?").join(",");
  const result = await db
    .prepare(
      `UPDATE content_mappings
          SET facebook_content_type = ?, product_id = ?, active = ?, note = ?, updated_at = datetime('now')
        WHERE id = ? AND facebook_page_id = ?
          AND (? = 0 OR NOT EXISTS (
                SELECT 1 FROM content_mappings o
                 WHERE o.facebook_page_id = ? AND o.id <> ? AND o.active = 1 AND o.facebook_post_id IN (${marks})))`
    )
    .bind(m.facebook_content_type, m.product_id, m.active, m.note, id, pageId, m.active, pageId, id, ...others)
    .run();
  return Number(result?.meta?.changes ?? 0);
}

export async function updateMapping(db, id, pageId, m) {
  const result = await db
    .prepare(
      `UPDATE content_mappings
          SET facebook_content_type = ?, product_id = ?, active = ?, note = ?, updated_at = datetime('now')
        WHERE id = ? AND facebook_page_id = ?`
    )
    .bind(m.facebook_content_type, m.product_id, m.active, m.note, id, pageId)
    .run();
  return Number(result?.meta?.changes ?? 0);
}

export async function deleteMapping(db, id, pageId) {
  const result = await db
    .prepare(`DELETE FROM content_mappings WHERE id = ? AND facebook_page_id = ?`)
    .bind(id, pageId)
    .run();
  return Number(result?.meta?.changes ?? 0);
}

/* ----------------------------- overview ---------------------------- */

export async function overviewStats(db, pageId) {
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM comments WHERE page_id = ?1) AS comments_received,
         (SELECT COUNT(*) FROM comments WHERE page_id = ?1 AND ai_action = 'REPLY') AS ai_replies,
         (SELECT COUNT(*) FROM comments WHERE page_id = ?1 AND status = 'SKIPPED') AS ai_skipped,
         (SELECT COUNT(*) FROM comments WHERE page_id = ?1 AND status = 'ERROR') AS errors,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id
            WHERE c.page_id = ?1 AND r.status = 'GENERATED') AS replies_generated,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id
            WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'GENERATED') AS replies_generated_live,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id
            WHERE c.page_id = ?1 AND r.mode = 'DRY_RUN' AND r.status = 'GENERATED') AS replies_generated_dry_run,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id
            WHERE c.page_id = ?1 AND r.status = 'SENT') AS replies_sent,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id
            WHERE c.page_id = ?1 AND r.mode = 'DRY_RUN' AND r.status = 'GENERATED') AS dry_run_replies,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id
            WHERE c.page_id = ?1 AND r.affiliate_url IS NOT NULL
              AND r.status IN ('GENERATED','SENT')) AS replies_with_link,
         (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL AND active = 1) AS products_active,
         (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL) AS products_total,
         (SELECT COUNT(*) FROM content_mappings WHERE facebook_page_id = ?1 AND active = 1) AS mappings_active,
         (SELECT COUNT(*) FROM content_mappings WHERE facebook_page_id = ?1) AS mappings_total`
    )
    .bind(pageId)
    .first();
  return counts ?? {};
}
