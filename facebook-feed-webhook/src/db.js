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
