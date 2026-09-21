/**
 * Per-comment processing pipeline.
 *
 * Ordering matters for safety:
 *   1. persist first (idempotently) -- so a duplicate delivery can never
 *      reach the model twice, and so we never invoke Gemini for an event
 *      we could not record;
 *   2. then enrich with trusted product context;
 *   3. then ask Hermes/Gemini for a draft;
 *   4. then validate the draft deterministically;
 *   5. then persist the outcome. A Facebook mutation happens only in
 *      LIVE mode, at step 5, behind the guards in facebook-reply.js.
 */

import { MODE_DRY_RUN, MODE_LIVE } from "./config.js";
import { buildHermesPayload } from "./facebook.js";
import { matchProduct } from "./products.js";
import { sendToHermes, HermesError } from "./hermes.js";
import { evaluateAgentResponse, describeResponseShape, ACTIONS, SAFE_GENERIC_REPLY } from "./ai.js";
import { sendFacebookReply } from "./facebook-reply.js";
import {
  insertCommentIfNew,
  listActiveProducts,
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

  // ---- 1. Idempotent persistence -------------------------------------
  let inserted;
  try {
    inserted = await insertCommentIfNew(db, event);
  } catch (error) {
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

  logEvent("comment_received", {
    comment_row_id: commentRowId,
    comment_id: event.comment_id,
    post_id: event.post_id,
    page_id: event.page_id,
    author_ref: authorRef,
    text_preview: safeText(event.comment_text),
    mode: config.mode,
  });

  // ---- 2. Trusted product context ------------------------------------
  let matchedProduct = null;
  try {
    const products = await listActiveProducts(db);
    matchedProduct = matchProduct(event.comment_text, products);
  } catch {
    // A product lookup failure must not invent context; continue with none.
    logError("product_lookup_failed", "D1_SELECT_FAILED", {
      comment_row_id: commentRowId,
    });
    matchedProduct = null;
  }

  const matchedProductId = matchedProduct ? Number(matchedProduct.id) : null;

  // ---- 3. Ask Hermes / Gemini ----------------------------------------
  let agentRaw;
  try {
    agentRaw = await sendToHermes(
      buildHermesPayload(event, { mode: config.mode, matchedProduct }),
      {
        url: config.hermesUrl,
        secret: env.HERMES_SECRET,
        timeoutMs: config.hermesTimeoutMs,
      }
    );
  } catch (error) {
    const category = error instanceof HermesError ? error.category : "HERMES_UNKNOWN_ERROR";
    logError("hermes_call_failed", category, {
      comment_row_id: commentRowId,
      comment_id: event.comment_id,
      status_code: error?.statusCode ?? null,
      duration_ms: Date.now() - startedAt,
    });
    await safeMark(db, commentRowId, "ERROR");
    return { outcome: OUTCOMES.ERROR, reason: category };
  }

  // ---- 4. Deterministic validation ------------------------------------
  const evaluation = evaluateAgentResponse(agentRaw, {
    maxLength: config.maxReplyLength,
    trustedProduct: matchedProduct,
  });

  if (!evaluation.ok) {
    logError("ai_response_rejected", evaluation.reason, {
      comment_row_id: commentRowId,
      comment_id: event.comment_id,
      matched_product_id: matchedProductId,
      duration_ms: Date.now() - startedAt,
      ...describeResponseShape(agentRaw),
    });

    // Fail closed to a factless generic draft. Recorded as SKIPPED so it
    // is never mistaken for an approved reply.
    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "SKIPPED",
      aiResponse: SAFE_GENERIC_REPLY,
      matchedProductId,
      reply: {
        responseText: SAFE_GENERIC_REPLY,
        mode: config.mode,
        status: "SKIPPED",
        facebookReplyId: null,
        errorMessage: evaluation.reason,
      },
    });

    return { outcome: OUTCOMES.SKIPPED, reason: evaluation.reason };
  }

  if (evaluation.action === ACTIONS.SKIP) {
    logEvent("ai_action_skip", {
      comment_row_id: commentRowId,
      comment_id: event.comment_id,
      matched_product_id: matchedProductId,
      mode: config.mode,
      duration_ms: Date.now() - startedAt,
    });

    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "SKIPPED",
      aiResponse: null,
      matchedProductId,
      reply: {
        responseText: "",
        mode: config.mode,
        status: "SKIPPED",
        facebookReplyId: null,
        errorMessage: "AI_ACTION_SKIP",
      },
    });

    return { outcome: OUTCOMES.SKIPPED, reason: "AI_ACTION_SKIP" };
  }

  // ---- 5. Persist outcome (and mutate only in LIVE) -------------------
  if (config.mode !== MODE_LIVE) {
    // DRY_RUN: draft is stored, facebook_reply_id stays NULL, and no
    // Facebook mutation function is called from this branch at all.
    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "PROCESSED",
      aiResponse: evaluation.text,
      matchedProductId,
      reply: {
        responseText: evaluation.text,
        mode: MODE_DRY_RUN,
        status: "GENERATED",
        facebookReplyId: null,
        errorMessage: null,
      },
    });

    logEvent("reply_drafted", {
      comment_row_id: commentRowId,
      comment_id: event.comment_id,
      matched_product_id: matchedProductId,
      mode: MODE_DRY_RUN,
      reply_length: evaluation.text.length,
      duration_ms: Date.now() - startedAt,
    });

    return { outcome: OUTCOMES.DRAFTED, mode: MODE_DRY_RUN };
  }

  // LIVE branch -- intentionally unreachable while REPLY_MODE !== "LIVE".
  try {
    const result = await sendFacebookReply(
      { commentId: event.comment_id, message: evaluation.text },
      {
        mode: config.mode,
        accessToken: env.PAGE_ACCESS_TOKEN,
        graphApiVersion: config.graphApiVersion,
      }
    );

    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "REPLIED",
      aiResponse: evaluation.text,
      matchedProductId,
      reply: {
        responseText: evaluation.text,
        mode: MODE_LIVE,
        status: "SENT",
        facebookReplyId: result.id || null,
        errorMessage: null,
      },
    });

    logEvent("reply_sent", {
      comment_row_id: commentRowId,
      comment_id: event.comment_id,
      mode: MODE_LIVE,
      duration_ms: Date.now() - startedAt,
    });

    return { outcome: OUTCOMES.REPLIED, mode: MODE_LIVE };
  } catch (error) {
    const category = error?.category || "FACEBOOK_REPLY_FAILED";
    logError("reply_send_failed", category, {
      comment_row_id: commentRowId,
      comment_id: event.comment_id,
      status_code: error?.statusCode ?? null,
    });

    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "ERROR",
      aiResponse: evaluation.text,
      matchedProductId,
      reply: {
        responseText: evaluation.text,
        mode: MODE_LIVE,
        status: "FAILED",
        facebookReplyId: null,
        errorMessage: category,
      },
    });

    return { outcome: OUTCOMES.ERROR, reason: category };
  }
}

async function safeMark(db, commentRowId, status) {
  try {
    await markCommentStatus(db, commentRowId, status);
  } catch {
    logError("comment_status_update_failed", "D1_UPDATE_FAILED", {
      comment_row_id: commentRowId,
    });
  }
}

async function safeWriteOutcome(db, { commentRowId, commentStatus, aiResponse, matchedProductId, reply }) {
  try {
    await updateCommentResult(db, commentRowId, {
      status: commentStatus,
      aiResponse,
      matchedProductId,
    });
  } catch {
    logError("comment_result_update_failed", "D1_UPDATE_FAILED", {
      comment_row_id: commentRowId,
    });
  }

  try {
    await insertReply(db, { commentId: commentRowId, ...reply });
  } catch {
    logError("reply_persist_failed", "D1_INSERT_FAILED", {
      comment_row_id: commentRowId,
    });
  }
}
