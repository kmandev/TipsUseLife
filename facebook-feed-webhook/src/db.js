/**
 * D1 access layer.
 *
 * EVERY statement is parameterized. User-controlled text (comment bodies,
 * author names, AI output) is never concatenated into SQL.
 */

/**
 * Idempotent insert.
 *
 * Race safety is delegated to the database: `facebook_comment_id` carries
 * a UNIQUE constraint, and `ON CONFLICT DO NOTHING RETURNING id` makes the
 * insert atomic. Two concurrent webhook deliveries for the same comment
 * therefore produce exactly one winner (a row id) and one loser (null),
 * with no read-then-write window.
 *
 * @returns {Promise<{id: number, duplicate: false} | {id: null, duplicate: true}>}
 */
export async function insertCommentIfNew(db, event) {
  const row = await db
    .prepare(
      `INSERT INTO comments (
         facebook_comment_id,
         facebook_post_id,
         facebook_parent_id,
         page_id,
         author_id,
         author_name,
         comment_text,
         facebook_created_time,
         facebook_post_permalink,
         status
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED')
       ON CONFLICT(facebook_comment_id) DO NOTHING
       RETURNING id`
    )
    .bind(
      event.comment_id,
      event.post_id,
      event.parent_id,
      event.page_id,
      event.author_id,
      event.author_name,
      event.comment_text,
      event.created_time,
      event.post_permalink ?? null
    )
    .first();

  if (row && row.id !== undefined && row.id !== null) {
    return { id: Number(row.id), duplicate: false };
  }

  return { id: null, duplicate: true };
}

/**
 * Active products used for matching. Bounded so a runaway table cannot
 * blow the Worker's memory or CPU budget.
 */
export async function listActiveProducts(db, limit = 500) {
  const result = await db
    .prepare(
      `SELECT id, name, description, keywords, shopee_url, affiliate_url,
              platform, active, deleted_at
         FROM products
        WHERE active = 1
          AND deleted_at IS NULL
        LIMIT ?`
    )
    .bind(limit)
    .all();

  return result?.results ?? [];
}

export async function updateCommentResult(
  db,
  commentId,
  { status, aiResponse, matchedProductId, productSource = null, aiAction = null }
) {
  await db
    .prepare(
      `UPDATE comments
          SET status = ?,
              ai_response = ?,
              matched_product_id = ?,
              product_source = ?,
              ai_action = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .bind(
      status,
      aiResponse ?? null,
      matchedProductId ?? null,
      productSource,
      aiAction,
      commentId
    )
    .run();
}

/**
 * The Dashboard mapping for one Facebook post/reel, with its product.
 * The product is returned even when inactive or deleted so the caller can
 * refuse it explicitly instead of silently falling back to another one.
 *
 * @returns {Promise<{product: any, contentType: string}|null>}
 */
export async function getMappedProduct(db, pageId, postId) {
  if (!postId) return null;
  const row = await db
    .prepare(
      `SELECT m.facebook_content_type AS content_type,
              p.id, p.name, p.description, p.keywords, p.shopee_url,
              p.affiliate_url, p.platform, p.active, p.deleted_at
         FROM content_mappings m
         JOIN products p ON p.id = m.product_id
        WHERE m.facebook_page_id = ?
          AND m.facebook_post_id = ?
          AND m.active = 1
        LIMIT 1`
    )
    .bind(pageId, postId)
    .first();

  if (!row) return null;
  const { content_type: contentType, ...product } = row;
  return { product, contentType: contentType || "POST" };
}

/** LIVE gate: has this comment already received a sent reply? */
export async function hasSentReply(db, commentRowId) {
  const row = await db
    .prepare(`SELECT 1 AS sent FROM replies WHERE comment_id = ? AND status = 'SENT' LIMIT 1`)
    .bind(commentRowId)
    .first();
  return Boolean(row);
}

/**
 * Link-spam guard: did the same author already get this exact affiliate
 * URL on the same post within the window (any mode)?
 */
export async function authorRecentlyGotLink(db, { pageId, postId, authorId, url, excludeCommentId, hours = 24 }) {
  if (!authorId || !postId || !url) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS hit
         FROM replies r
         JOIN comments c ON c.id = r.comment_id
        WHERE c.page_id = ?
          AND c.facebook_post_id = ?
          AND c.author_id = ?
          AND c.id != ?
          AND r.affiliate_url = ?
          AND r.status IN ('GENERATED', 'SENT')
          AND r.created_at >= datetime('now', ?)
        LIMIT 1`
    )
    .bind(pageId, postId, authorId, excludeCommentId ?? -1, url, `-${Number(hours)} hours`)
    .first();
  return Boolean(row);
}

