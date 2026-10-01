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
 * LIVE gate (defence in depth on top of the comment dedupe): has ANY LIVE
 * send attempt ever been recorded for this comment? A LIVE row in
 * GENERATED (attempt started / outcome unknown), SENT or FAILED state all
 * count -- only a LIVE SKIPPED row (nothing was sent) does not.
 */
export async function hasLiveSendAttempt(db, commentRowId) {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM replies
        WHERE comment_id = ? AND mode = 'LIVE' AND status IN ('GENERATED', 'SENT', 'FAILED')
        LIMIT 1`
    )
    .bind(commentRowId)
    .first();
  return Boolean(row);
}

/**
 * Self-reply protection, layer 2 (layer 1 is the author == Page check):
 * is this webhook event one of OUR OWN replies, or nested directly under
 * one? Our replies are known by the facebook_reply_id Graph returned.
 */
export async function isOwnReplyEvent(db, { commentId, parentId }) {
  const ids = [commentId, parentId].filter((v) => typeof v === "string" && v.length > 0);
  if (ids.length === 0) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM replies
        WHERE facebook_reply_id IS NOT NULL
          AND facebook_reply_id IN (${ids.map(() => "?").join(", ")})
        LIMIT 1`
    )
    .bind(...ids)
    .first();
  return Boolean(row);
}

/**
 * Possible-own-echo guard (Phase 8.9, "layer 2.5"). Read-only.
 *
 * Finds a LIVE send attempt on this Page whose Facebook reply id is NOT
 * known -- so layer 2 cannot recognise its echo -- posted into `threadId`
 * within the last `windowSeconds`. Covered states (facebook_reply_id NULL):
 *   GENERATED + GRAPH_SEND_IN_PROGRESS   (send started, outcome not recorded)
 *   GENERATED + GRAPH_OUTCOME_UNKNOWN:*  (timeout / network / 5xx)
 *   SENT      + SENT_ID_UNPARSEABLE      (reply exists, id unreadable)
 * DRY_RUN, FAILED, SKIPPED and rows with a stored reply id never match.
 *
 * THREAD of a stored comment = where its reply was posted (replyTargetId):
 * the parent when the parent is not the post itself (nested reply), else
 * the comment's own id (top-level). Compared against the incoming event's
 * thread, computed the same way. Deterministic ids only; no message text.
 *
 * WINDOW, inclusive on both ends: now - windowSeconds <= created_at <= now.
 * Without `now` the D1 clock (datetime('now')) is used -- the same clock
 * that wrote created_at, so Worker/D1 clock skew cannot hide a fresh row.
 * Tests pass `now` ("YYYY-MM-DD HH:MM:SS", UTC) for exact boundaries.
 *
 * @param {any} db
 * @param {{pageId: string, threadId: string, windowSeconds: number, now?: string|null}} args
 * @returns {Promise<string|null>} the matched state, or null
 */
export async function findUnattributedLiveAttemptInThread(db, { pageId, threadId, windowSeconds, now = null }) {
  if (typeof pageId !== "string" || !pageId || typeof threadId !== "string" || !threadId) return null;
  const seconds = Number(windowSeconds);
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("INVALID_ECHO_GUARD_WINDOW");
  const row = await db
    .prepare(
      `SELECT CASE
                WHEN r.status = 'SENT' THEN 'SENT_ID_UNPARSEABLE'
                WHEN r.error_message = 'GRAPH_SEND_IN_PROGRESS' THEN 'GRAPH_SEND_IN_PROGRESS'
                ELSE 'GRAPH_OUTCOME_UNKNOWN'
              END AS state
         FROM replies r
         JOIN comments c ON c.id = r.comment_id
        WHERE c.page_id = ?1
          AND r.mode = 'LIVE'
          AND r.facebook_reply_id IS NULL
          AND (   (r.status = 'GENERATED' AND r.error_message = 'GRAPH_SEND_IN_PROGRESS')
               OR (r.status = 'GENERATED' AND r.error_message LIKE 'GRAPH_OUTCOME_UNKNOWN:%')
               OR (r.status = 'SENT'      AND r.error_message = 'SENT_ID_UNPARSEABLE'))
          AND (CASE
                 WHEN c.facebook_parent_id IS NOT NULL
                      AND (c.facebook_post_id IS NULL OR c.facebook_parent_id <> c.facebook_post_id)
                   THEN c.facebook_parent_id
                 ELSE c.facebook_comment_id
               END) = ?2
          AND r.created_at >= datetime(COALESCE(?3, datetime('now')), ?4)
          AND r.created_at <= datetime(COALESCE(?3, datetime('now')))
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1`
    )
    .bind(pageId, threadId, now, `-${seconds} seconds`)
    .first();
  return row?.state ?? null;
}

/** Boolean form of findUnattributedLiveAttemptInThread. */
export async function hasUnattributedLiveAttemptInThread(db, args) {
  return (await findUnattributedLiveAttemptInThread(db, args)) !== null;
}

/**
 * LIVE send marker. Written BEFORE the Graph request so an attempt can
 * never disappear silently. State model (no schema change -- the CHECK
 * constraint allows GENERATED/SENT/FAILED/SKIPPED only):
 *
 *   mode=LIVE status=GENERATED error=GRAPH_SEND_IN_PROGRESS  attempt started
 *   mode=LIVE status=SENT                                    confirmed success
 *   mode=LIVE status=FAILED    error=GRAPH_REJECTED_<4xx>    confirmed NOT sent
 *   mode=LIVE status=GENERATED error=GRAPH_OUTCOME_UNKNOWN:* ambiguous
 *
 * An attempt left at GENERATED is NEVER "unsent": it may exist on Facebook.
 * @returns {Promise<number>} the reply row id
 */
