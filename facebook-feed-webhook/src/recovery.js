/**
 * Phase 8.2 -- operator-triggered recovery and operational health.
 *
 * ONE eligibility rule (recoveryReasonSql) is used by the retry endpoint,
 * the atomic claim, the dashboard list and the health counts, so they can
 * never disagree. It is evaluated from the REPLY rows, never from
 * comments.status alone.
 *
 * A comment is recoverable (reason = ELIGIBLE) only when:
 *   - it is younger than 24 h, AND
 *   - it has NO reply row, except exactly one LIVE SKIPPED
 *     "SEND_BUDGET_EXHAUSTED" row (nothing was sent), AND
 *   - status = ERROR, or status = RECEIVED for more than 2 minutes and not
 *     touched in the last 2 minutes (i.e. not currently being processed or
 *     claimed).
 *
 * PROTECTED forever from recovery (Phase 8.1 B1 semantics):
 *   - LIVE GENERATED + GRAPH_OUTCOME_UNKNOWN:*  (may exist on Facebook)
 *   - LIVE GENERATED + GRAPH_SEND_IN_PROGRESS   (may exist on Facebook)
 *   - LIVE SENT, LIVE FAILED, any DRY_RUN row, any other reply state.
 *
 * No scheduled/automatic recovery exists. No Graph retry exists.
 * No schema change: everything is derived from existing columns.
 */

import { runPersistedComment, isOwnReplyEventFailClosed, OUTCOMES } from "./pipeline.js";
import { logEvent, logError } from "./log.js";

export const RECOVERY_WINDOW = "-24 hours";
export const STALE_RECEIVED = "-2 minutes";

export const RECOVERY_REASONS = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  PROTECTED_AMBIGUOUS_SEND: "PROTECTED_AMBIGUOUS_SEND",
  PROTECTED_SEND_IN_PROGRESS: "PROTECTED_SEND_IN_PROGRESS",
  ALREADY_SENT: "ALREADY_SENT",
  PROTECTED_GRAPH_FAILED: "PROTECTED_GRAPH_FAILED",
  EXISTING_REPLY: "EXISTING_REPLY",
  UNEXPECTED_REPLY_STATE: "UNEXPECTED_REPLY_STATE",
  TOO_OLD: "TOO_OLD",
  RECENT_RECEIVED: "RECENT_RECEIVED",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  NOT_ELIGIBLE_STATUS: "NOT_ELIGIBLE_STATUS",
});

/** Reasons where a human must check the Facebook post; never retry. */
export const CHECK_FACEBOOK_REASONS = Object.freeze([
  RECOVERY_REASONS.PROTECTED_AMBIGUOUS_SEND,
  RECOVERY_REASONS.PROTECTED_SEND_IN_PROGRESS,
]);

/**
 * The single eligibility rule as a SQL expression over the comments row
 * named `t` (a table name or alias). Order matters: protections first.
 */
export function recoveryReasonSql(t = "c") {
  const r = (cond) => `EXISTS (SELECT 1 FROM replies rr WHERE rr.comment_id = ${t}.id AND ${cond})`;
  const budgetRow = `rr.mode = 'LIVE' AND rr.status = 'SKIPPED' AND rr.error_message = 'SEND_BUDGET_EXHAUSTED'`;
  return `CASE
    WHEN ${r(`rr.mode = 'LIVE' AND rr.status = 'GENERATED' AND rr.error_message LIKE 'GRAPH_OUTCOME_UNKNOWN%'`)} THEN 'PROTECTED_AMBIGUOUS_SEND'
    WHEN ${r(`rr.mode = 'LIVE' AND rr.status = 'GENERATED' AND rr.error_message = 'GRAPH_SEND_IN_PROGRESS'`)} THEN 'PROTECTED_SEND_IN_PROGRESS'
    WHEN ${r(`rr.mode = 'LIVE' AND rr.status = 'SENT'`)} THEN 'ALREADY_SENT'
    WHEN ${r(`rr.mode = 'LIVE' AND rr.status = 'FAILED'`)} THEN 'PROTECTED_GRAPH_FAILED'
    WHEN ${r(`rr.mode = 'DRY_RUN'`)} THEN 'EXISTING_REPLY'
    WHEN ${r(`NOT (${budgetRow})`)} THEN 'UNEXPECTED_REPLY_STATE'
    WHEN (SELECT COUNT(*) FROM replies rr WHERE rr.comment_id = ${t}.id) > 1 THEN 'UNEXPECTED_REPLY_STATE'
    WHEN ${t}.created_at < datetime('now', '${RECOVERY_WINDOW}') THEN 'TOO_OLD'
    WHEN ${t}.status = 'ERROR' THEN 'ELIGIBLE'
    WHEN ${t}.status = 'RECEIVED' AND ${t}.updated_at > ${t}.created_at
         AND ${t}.updated_at > datetime('now', '${STALE_RECEIVED}') THEN 'ALREADY_CLAIMED'
    WHEN ${t}.status = 'RECEIVED' AND (${t}.created_at > datetime('now', '${STALE_RECEIVED}')
         OR ${t}.updated_at > datetime('now', '${STALE_RECEIVED}')) THEN 'RECENT_RECEIVED'
    WHEN ${t}.status = 'RECEIVED' THEN 'ELIGIBLE'
    ELSE 'NOT_ELIGIBLE_STATUS'
  END`;
}

