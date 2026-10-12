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
 *
 * AM-2.6-B: both updates run in ONE D1 batch (a transaction): either the
 * product is soft-deleted AND all its mappings are switched off, or nothing
 * changes (a failure rolls both back and is thrown to the caller, as before).
 * The mapping update only applies when THIS call soft-deleted the product:
 * it is tied to the exact `deleted_at` stamp written by the first statement,
 * so calling this for an already-deleted product changes nothing (no
 * recovery behaviour). Returns the number of product rows soft-deleted
 * (0 or 1), as before.
 */
export async function softDeleteProduct(db, id) {
  // Same format as SQLite datetime('now') (UTC, "YYYY-MM-DD HH:MM:SS").
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const results = await db.batch([
    db
      .prepare(
        `UPDATE products
            SET active = 0, deleted_at = ?, updated_at = datetime('now')
          WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(stamp, id),
    db
      .prepare(
        `UPDATE content_mappings SET active = 0, updated_at = datetime('now')
          WHERE product_id = ?
            AND EXISTS (SELECT 1 FROM products WHERE id = ? AND deleted_at = ? AND active = 0)`
      )
      .bind(id, id, stamp),
  ]);
  return Number(results?.[0]?.meta?.changes ?? 0);
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

/* -------------- Upgrades U3-U6: insight queries (read-only) -------------- */
// All read-only SELECTs, page-scoped, every value bound. Day buckets use the
// Page's local day (Asia/Bangkok, UTC+7) so "today" matches the operator's.

export const LOCAL_TZ_OFFSET_HOURS = 7;
export const DAILY_RANGES = [7, 14, 30, 90];

/** "YYYY-MM-DD" of `date` in UTC+7. */
export function localDay(date) {
  return new Date(date.getTime() + LOCAL_TZ_OFFSET_HOURS * 3600e3).toISOString().slice(0, 10);
}

/** UTC "YYYY-MM-DD HH:MM:SS" of local midnight `day` (UTC+7). */
function localMidnightUtc(day) {
  const ms = Date.parse(day + "T00:00:00Z") - LOCAL_TZ_OFFSET_HOURS * 3600e3;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * U3: one row per local day for the last `days` days (oldest first, zero-filled).
 * @returns {Promise<Array<{day: string, comments: number, ai_replies: number, errors: number, sent: number, sent_with_link: number}>>}
 */
export async function dailyStats(db, pageId, days, now = new Date()) {
  const today = localDay(now);
  const startDay = localDay(new Date(Date.parse(today + "T12:00:00Z") - (days - 1) * 86400e3));
  const since = localMidnightUtc(startDay);
  const shift = `+${LOCAL_TZ_OFFSET_HOURS} hours`;
  const [c, r] = await Promise.all([
    db
      .prepare(
        `SELECT date(created_at, ?) AS day,
                COUNT(*) AS comments,
                SUM(CASE WHEN ai_action = 'REPLY' THEN 1 ELSE 0 END) AS ai_replies,
                SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS errors
           FROM comments
          WHERE page_id = ? AND created_at >= ?
          GROUP BY day`
      )
      .bind(shift, pageId, since)
      .all(),
    db
      .prepare(
        `SELECT date(r.created_at, ?) AS day,
                SUM(CASE WHEN r.status = 'SENT' THEN 1 ELSE 0 END) AS sent,
                SUM(CASE WHEN r.status = 'SENT' AND r.affiliate_url IS NOT NULL THEN 1 ELSE 0 END) AS sent_with_link
           FROM replies r JOIN comments c ON c.id = r.comment_id
          WHERE c.page_id = ? AND r.mode = 'LIVE' AND r.created_at >= ?
          GROUP BY day`
      )
      .bind(shift, pageId, since)
      .all(),
  ]);
  const byDay = new Map();
  for (const row of c?.results ?? []) byDay.set(row.day, { comments: Number(row.comments), ai_replies: Number(row.ai_replies), errors: Number(row.errors) });
  const sent = new Map((r?.results ?? []).map((row) => [row.day, row]));
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const day = localDay(new Date(Date.parse(startDay + "T12:00:00Z") + i * 86400e3));
    const a = byDay.get(day) || {};
    const b = sent.get(day) || {};
    out.push({
      day,
      comments: a.comments || 0,
      ai_replies: a.ai_replies || 0,
      errors: a.errors || 0,
      sent: Number(b.sent || 0),
      sent_with_link: Number(b.sent_with_link || 0),
    });
  }
  return out;
}

const COMMENT_COLUMNS = `c.id, c.facebook_comment_id, c.author_name, c.comment_text, c.status, c.ai_response,
         c.product_source, c.ai_action, c.facebook_post_id, c.created_at, c.updated_at,
         p.id AS product_id, p.name AS product_name,
         r.mode AS reply_mode, r.status AS reply_status, r.facebook_reply_id AS reply_facebook_reply_id,
         r.response_text AS reply_text, r.error_message AS reply_reason`;
const LATEST_REPLY_JOIN = `LEFT JOIN products p ON p.id = c.matched_product_id
       LEFT JOIN replies r ON r.id = (SELECT r2.id FROM replies r2 WHERE r2.comment_id = c.id ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)`;

/** Same public shape as GET /admin/comments (admin.js mapRow): never author_id. */
export function mapCommentRow(row) {
  const hasReply = row.reply_mode !== null && row.reply_mode !== undefined;
  return {
    id: Number(row.id),
    facebook_comment_id: row.facebook_comment_id ?? null,
    author_name: row.author_name ?? null,
    comment_text: row.comment_text ?? null,
    status: row.status,
    matched_product: row.product_id !== null && row.product_id !== undefined ? { id: Number(row.product_id), name: row.product_name ?? null } : null,
    product_source: row.product_source ?? null,
    ai_action: row.ai_action ?? null,
    facebook_post_id: row.facebook_post_id ?? null,
    ai_response: row.ai_response ?? null,
    reply: hasReply
      ? { mode: row.reply_mode, status: row.reply_status ?? null, facebook_reply_id: row.reply_facebook_reply_id ?? null, response_text: row.reply_text ?? null, reason: row.reply_reason ?? null }
      : null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => "\\" + m);

/**
 * U4: search comments. Filters are AND-ed; `q` matches comment text, author
 * name (LIKE) or an exact comment id. Newest first; cursor = last id.
 */
export async function searchComments(db, { pageId, q = null, status = null, from = null, to = null, postId = null, beforeId = null, limit }) {
  const where = ["c.page_id = ?"];
  const params = [pageId];
  if (q) {
    where.push("(c.comment_text LIKE ? ESCAPE '\\' OR c.author_name LIKE ? ESCAPE '\\' OR c.facebook_comment_id = ?)");
    const like = "%" + likeEscape(q) + "%";
    params.push(like, like, q);
  }
  if (status) { where.push("c.status = ?"); params.push(status); }
  if (from) { where.push("c.created_at >= ?"); params.push(localMidnightUtc(from)); }
  if (to) {
    const next = localDay(new Date(Date.parse(to + "T12:00:00Z") + 86400e3));
    where.push("c.created_at < ?"); params.push(localMidnightUtc(next));
  }
  if (postId) { where.push("c.facebook_post_id = ?"); params.push(postId); }
  if (beforeId) { where.push("c.id < ?"); params.push(beforeId); }
  params.push(limit);
  const res = await db
    .prepare(`SELECT ${COMMENT_COLUMNS} FROM comments c ${LATEST_REPLY_JOIN} WHERE ${where.join(" AND ")} ORDER BY c.id DESC LIMIT ?`)
    .bind(...params)
    .all();
  return (res?.results ?? []).map(mapCommentRow);
}

/** U6: one comment with its full reply history and post mapping (no author_id). */
export async function commentDetail(db, pageId, id) {
  const row = await db
    .prepare(`SELECT ${COMMENT_COLUMNS}, c.facebook_parent_id, c.facebook_created_time, c.facebook_post_permalink
                FROM comments c ${LATEST_REPLY_JOIN} WHERE c.page_id = ? AND c.id = ?`)
    .bind(pageId, id)
    .first();
  if (!row) return null;
  const [replies, mapping] = await Promise.all([
    db
      .prepare(
        `SELECT id, mode, status, error_message AS reason, response_text, affiliate_url, facebook_reply_id, created_at
           FROM replies WHERE comment_id = ? ORDER BY created_at ASC, id ASC`
      )
      .bind(id)
      .all(),
    row.facebook_post_id
      ? db
          .prepare(
            `SELECT m.id, m.active, m.facebook_content_type, p.id AS product_id, p.name AS product_name, p.active AS product_active, p.deleted_at AS product_deleted_at
               FROM content_mappings m JOIN products p ON p.id = m.product_id
              WHERE m.facebook_page_id = ? AND m.facebook_post_id = ? LIMIT 1`
          )
          .bind(pageId, row.facebook_post_id)
          .first()
      : null,
  ]);
  return {
    ...mapCommentRow(row),
    facebook_parent_id: row.facebook_parent_id ?? null,
    facebook_created_time: row.facebook_created_time ?? null,
    facebook_post_permalink: row.facebook_post_permalink ?? null,
    replies: (replies?.results ?? []).map((r) => ({ ...r, id: Number(r.id) })),
    mapping: mapping
      ? { id: Number(mapping.id), active: Number(mapping.active), content_type: mapping.facebook_content_type, product_id: Number(mapping.product_id), product_name: mapping.product_name, product_usable: Number(mapping.product_active) === 1 && !mapping.product_deleted_at }
      : null,
  };
}

/** U5: per-post performance (posts that received comments), most commented first. */
export async function postPerformance(db, pageId, limit = 500) {
  const res = await db
    .prepare(
      `SELECT c.facebook_post_id AS post_id,
              COUNT(*) AS comments,
              SUM(CASE WHEN c.ai_action = 'REPLY' THEN 1 ELSE 0 END) AS ai_replies,
              SUM(CASE WHEN c.status = 'ERROR' THEN 1 ELSE 0 END) AS errors,
              (SELECT COUNT(*) FROM replies r JOIN comments c2 ON c2.id = r.comment_id
                WHERE c2.page_id = c.page_id AND c2.facebook_post_id = c.facebook_post_id AND r.mode = 'LIVE' AND r.status = 'SENT') AS sent,
              (SELECT COUNT(*) FROM replies r JOIN comments c2 ON c2.id = r.comment_id
                WHERE c2.page_id = c.page_id AND c2.facebook_post_id = c.facebook_post_id AND r.mode = 'LIVE' AND r.status = 'SENT' AND r.affiliate_url IS NOT NULL) AS sent_with_link,
              MAX(c.created_at) AS last_comment_at,
              MAX(c.facebook_post_permalink) AS permalink,
              (SELECT m.active FROM content_mappings m WHERE m.facebook_page_id = c.page_id AND m.facebook_post_id = c.facebook_post_id LIMIT 1) AS mapping_active,
              (SELECT p.name FROM content_mappings m JOIN products p ON p.id = m.product_id
                WHERE m.facebook_page_id = c.page_id AND m.facebook_post_id = c.facebook_post_id LIMIT 1) AS product_name
         FROM comments c
        WHERE c.page_id = ? AND c.facebook_post_id IS NOT NULL
        GROUP BY c.facebook_post_id
        ORDER BY comments DESC, last_comment_at DESC
        LIMIT ?`
    )
    .bind(pageId, limit)
    .all();
  return (res?.results ?? []).map((r) => ({
    ...r,
    comments: Number(r.comments), ai_replies: Number(r.ai_replies), errors: Number(r.errors),
    sent: Number(r.sent), sent_with_link: Number(r.sent_with_link),
    mapping_active: r.mapping_active === null || r.mapping_active === undefined ? null : Number(r.mapping_active),
  }));
}

/** U5: per-product performance, from the product each comment resolved to. */
export async function productPerformance(db, pageId) {
  const res = await db
    .prepare(
      `SELECT p.id AS product_id, p.name, p.active, p.deleted_at,
              (SELECT COUNT(*) FROM content_mappings m WHERE m.facebook_page_id = ?1 AND m.product_id = p.id AND m.active = 1) AS mapped_posts,
              (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1 AND c.matched_product_id = p.id) AS comments,
              (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1 AND c.matched_product_id = p.id AND c.ai_action = 'REPLY') AS ai_replies,
              (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id
                WHERE c.page_id = ?1 AND c.matched_product_id = p.id AND r.mode = 'LIVE' AND r.status = 'SENT') AS sent,
              (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id
                WHERE c.page_id = ?1 AND c.matched_product_id = p.id AND r.mode = 'LIVE' AND r.status = 'SENT' AND r.affiliate_url IS NOT NULL) AS sent_with_link
         FROM products p
        ORDER BY comments DESC, p.id DESC
        LIMIT 500`
    )
    .bind(pageId)
    .all();
  return (res?.results ?? [])
    .map((r) => ({ ...r, product_id: Number(r.product_id), active: Number(r.active), mapped_posts: Number(r.mapped_posts), comments: Number(r.comments), ai_replies: Number(r.ai_replies), sent: Number(r.sent), sent_with_link: Number(r.sent_with_link) }))
    .filter((r) => !r.deleted_at || r.comments > 0);
}

/* ------------------------ Upgrade U8: admin audit ------------------------ */

export const AUDIT_ACTIONS = Object.freeze([
  "PRODUCT_CREATE", "PRODUCT_UPDATE", "PRODUCT_TOGGLE", "PRODUCT_DELETE",
  "MAPPING_CREATE", "MAPPING_UPDATE", "MAPPING_DELETE",
  "SUGGESTION_APPROVE", "SUGGESTION_REJECT",
  "COMMENT_RETRY", "COMMENT_RECONCILE",
]);
const AUDIT_FIELDS = {
  PRODUCT: ["name", "platform", "affiliate_url", "active", "deleted_at"],
  MAPPING: ["facebook_post_id", "facebook_content_type", "product_id", "active", "note"],
  SUGGESTION: ["status", "product_id", "post_id", "mapping_post_id", "idempotent"],
  COMMENT: ["status", "reason", "outcome", "detail"],
};

/** Keep only whitelisted business fields (never tokens or comment text). */
export function auditSnapshot(targetType, obj) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const k of AUDIT_FIELDS[targetType] || []) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length ? out : null;
}

/**
 * Append one audit row. Best-effort by design: a failure here (for example
 * before migration 0007 is applied) is logged by the caller's logEvent path
 * and NEVER fails or undoes the admin action itself.
 * @returns {Promise<boolean>}
 */
export async function recordAudit(db, { pageId, action, targetType, targetId = null, before = null, after = null }) {
  try {
    const b = auditSnapshot(targetType, before);
    const a = auditSnapshot(targetType, after);
    await db
      .prepare(`INSERT INTO admin_audit (page_id, action, target_type, target_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(pageId, action, targetType, targetId, b ? JSON.stringify(b) : null, a ? JSON.stringify(a) : null)
      .run();
    return true;
  } catch {
    return false;
  }
}

/** Newest first, id cursor. Missing table (pre-migration) -> []. */
export async function listAudit(db, pageId, { beforeId = null, limit = 25, targetType = null } = {}) {
  const where = ["page_id = ?"];
  const params = [pageId];
  if (targetType) { where.push("target_type = ?"); params.push(targetType); }
  if (beforeId) { where.push("id < ?"); params.push(beforeId); }
  params.push(limit);
  try {
    const res = await db
      .prepare(`SELECT id, action, target_type, target_id, before_json, after_json, created_at FROM admin_audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .bind(...params)
      .all();
    const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
    return { available: true, rows: (res?.results ?? []).map((r) => ({ id: Number(r.id), action: r.action, target_type: r.target_type, target_id: r.target_id === null ? null : Number(r.target_id), before: parse(r.before_json), after: parse(r.after_json), created_at: r.created_at })) };
  } catch {
    return { available: false, rows: [] };
  }
}
