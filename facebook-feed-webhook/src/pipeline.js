/**
 * Per-comment processing pipeline.
 *
 * Ordering matters for safety:
 *   1. persist first (idempotently) -- a duplicate delivery never reaches
 *      the model twice, and nothing runs for an event we could not record;
 *   2. resolve the product from TRUSTED data only: the Dashboard mapping
 *      for this exact post/reel (no mapping -> no product, no link);
 *   3. ask Hermes synchronously (POST /v1/chat/completions);
 *   4. validate the AI output deterministically (ai.js);
 *   5. compose the final reply -- the AI's text plus, only if it asked for
 *      a call-to-action AND a usable product exists, the trusted URL;
 *   6. persist the outcome; a Facebook mutation happens only in LIVE mode,
 *      only after every LIVE gate passes, behind facebook-reply.js.
 *
 * FAIL CLOSED: any failure along the way records SKIPPED or ERROR and posts
 * nothing. SKIP is always preferred to a reply with a wrong product, a
 * guessed link or an unverifiable claim.
 *
 * RETRIES (bounded, and only where nothing can have happened yet):
 *   - Hermes HTTP 429 (concurrency cap, rejected before any run starts) is
 *     retried with bounded, jittered backoff inside the Hermes time budget
 *     (hermes.js requestAgentReplyWithBackpressure).
 *   - Every other Hermes failure (timeout, network, 5xx, bad body) is NOT
 *     retried: the model may already have run. The comment becomes ERROR.
 *   - Facebook Graph sends are NEVER retried. A timeout, network failure
 *     or 5xx is an AMBIGUOUS outcome (the reply may exist on Facebook) and
 *     is recorded as such, never as "unsent".
 *
 * TIME BUDGET: see config.js PIPELINE_BUDGET_MS. Hermes gets whatever is
 * left after reserving the Graph slice; the Graph call has its own abort
 * timeout; a send that cannot fit is not started.
 *
 * SELF-REPLY PROTECTION has two independent layers: author == Page
 * (index.js) and "this event is one of our own stored replies, or nested
 * directly under one" (isOwnReplyEvent, below).
 */

import { MODE_DRY_RUN, MODE_LIVE, PIPELINE_BUDGET_MS, GRAPH_FINALIZE_MS } from "./config.js";
import { replyTargetId } from "./facebook.js";
import { requestAgentReplyWithBackpressure, HermesError } from "./hermes.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./agent-prompt.js";
import { evaluateAgentResponse, describeResponseShape, ACTIONS } from "./ai.js";
import { resolveProduct, composeFinalReply, isUsableProduct, PRODUCT_SOURCES } from "./affiliate.js";
import { sendFacebookReply, FacebookSendError } from "./facebook-reply.js";
import {
  insertCommentIfNew,
  getMappedProduct,
  hasLiveSendAttempt,
  isOwnReplyEvent,
  insertLiveSendMarker,
  finalizeLiveSend,
  authorRecentlyGotLink,
  updateCommentResult,
  markCommentStatus,
  insertReply,
} from "./db.js";
import { logEvent, logError, safeText } from "./log.js";
import { shortHash } from "./crypto.js";

export const OUTCOMES = Object.freeze({
  DUPLICATE: "duplicate",
  DRAFTED: "drafted",
  SKIPPED: "skipped",
  ERROR: "error",
  REPLIED: "replied",
});

/**
 * @param {import("./facebook.js").NormalizedComment} event
 * @param {{db: any, env: any, config: any}} deps
 */
export async function processCommentEvent(event, { db, env, config }) {
  const startedAt = Date.now();
  const authorRef = await shortHash(event.author_id);

  // ---- 0. Self-reply protection, layer 2 ------------------------------
  if (await isOwnReplyEventFailClosed(db, event)) {
    logEvent("event_ignored", { reason: "OWN_REPLY_EVENT", comment_id: event.comment_id });
    return { outcome: OUTCOMES.SKIPPED, reason: "OWN_REPLY_EVENT" };
  }

  // ---- 1. Idempotent persistence -------------------------------------
  let inserted;
  try {
    inserted = await insertCommentIfNew(db, event);
  } catch {
    logError("comment_persist_failed", "D1_INSERT_FAILED", {
      comment_id: event.comment_id,
      page_id: event.page_id,
    });
    // Fail closed: without persistence we do not invoke the model at all.
    return { outcome: OUTCOMES.ERROR, reason: "D1_INSERT_FAILED" };
  }

  if (inserted.duplicate) {
    logEvent("comment_duplicate", {
      comment_id: event.comment_id,
      page_id: event.page_id,
      mode: config.mode,
    });
    return { outcome: OUTCOMES.DUPLICATE };
  }

  const commentRowId = inserted.id;
  const base = { comment_row_id: commentRowId, comment_id: event.comment_id };

  logEvent("comment_received", {
    ...base,
    post_id: event.post_id,
    page_id: event.page_id,
    author_ref: authorRef,
    text_preview: safeText(event.comment_text),
    mode: config.mode,
  });

  return runPersistedComment(event, commentRowId, { db, env, config, startedAt });
}