/** What the dashboard should offer for a given reason. */
export function recoveryAction(reason) {
  if (reason === RECOVERY_REASONS.ELIGIBLE) return "RETRY";
  if (CHECK_FACEBOOK_REASONS.includes(reason)) return "CHECK_FACEBOOK_NO_RETRY";
  return "NONE";
}

/** @returns {Promise<null | {row: any, reason: string}>} */
export async function getRecoveryState(db, commentRowId, pageId) {
  const row = await db
    .prepare(
      `SELECT c.id, c.facebook_comment_id, c.facebook_post_id, c.facebook_parent_id, c.page_id,
              c.author_id, c.author_name, c.comment_text, c.facebook_created_time,
              c.facebook_post_permalink, c.status, c.created_at, c.updated_at,
              ${recoveryReasonSql("c")} AS recovery_reason
         FROM comments c
        WHERE c.id = ? AND c.page_id = ?`
    )
    .bind(commentRowId, pageId)
    .first();
  if (!row) return null;
  return { row, reason: row.recovery_reason };
}

/**
 * Atomic claim: moves an ELIGIBLE comment to RECEIVED with a fresh
 * updated_at. The same statement re-checks the eligibility rule, so of two
 * concurrent claims exactly one changes a row; the other sees
 * ALREADY_CLAIMED. No delete/reinsert.
 * @returns {Promise<boolean>}
 */
export async function claimForRecovery(db, commentRowId, pageId) {
  const result = await db
    .prepare(
      `UPDATE comments
          SET status = 'RECEIVED', updated_at = datetime('now', '+1 second')
        WHERE id = ? AND page_id = ?
          AND (${recoveryReasonSql("comments")}) = 'ELIGIBLE'`
    )
    .bind(commentRowId, pageId)
    .run();
  return Number(result?.meta?.changes ?? 0) === 1;
}

/** Rebuild the normalized event from the persisted comment row. */
export function eventFromRow(row) {
  return {
    page_id: String(row.page_id ?? ""),
    comment_id: row.facebook_comment_id,
    post_id: row.facebook_post_id ?? null,
    parent_id: row.facebook_parent_id ?? null,
    author_id: row.author_id ?? null,
    author_name: row.author_name ?? null,
    comment_text: row.comment_text ?? "",
    created_time: row.facebook_created_time ?? null,
    post_permalink: row.facebook_post_permalink ?? null,
  };
}

/**
 * Operator recovery of ONE comment. Never automatic; never retries Graph.
 * @returns {Promise<{status: string, reason?: string, outcome?: string, outcomeReason?: string}>}
 *   status: RECOVERED | NOT_FOUND | NOT_ELIGIBLE | ALREADY_CLAIMED
 */
export async function recoverComment(commentRowId, { db, env, config }) {
  const state = await getRecoveryState(db, commentRowId, config.pageId);
  if (!state) return { status: "NOT_FOUND" };
  if (state.reason !== RECOVERY_REASONS.ELIGIBLE) {
    return {
      status: state.reason === RECOVERY_REASONS.ALREADY_CLAIMED ? "ALREADY_CLAIMED" : "NOT_ELIGIBLE",
      reason: state.reason,
    };
  }

  const event = eventFromRow(state.row);
  // Same checks the webhook path applies before any work.
  if (event.page_id !== config.pageId) return { status: "NOT_ELIGIBLE", reason: "PAGE_ID_MISMATCH" };
  if (await isOwnReplyEventFailClosed(db, event)) return { status: "NOT_ELIGIBLE", reason: "OWN_REPLY_EVENT" };

  if (!(await claimForRecovery(db, commentRowId, config.pageId))) {
    const again = await getRecoveryState(db, commentRowId, config.pageId);
    return { status: "ALREADY_CLAIMED", reason: again?.reason ?? RECOVERY_REASONS.ALREADY_CLAIMED };
  }

  logEvent("recovery_started", { comment_row_id: commentRowId, comment_id: event.comment_id, mode: config.mode });
  let result;
  try {
    // Same Idempotency-Key namespace as the webhook path (fbc:<comment_id>),
    // set inside runPersistedComment.
    result = await runPersistedComment(event, commentRowId, { db, env, config, startedAt: Date.now() });
  } catch {
    logError("recovery_failed", "UNHANDLED_EXCEPTION", { comment_row_id: commentRowId });
    return { status: "RECOVERED", outcome: OUTCOMES.ERROR, outcomeReason: "UNHANDLED_EXCEPTION" };
  }
  logEvent("recovery_finished", { comment_row_id: commentRowId, outcome: result?.outcome ?? null, reason: result?.reason ?? null });
  return { status: "RECOVERED", outcome: result?.outcome ?? null, outcomeReason: result?.reason ?? null };
}

