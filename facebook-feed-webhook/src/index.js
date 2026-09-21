/**
 * TipsUseLife -- Facebook Page comment webhook (Cloudflare Worker).
 *
 * Meta Webhook -> this Worker -> D1 -> Hermes gateway -> Hermes agent ->
 * Gemini -> validated Thai draft -> D1 (DRY_RUN).
 *
 * The Worker acknowledges Meta as soon as the event is verified and
 * durably recorded; the model round-trip runs in ctx.waitUntil() so a
 * slow Gemini call can never cause Meta to retry (and therefore never
 * causes duplicate drafts).
 */

import { resolveConfig, MODE_DRY_RUN } from "./config.js";
import { isAdminPath, handleAdminRequest } from "./admin.js";
import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";
import { extractCommentEvents, isSelfEvent } from "./facebook.js";
import { processCommentEvent } from "./pipeline.js";
import { logEvent, logError } from "./log.js";

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{waitUntil: (p: Promise<any>) => void}} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // NEXT-02 -- admin read API. Claims exactly two paths, checked before
    // the Meta webhook handling below so that every other path (the
    // webhook itself included) behaves exactly as it did before.
    if (isAdminPath(url.pathname)) {
      return handleAdminRequest(request, url, env);
    }

    if (request.method === "GET") {
      return handleVerification(url, env);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    }

    return handleWebhook(request, env, ctx);
  },
};

/** Meta webhook subscription handshake. */
function handleVerification(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = env?.META_VERIFY_TOKEN;

  if (
    mode === "subscribe" &&
    typeof token === "string" &&
    typeof challenge === "string" &&
    challenge.length > 0 &&
    typeof expected === "string" &&
    expected.length > 0 &&
    timingSafeEqual(token, expected)
  ) {
    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  logEvent("webhook_verification_rejected", { hub_mode: mode });
  return new Response("Forbidden", { status: 403 });
}

async function handleWebhook(request, env, ctx) {
  const config = resolveConfig(env);

  // Read the raw body exactly once -- the signature covers these bytes.
  const body = await request.text();

  const signatureHeader = request.headers.get("x-hub-signature-256");
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    logError("meta_signature_missing", "SIGNATURE_MISSING");
    return new Response("Missing signature", { status: 401 });
  }

  if (!env?.META_APP_SECRET) {
    logError("meta_secret_missing", "META_APP_SECRET_MISSING");
    return new Response("Unauthorized", { status: 401 });
  }

  const expected = await hmacSha256Hex(env.META_APP_SECRET, body);
  const received = signatureHeader.slice("sha256=".length);

  if (!timingSafeEqual(expected, received)) {
    logError("meta_signature_invalid", "SIGNATURE_INVALID");
    return new Response("Invalid signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    logError("payload_parse_failed", "INVALID_JSON");
    return new Response("Invalid JSON", { status: 400 });
  }

  if (payload?.object !== "page") {
    logEvent("event_ignored", { reason: "NOT_PAGE_EVENT" });
    return json({ status: "ignored", reason: "not_page_event" });
  }

  const allEvents = extractCommentEvents(payload);

  if (allEvents.length === 0) {
    logEvent("event_ignored", { reason: "NO_ACTIONABLE_COMMENT" });
    return json({ status: "ignored", reason: "no_actionable_comment" });
  }

  // SELF-REPLY LOOP PROTECTION -- drop anything authored by our own Page.
  const events = [];
  let selfSkipped = 0;
  for (const event of allEvents) {
    if (isSelfEvent(event, config.pageId)) {
      selfSkipped += 1;
      continue;
    }
    events.push(event);
  }

  if (selfSkipped > 0) {
    logEvent("event_ignored", { reason: "SELF_AUTHORED", count: selfSkipped });
  }

  if (events.length === 0) {
    return json({ status: "ignored", reason: "self_authored" });
  }

  if (!env?.DB) {
    // Fail closed: no persistence means no idempotency guarantee, so we
    // refuse to invoke the model rather than risk duplicate processing.
    logError("d1_binding_missing", "D1_BINDING_MISSING");
    return json({ status: "error", reason: "storage_unavailable" }, 500);
  }

  const work = Promise.all(
    events.map((event) =>
      processCommentEvent(event, { db: env.DB, env, config }).catch(() => {
        logError("pipeline_unhandled", "UNHANDLED_EXCEPTION", {
          comment_id: event.comment_id,
        });
        return { outcome: "error" };
      })
    )
  );

  // Acknowledge Meta immediately; continue processing in the background.
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work);
  } else {
    await work;
  }

  return json({
    status: "accepted",
    events: events.length,
    mode: config.mode ?? MODE_DRY_RUN,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