/**
 * Self-reply protection, layer 2. Runs before anything is stored or sent:
 * an event that IS one of our own Facebook replies (or sits directly under
 * one) is dropped. If the check itself fails we cannot prove it is not our
 * own reply -> treat it as ours.
 */
export async function isOwnReplyEventFailClosed(db, event) {
  try {
    return await isOwnReplyEvent(db, { commentId: event.comment_id, parentId: event.parent_id });
  } catch {
    return true;
  }
}

/**
 * Steps 2..6 for a comment that is ALREADY persisted (row `commentRowId`).
 * Shared by the webhook path above and by operator recovery (recovery.js),
 * so both use exactly the same product lookup, Hermes budget/backoff,
 * validation, link guard, LIVE gates, send marker and outcome recording.
 *
 * @param {import("./facebook.js").NormalizedComment} event
 * @param {number} commentRowId
 * @param {{db: any, env: any, config: any, startedAt: number}} deps
 */
export async function runPersistedComment(event, commentRowId, { db, env, config, startedAt }) {
  const base = { comment_row_id: commentRowId, comment_id: event.comment_id };

  // ---- 2. Trusted product context ------------------------------------
  let product = null;
  let productSource = PRODUCT_SOURCES.NONE;
  let contentType = "POST";
  try {
    const mapped = await getMappedProduct(db, event.page_id, event.post_id);
    if (mapped) contentType = mapped.contentType;
    ({ product, source: productSource } = resolveProduct({
      mappedProduct: mapped?.product ?? null,
      allowedHosts: config.affiliateAllowedHosts,
    }));
  } catch {
    // A lookup failure must not invent context; continue with none.
    logError("product_lookup_failed", "D1_SELECT_FAILED", base);
    product = null;
    productSource = PRODUCT_SOURCES.NONE;
  }

  const productId = product ? Number(product.id) : null;
  const linkAvailable = isUsableProduct(product, config.affiliateAllowedHosts);

  logEvent("product_resolved", { ...base, product_id: productId, product_source: productSource });

  // ---- 3. Ask Hermes (synchronous) -----------------------------------
  // Hermes caps concurrent runs (429 + Retry-After when full). That single
  // outcome gets bounded, jittered backoff inside the same overall
  // HERMES_TIMEOUT_MS budget; every other failure still fails closed at once.
  let agentRaw;
  try {
    ({ content: agentRaw } = await requestAgentReplyWithBackpressure(
      {
        systemPrompt: SYSTEM_PROMPT,
        userMessage: buildUserMessage({ event, contentType, product, linkAvailable }),
        idempotencyKey: `fbc:${event.comment_id}`,
      },
      { url: config.hermesUrl, apiKey: env.HERMES_API_KEY, timeoutMs: hermesBudgetMs(config, startedAt) },
      {
        onRetry: ({ attempt, delayMs }) =>
          logEvent("hermes_busy_backoff", { ...base, attempt, delay_ms: delayMs }),
      }
    ));
  } catch (error) {
    const category = error instanceof HermesError ? error.category : "HERMES_UNKNOWN_ERROR";
    logError("hermes_call_failed", category, {
      ...base,
      status_code: error?.statusCode ?? null,
      duration_ms: Date.now() - startedAt,
    });
    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "ERROR",
      aiResponse: null,
      matchedProductId: productId,
      productSource,
      aiAction: null,
      reply: null,
    });
    return { outcome: OUTCOMES.ERROR, reason: category };
  }

  // ---- 4. Deterministic validation -----------------------------------
  const evaluation = evaluateAgentResponse(agentRaw, { maxLength: config.maxReplyLength });

  if (!evaluation.ok) {
    logError("ai_response_rejected", evaluation.reason, {
      ...base,
      duration_ms: Date.now() - startedAt,
      ...describeResponseShape(agentRaw),
    });
    await recordSkip(db, config, { commentRowId, productId, productSource, aiAction: null, reason: evaluation.reason });
    return { outcome: OUTCOMES.SKIPPED, reason: evaluation.reason };
  }

  if (evaluation.action === ACTIONS.SKIP) {
    logEvent("ai_action_skip", { ...base, duration_ms: Date.now() - startedAt });
    await recordSkip(db, config, {
      commentRowId,
      productId,
      productSource,
      aiAction: ACTIONS.SKIP,
      reason: "AI_ACTION_SKIP",
    });
    return { outcome: OUTCOMES.SKIPPED, reason: "AI_ACTION_SKIP" };
  }

  // ---- 5. Compose the final reply from trusted data ------------------
  let suppressLink = false;
  if (evaluation.includeCta && product) {
    try {
      suppressLink = await authorRecentlyGotLink(db, {
        pageId: event.page_id,
        postId: event.post_id,
        authorId: event.author_id,
        url: product.affiliate_url ?? product.shopee_url,
        excludeCommentId: commentRowId,
      });
    } catch {
      // Cannot prove it is not spam -> do not attach the link.
      suppressLink = true;
    }
  }

  const final = composeFinalReply({
    text: evaluation.text,
    includeCta: evaluation.includeCta,
    product,
    allowedHosts: config.affiliateAllowedHosts,
    suppressLink,
  });

  if (!final.ok) {
    logError("reply_composition_rejected", final.reason, base);
    await recordSkip(db, config, {
      commentRowId,
      productId,
      productSource,
      aiAction: ACTIONS.REPLY,
      reason: final.reason,
      aiText: evaluation.text,
    });
    return { outcome: OUTCOMES.SKIPPED, reason: final.reason };
  }

  // ---- 6a. DRY_RUN: store the draft, never touch Facebook ------------
  if (config.mode !== MODE_LIVE) {
    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "PROCESSED",
      aiResponse: final.text,
      matchedProductId: productId,
      productSource,
      aiAction: ACTIONS.REPLY,
      reply: {
        responseText: final.text,
        mode: MODE_DRY_RUN,
        status: "GENERATED",
        facebookReplyId: null,
        errorMessage: null,
        affiliateUrl: final.affiliateUrl,
      },
    });

    logEvent("reply_drafted", {
      ...base,
      product_id: productId,
      product_source: productSource,
      has_link: Boolean(final.affiliateUrl),
      mode: MODE_DRY_RUN,
      reply_length: final.text.length,
      duration_ms: Date.now() - startedAt,
    });
    return { outcome: OUTCOMES.DRAFTED, mode: MODE_DRY_RUN };
  }

  // ---- 6b. LIVE: every gate must pass before any mutation -------------
  let attempted = true;
  try {
    attempted = await hasLiveSendAttempt(db, commentRowId);
  } catch {
    attempted = true; // cannot prove it is safe -> do not send
  }
  if (attempted) {
    logError("live_gate_blocked", "LIVE_SEND_ALREADY_ATTEMPTED_OR_UNKNOWN", base);
    return { outcome: OUTCOMES.SKIPPED, reason: "LIVE_SEND_ALREADY_ATTEMPTED_OR_UNKNOWN" };
  }
  if (final.affiliateUrl && !linkAvailable) {
    logError("live_gate_blocked", "PRODUCT_CONTEXT_INVALID", base);
    await recordSkip(db, config, { commentRowId, productId, productSource, aiAction: ACTIONS.REPLY, reason: "PRODUCT_CONTEXT_INVALID" });
    return { outcome: OUTCOMES.SKIPPED, reason: "PRODUCT_CONTEXT_INVALID" };
  }

  // Time budget: never START a send that cannot finish (and be recorded)
  // inside the Worker's lifetime. Not started == definitely not sent.
  const remainingMs = PIPELINE_BUDGET_MS - (Date.now() - startedAt);
  const graphTimeoutMs = Math.min(config.graphTimeoutMs, remainingMs - GRAPH_FINALIZE_MS);
  if (graphTimeoutMs < Math.min(config.graphTimeoutMs, 2000)) {
    logError("live_gate_blocked", "SEND_BUDGET_EXHAUSTED", { ...base, remaining_ms: remainingMs });
    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "ERROR",
      aiResponse: final.text,
      matchedProductId: productId,
      productSource,
      aiAction: ACTIONS.REPLY,
      reply: { responseText: "", mode: MODE_LIVE, status: "SKIPPED", facebookReplyId: null, errorMessage: "SEND_BUDGET_EXHAUSTED", affiliateUrl: null },
    });
    return { outcome: OUTCOMES.ERROR, reason: "SEND_BUDGET_EXHAUSTED" };
  }

  // Marker BEFORE the request: an attempt can never vanish silently. If
  // the marker cannot be written, nothing is sent.
  let markerId;
  try {
    markerId = await insertLiveSendMarker(db, { commentId: commentRowId, responseText: final.text, affiliateUrl: final.affiliateUrl });
  } catch {
    logError("live_gate_blocked", "SEND_MARKER_NOT_WRITTEN", base);
    await markStatusQuietly(db, commentRowId, "ERROR");
    return { outcome: OUTCOMES.ERROR, reason: "SEND_MARKER_NOT_WRITTEN" };
  }

  let sent;
  try {
    sent = await sendFacebookReply(
      { commentId: replyTargetId(event), message: final.text },
      { mode: config.mode, accessToken: env.PAGE_ACCESS_TOKEN, graphApiVersion: config.graphApiVersion, timeoutMs: graphTimeoutMs }
    );
  } catch (error) {
    const ambiguous = !(error instanceof FacebookSendError) || error.ambiguous;
    const category = error?.category || "GRAPH_UNKNOWN_ERROR";
    // NO RETRY in either case. Ambiguous stays GENERATED (never FAILED):
    // the reply may exist on Facebook.
    const outcome = ambiguous
      ? { status: "GENERATED", errorMessage: `GRAPH_OUTCOME_UNKNOWN:${category}` }
      : { status: "FAILED", errorMessage: category };
    logError(ambiguous ? "reply_send_ambiguous" : "reply_send_failed", category, { ...base, status_code: error?.statusCode ?? null });
    await finalizeQuietly(db, markerId, outcome, base);
    await updateOutcomeQuietly(db, commentRowId, { status: "ERROR", aiResponse: final.text, matchedProductId: productId, productSource, aiAction: ACTIONS.REPLY });
    return { outcome: OUTCOMES.ERROR, reason: ambiguous ? "GRAPH_OUTCOME_UNKNOWN" : category };
  }

  // HTTP 2xx: the reply exists. Record it; the id is optional evidence.
  await finalizeQuietly(db, markerId, { status: "SENT", facebookReplyId: sent.id || null, errorMessage: sent.id ? null : "SENT_ID_UNPARSEABLE" }, base);
  await updateOutcomeQuietly(db, commentRowId, { status: "REPLIED", aiResponse: final.text, matchedProductId: productId, productSource, aiAction: ACTIONS.REPLY });
  logEvent("reply_sent", { ...base, mode: MODE_LIVE, has_link: Boolean(final.affiliateUrl), has_reply_id: Boolean(sent.id), duration_ms: Date.now() - startedAt });
  return { outcome: OUTCOMES.REPLIED, mode: MODE_LIVE };
}

