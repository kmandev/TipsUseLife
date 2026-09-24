/**
 * Per-comment processing pipeline.
 *
 * Ordering matters for safety:
 *   1. persist first (idempotently) -- a duplicate delivery never reaches
 *      the model twice, and nothing runs for an event we could not record;
 *   2. resolve the product from TRUSTED data only (Dashboard mapping for
 *      this post/reel, else the conservative keyword matcher);
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
 * NO AUTOMATIC RETRIES: if Hermes times out, the model may still have run.
 * Retrying could double-bill or, in LIVE, risk a second reply, so a timed
 * out comment is recorded as ERROR and left for a human.
 */

import { MODE_DRY_RUN, MODE_LIVE } from "./config.js";
import { requestAgentReply, HermesError } from "./hermes.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./agent-prompt.js";
import { evaluateAgentResponse, describeResponseShape, ACTIONS } from "./ai.js";
import { resolveProduct, composeFinalReply, isUsableProduct, PRODUCT_SOURCES } from "./affiliate.js";
import { sendFacebookReply } from "./facebook-reply.js";
import {
  insertCommentIfNew,
  listActiveProducts,
  getMappedProduct,
  hasSentReply,
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

  // ---- 2. Trusted product context ------------------------------------
  let product = null;
  let productSource = PRODUCT_SOURCES.NONE;
  let contentType = "POST";
  try {
    const mapped = await getMappedProduct(db, event.page_id, event.post_id);
    if (mapped) contentType = mapped.contentType;
    const activeProducts = mapped ? [] : await listActiveProducts(db);
    ({ product, source: productSource } = resolveProduct({
      mappedProduct: mapped?.product ?? null,
      activeProducts,
      commentText: event.comment_text,
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
  let agentRaw;
  try {
    agentRaw = await requestAgentReply(
      {
        systemPrompt: SYSTEM_PROMPT,
        userMessage: buildUserMessage({ event, contentType, product, linkAvailable }),
        idempotencyKey: `fbc:${event.comment_id}`,
      },
      { url: config.hermesUrl, apiKey: env.HERMES_API_KEY, timeoutMs: config.hermesTimeoutMs }
    );
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
  let alreadySent = true;
  try {
    alreadySent = await hasSentReply(db, commentRowId);
  } catch {
    alreadySent = true; // cannot prove it is safe -> do not send
  }
  if (alreadySent) {
    logError("live_gate_blocked", "REPLY_ALREADY_SENT_OR_UNKNOWN", base);
    return { outcome: OUTCOMES.SKIPPED, reason: "REPLY_ALREADY_SENT_OR_UNKNOWN" };
  }
  if (final.affiliateUrl && !linkAvailable) {
    logError("live_gate_blocked", "PRODUCT_CONTEXT_INVALID", base);
    await recordSkip(db, config, { commentRowId, productId, productSource, aiAction: ACTIONS.REPLY, reason: "PRODUCT_CONTEXT_INVALID" });
    return { outcome: OUTCOMES.SKIPPED, reason: "PRODUCT_CONTEXT_INVALID" };
  }

  try {
    const result = await sendFacebookReply(
      { commentId: event.comment_id, message: final.text },
      { mode: config.mode, accessToken: env.PAGE_ACCESS_TOKEN, graphApiVersion: config.graphApiVersion }
    );

    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "REPLIED",
      aiResponse: final.text,
      matchedProductId: productId,
      productSource,
      aiAction: ACTIONS.REPLY,
      reply: {
        responseText: final.text,
        mode: MODE_LIVE,
        status: "SENT",
        facebookReplyId: result.id || null,
        errorMessage: null,
        affiliateUrl: final.affiliateUrl,
      },
    });

    logEvent("reply_sent", { ...base, mode: MODE_LIVE, has_link: Boolean(final.affiliateUrl), duration_ms: Date.now() - startedAt });
    return { outcome: OUTCOMES.REPLIED, mode: MODE_LIVE };
  } catch (error) {
    const category = error?.category || "FACEBOOK_REPLY_FAILED";
    logError("reply_send_failed", category, { ...base, status_code: error?.statusCode ?? null });

    await safeWriteOutcome(db, {
      commentRowId,
      commentStatus: "ERROR",
      aiResponse: final.text,
      matchedProductId: productId,
      productSource,
      aiAction: ACTIONS.REPLY,
      reply: {
        responseText: final.text,
        mode: MODE_LIVE,
        status: "FAILED",
        facebookReplyId: null,
        errorMessage: category,
        affiliateUrl: final.affiliateUrl,
      },
    });
    return { outcome: OUTCOMES.ERROR, reason: category };
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