export async function insertLiveSendMarker(db, { commentId, responseText, affiliateUrl = null }) {
  const row = await db
    .prepare(
      `INSERT INTO replies (comment_id, response_text, mode, facebook_reply_id, status, error_message, affiliate_url)
       VALUES (?, ?, 'LIVE', NULL, 'GENERATED', 'GRAPH_SEND_IN_PROGRESS', ?)
       RETURNING id`
    )
    .bind(commentId, responseText ?? "", affiliateUrl)
    .first();
  if (!row || row.id === undefined || row.id === null) throw new Error("MARKER_NOT_WRITTEN");
  return Number(row.id);
}

/**
 * Move a LIVE marker to its final state. Only a row still in the
 * "attempt started" state can move, so a finished outcome is never
 * overwritten.
 */
export async function finalizeLiveSend(db, replyRowId, { status, facebookReplyId = null, errorMessage = null }) {
  if (!["SENT", "FAILED", "GENERATED"].includes(status)) throw new Error("INVALID_FINAL_STATUS");
  const result = await db
    .prepare(
      `UPDATE replies
          SET status = ?, facebook_reply_id = ?, error_message = ?
        WHERE id = ? AND mode = 'LIVE' AND status = 'GENERATED'
          AND error_message = 'GRAPH_SEND_IN_PROGRESS'`
    )
    .bind(status, facebookReplyId, errorMessage, replyRowId)
    .run();
  if (!result?.meta || Number(result.meta.changes) !== 1) throw new Error("MARKER_NOT_FINALIZED");
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

/* ===================================================================
 * Phase 8.36 -- ambiguous-send reconciliation (read model + one CAS).
 * No schema change: provenance is recorded as error_message
 * 'RECONCILED:<previous value>' on the existing replies row.
 * =================================================================== */

/**
 * Everything reconciliation needs for one comment row: the comment and
 * ALL of its reply rows (eligibility is decided by the caller).
 * @returns {Promise<null | {comment: any, replies: any[]}>}
 */
export async function getReconcileCandidate(db, commentRowId) {
  const comment = await db
    .prepare(
      `SELECT id, page_id, facebook_comment_id, facebook_post_id, facebook_parent_id,
              author_id, status, created_at
         FROM comments WHERE id = ?`
    )
    .bind(commentRowId)
    .first();
  if (!comment) return null;
  const result = await db
    .prepare(
      `SELECT id, comment_id, mode, status, facebook_reply_id, error_message,
              response_text, affiliate_url, created_at
         FROM replies WHERE comment_id = ? ORDER BY id`
    )
    .bind(commentRowId)
    .all();
  return { comment, replies: result?.results ?? [] };
}

/** Which of `ids` are already stored as a facebook_reply_id on any reply row. */
export async function findLinkedFacebookReplyIds(db, ids) {
  const list = [...new Set((ids || []).filter((v) => typeof v === "string" && v.length > 0))];
  if (list.length === 0) return new Set();
  const result = await db
    .prepare(`SELECT facebook_reply_id FROM replies WHERE facebook_reply_id IN (${list.map(() => "?").join(", ")})`)
    .bind(...list)
    .all();
  return new Set((result?.results ?? []).map((r) => String(r.facebook_reply_id)));
}

/**
 * The ONE reconciliation write: an ambiguous LIVE attempt becomes SENT with
 * the Facebook reply id Facebook already created. Compare-and-set: only a
 * row still ambiguous and unlinked can move, and never if that Facebook
 * reply id is already linked to any other row. Exactly one concurrent
 * caller can win.
 * @returns {Promise<boolean>} true only if exactly this row changed
 */
export async function reconcileAmbiguousSend(db, replyRowId, facebookReplyId) {
  if (typeof facebookReplyId !== "string" || !facebookReplyId) throw new Error("INVALID_FACEBOOK_REPLY_ID");
  const result = await db
    .prepare(
      `UPDATE replies
          SET status = 'SENT',
              facebook_reply_id = ?1,
              error_message = 'RECONCILED:' || error_message
        WHERE id = ?2
          AND mode = 'LIVE'
          AND status = 'GENERATED'
          AND facebook_reply_id IS NULL
          AND (error_message = 'GRAPH_SEND_IN_PROGRESS' OR error_message LIKE 'GRAPH_OUTCOME_UNKNOWN:%')
          AND NOT EXISTS (SELECT 1 FROM replies o WHERE o.facebook_reply_id = ?1 AND o.id != ?2)`
    )
    .bind(facebookReplyId, replyRowId)
    .run();
  return Number(result?.meta?.changes ?? 0) === 1;
}

/**
 * After a successful reconciliation: ERROR/RECEIVED -> REPLIED. A comment
 * that is already REPLIED (the 2xx-but-unrecorded case) is left as is.
 * @returns {Promise<string|null>} the comment status afterwards
 */
export async function markCommentReconciled(db, commentRowId) {
  await db
    .prepare(
      `UPDATE comments SET status = 'REPLIED', updated_at = datetime('now')
        WHERE id = ? AND status IN ('ERROR', 'RECEIVED')`
    )
    .bind(commentRowId)
    .run();
  const row = await db.prepare(`SELECT status FROM comments WHERE id = ?`).bind(commentRowId).first();
  return row?.status ?? null;
}