/** Hermes gets what is left of the pipeline budget after the Graph slice. */
export function hermesBudgetMs(config, startedAt, now = Date.now()) {
  const left = PIPELINE_BUDGET_MS - (now - startedAt) - config.graphTimeoutMs - GRAPH_FINALIZE_MS;
  return Math.max(1, Math.min(config.hermesTimeoutMs, left));
}

async function finalizeQuietly(db, markerId, outcome, base) {
  try {
    await finalizeLiveSend(db, markerId, outcome);
  } catch {
    // The marker stays "GRAPH_SEND_IN_PROGRESS" -- still an attempt on
    // record, never mistaken for "unsent".
    logError("reply_outcome_unrecorded", "D1_UPDATE_FAILED", { ...base, intended_status: outcome.status });
  }
}

async function updateOutcomeQuietly(db, commentRowId, { status, aiResponse, matchedProductId, productSource, aiAction }) {
  try {
    await updateCommentResult(db, commentRowId, { status, aiResponse, matchedProductId, productSource, aiAction });
  } catch {
    logError("comment_result_update_failed", "D1_UPDATE_FAILED", { comment_row_id: commentRowId });
    await markStatusQuietly(db, commentRowId, status);
  }
}

async function markStatusQuietly(db, commentRowId, status) {
  try {
    await markCommentStatus(db, commentRowId, status);
  } catch {
    /* already logged by the caller */
  }
}