/**
 * Rows needing operator attention: ERROR/RECEIVED comments (any age, so
 * historical ones stay visible as TOO_OLD) and any comment with a LIVE
 * GENERATED/FAILED reply. Newest first, bounded.
 */
export async function listRecoveryAttention(db, pageId, limit = 50) {
  const result = await db
    .prepare(
      `SELECT c.id, c.facebook_comment_id, c.facebook_post_id, c.status, c.created_at, c.updated_at,
              (SELECT rr.mode FROM replies rr WHERE rr.comment_id = c.id ORDER BY rr.id DESC LIMIT 1) AS reply_mode,
              (SELECT rr.status FROM replies rr WHERE rr.comment_id = c.id ORDER BY rr.id DESC LIMIT 1) AS reply_status,
              (SELECT rr.error_message FROM replies rr WHERE rr.comment_id = c.id ORDER BY rr.id DESC LIMIT 1) AS reply_reason,
              ${recoveryReasonSql("c")} AS recovery_reason
         FROM comments c
        WHERE c.page_id = ?
          AND (c.status IN ('ERROR', 'RECEIVED')
               OR EXISTS (SELECT 1 FROM replies rr WHERE rr.comment_id = c.id
                           AND rr.mode = 'LIVE' AND rr.status IN ('GENERATED', 'FAILED')))
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?`
    )
    .bind(pageId, Math.max(1, Math.min(200, Number(limit) || 50)))
    .all();
  return (result?.results ?? []).map((row) => ({
    id: Number(row.id),
    facebook_comment_id: row.facebook_comment_id ?? null,
    facebook_post_id: row.facebook_post_id ?? null,
    status: row.status,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    reply: row.reply_status ? { mode: row.reply_mode, status: row.reply_status, reason: row.reply_reason ?? null } : null,
    recovery: { reason: row.recovery_reason, eligible: row.recovery_reason === RECOVERY_REASONS.ELIGIBLE, action: recoveryAction(row.recovery_reason) },
  }));
}

/** Operational counts from existing columns only. No URLs, text or secrets. */
export async function healthStats(db, pageId) {
  const expr = recoveryReasonSql("c");
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1) AS comments_total,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1) AS replies_total,
         (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1 AND c.status = 'ERROR') AS errors_total,
         (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1 AND c.status = 'ERROR' AND c.created_at >= datetime('now', '-1 hour')) AS errors_1h,
         (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1 AND c.status = 'ERROR' AND c.created_at >= datetime('now', '-24 hours')) AS errors_24h,
         (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1 AND c.status = 'ERROR' AND (${expr}) = 'ELIGIBLE') AS recoverable_errors,
         (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1 AND c.status = 'RECEIVED' AND (${expr}) = 'ELIGIBLE') AS recoverable_stale_received,
         (SELECT COUNT(*) FROM comments c WHERE c.page_id = ?1 AND c.status = 'RECEIVED' AND c.created_at <= datetime('now', '${STALE_RECEIVED}')) AS stale_received,
         (SELECT MIN(c.created_at) FROM comments c WHERE c.page_id = ?1 AND c.status = 'RECEIVED' AND c.created_at <= datetime('now', '${STALE_RECEIVED}')) AS stale_received_oldest,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'GENERATED') AS live_generated,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'GENERATED' AND r.error_message LIKE 'GRAPH_OUTCOME_UNKNOWN%') AS live_outcome_unknown,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'GENERATED' AND r.error_message = 'GRAPH_SEND_IN_PROGRESS') AS live_send_in_progress,
         (SELECT MIN(r.created_at) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'GENERATED') AS live_ambiguous_oldest,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'FAILED' AND r.error_message LIKE 'GRAPH_REJECTED_4%') AS live_failed_4xx,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'FAILED') AS live_failed_total,
         (SELECT MIN(r.created_at) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'FAILED') AS live_failed_oldest,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'LIVE' AND r.status = 'SENT') AS live_sent,
         (SELECT COUNT(*) FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.page_id = ?1 AND r.mode = 'DRY_RUN' AND r.status = 'GENERATED') AS dry_run_generated`
    )
    .bind(pageId)
    .first();
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) out[k] = k.endsWith("_oldest") ? (v ?? null) : Number(v ?? 0);
  return out;
}
