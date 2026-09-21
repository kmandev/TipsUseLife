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
         status
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED')
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
      event.created_time
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
      `SELECT id, name, description, keywords, shopee_url, active
         FROM products
        WHERE active = 1
        LIMIT ?`
    )
    .bind(limit)
    .all();

  return result?.results ?? [];
}

export async function updateCommentResult(db, commentId, { status, aiResponse, matchedProductId }) {
  await db
    .prepare(
      `UPDATE comments
          SET status = ?,
              ai_response = ?,
              matched_product_id = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .bind(status, aiResponse ?? null, matchedProductId ?? null, commentId)
    .run();
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
export async function insertReply(db, { commentId, responseText, mode, status, facebookReplyId, errorMessage }) {
  await db
    .prepare(
      `INSERT INTO replies (
         comment_id,
         response_text,
         mode,
         facebook_reply_id,
         status,
         error_message
       )
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commentId,
      responseText ?? "",
      mode,
      facebookReplyId ?? null,
      status,
      errorMessage ?? null
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
         c.created_at,
         c.updated_at,
         p.id   AS product_id,
         p.name AS product_name,
         r.mode              AS reply_mode,
         r.status            AS reply_status,
         r.facebook_reply_id AS reply_facebook_reply_id
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