async function recordSkip(db, config, { commentRowId, productId, productSource, aiAction, reason, aiText = null }) {
  await safeWriteOutcome(db, {
    commentRowId,
    commentStatus: "SKIPPED",
    aiResponse: aiText,
    matchedProductId: productId,
    productSource,
    aiAction,
    reply: {
      responseText: "",
      mode: config.mode === MODE_LIVE ? MODE_LIVE : MODE_DRY_RUN,
      status: "SKIPPED",
      facebookReplyId: null,
      errorMessage: reason,
      affiliateUrl: null,
    },
  });
}

async function safeWriteOutcome(db, { commentRowId, commentStatus, aiResponse, matchedProductId, productSource, aiAction, reply }) {
  try {
    await updateCommentResult(db, commentRowId, {
      status: commentStatus,
      aiResponse,
      matchedProductId,
      productSource,
      aiAction,
    });
  } catch {
    logError("comment_result_update_failed", "D1_UPDATE_FAILED", { comment_row_id: commentRowId });
    try {
      await markCommentStatus(db, commentRowId, commentStatus);
    } catch {
      /* already logged */
    }
  }

  if (!reply) return;
  try {
    await insertReply(db, { commentId: commentRowId, ...reply });
  } catch {
    logError("reply_persist_failed", "D1_INSERT_FAILED", { comment_row_id: commentRowId });
  }
}