export async function markCommentStatus(db, commentId, status) {
  await db
    .prepare(
      `UPDATE comments
          SET status = ?, updated_at = datetime('now')
        WHERE id = ?`
    )
    .bind(status, commentId)
    .run();
}

/**
 * Insert the reply record.
 *
 * `facebook_reply_id` is ALWAYS null in DRY_RUN -- it can only ever be
 * populated by a successful LIVE Graph API mutation.
 */
export async function insertReply(
  db,
  { commentId, responseText, mode, status, facebookReplyId, errorMessage, affiliateUrl = null }
) {
  await db
    .prepare(
      `INSERT INTO replies (
         comment_id,
         response_text,
         mode,
         facebook_reply_id,
         status,
         error_message,
         affiliate_url
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commentId,
      responseText ?? "",
      mode,
      facebookReplyId ?? null,
      status,
      errorMessage ?? null,
      affiliateUrl ?? null
    )
    .run();
}

/**
 * NEXT-02 -- admin comment list (read-only).
 *
 * Page-scoped, cursor-paginated, newest first.
 *
 * LATEST REPLY
 * ------------
 * A plain `LEFT JOIN replies` would multiply a comment by its reply
 * count. Instead the join is pinned to a single reply id chosen by a
 * correlated subquery, so each comment yields exactly one row whether it
 * has zero, one or many replies.
 *
 * PAGINATION
 * ----------
 * Keyset pagination on (created_at, id) DESC. The row-value comparison
 * is written out longhand -- `a < ? OR (a = ? AND b < ?)` -- which is
 * exactly equivalent to `(a, b) < (?, ?)` but avoids depending on SQLite
 * row-value support. Ordering by the same tuple the cursor carries is
 * what guarantees no gaps and no overlap between pages.
 *
 * INJECTION
 * ---------
 * The only strings interpolated into the SQL are fixed literals chosen by
 * this function. Every caller-supplied value -- page id, status, cursor
 * fields, limit -- is bound as a parameter.
 *
 * Indexes used: idx_comments_page_created (page scope + ordering),
 * idx_comments_status (status filter), idx_replies_comment (subquery).
 *
 * @param {any} db
 * @param {{pageId: string, status?: string|null, limit: number,
 *          cursor?: {created_at: string, id: number}|null}} options
 */
export async function listComments(db, { pageId, status = null, limit, cursor = null }) {
  const conditions = ["c.page_id = ?"];
  const params = [pageId];

  if (status) {
    conditions.push("c.status = ?");
    params.push(status);
  }

  if (cursor) {
    conditions.push("(c.created_at < ? OR (c.created_at = ? AND c.id < ?))");
    params.push(cursor.created_at, cursor.created_at, cursor.id);
  }

  params.push(limit);

  const result = await db
    .prepare(
      `SELECT
         c.id,
         c.facebook_comment_id,
         c.author_name,
         c.comment_text,
         c.status,
         c.ai_response,
         c.matched_product_id,
         c.product_source,
         c.ai_action,
         c.facebook_post_id,
         c.created_at,
         c.updated_at,
         p.id   AS product_id,
         p.name AS product_name,
         r.mode              AS reply_mode,
         r.status            AS reply_status,
         r.facebook_reply_id AS reply_facebook_reply_id,
         r.response_text     AS reply_text,
         r.error_message     AS reply_reason
       FROM comments c
       LEFT JOIN products p
         ON p.id = c.matched_product_id
       LEFT JOIN replies r
         ON r.id = (
              SELECT r2.id
                FROM replies r2
               WHERE r2.comment_id = c.id
               ORDER BY r2.created_at DESC, r2.id DESC
               LIMIT 1
            )
       WHERE ${conditions.join("\n         AND ")}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`
    )
    .bind(...params)
    .all();

  return result?.results ?? [];
}
