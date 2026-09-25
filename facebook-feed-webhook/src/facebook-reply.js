/**
 * LIVE-ONLY Facebook Graph API reply mutation.
 *
 * ============================ SAFETY ============================
 * This is the ONLY place in the codebase that performs a Facebook
 * mutation (POST /{comment-id}/comments).
 *
 * Three independent guards must all pass before a request is made:
 *   1. The caller in pipeline.js only reaches this function inside an
 *      `if (mode === MODE_LIVE)` branch.
 *   2. This function re-checks the mode itself and throws otherwise,
 *      so a future refactor that loses guard (1) still cannot post.
 *   3. resolveReplyMode() can only return LIVE for the exact literal
 *      env value "LIVE" *and* a present PAGE_ACCESS_TOKEN.
 *
 * In DRY_RUN this function is unreachable, and if it were reached it
 * would throw before touching the network.
 * ================================================================
 */

import { MODE_LIVE } from "./config.js";

export class LiveModeViolationError extends Error {
  constructor(mode) {
    super("FACEBOOK_MUTATION_BLOCKED");
    this.name = "LiveModeViolationError";
    this.category = "FACEBOOK_MUTATION_BLOCKED";
    this.attemptedMode = mode;
  }
}

/** Default hard limit for one Graph send (ms). See pipeline.js time budget. */
export const DEFAULT_GRAPH_TIMEOUT_MS = 5000;

/**
 * A Graph send that did not end in a confirmed success.
 *
 * `ambiguous` is the important bit:
 *   - false -> Facebook definitely did NOT create the reply (HTTP 4xx).
 *   - true  -> we cannot know: timeout, network failure or HTTP 5xx. The
 *              reply may exist on Facebook. Such an outcome must never be
 *              treated as "unsent" and must never be retried automatically.
 */
export class FacebookSendError extends Error {
  constructor(category, { statusCode = null, ambiguous }) {
    super(category);
    this.name = "FacebookSendError";
    this.category = category;
    this.statusCode = statusCode;
    this.ambiguous = Boolean(ambiguous);
  }
}

/**
 * @param {{commentId: string, message: string}} input
 * @param {{mode: string, accessToken: string, graphApiVersion: string, timeoutMs?: number, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{id: string|null}>} resolves ONLY on HTTP 2xx; `id` is
 *          null when the body could not be parsed (the send still succeeded).
 * @throws {LiveModeViolationError} before any network activity outside LIVE
 * @throws {FacebookSendError} on any non-2xx / timeout / network failure
 */
export async function sendFacebookReply(input, options) {
  const {
    mode,
    accessToken,
    graphApiVersion = "v21.0",
    timeoutMs = DEFAULT_GRAPH_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options || {};

  // GUARD 2 -- refuse outright unless explicitly in LIVE mode.
  if (mode !== MODE_LIVE) {
    throw new LiveModeViolationError(mode);
  }

  if (!accessToken) {
    throw new LiveModeViolationError("MISSING_PAGE_ACCESS_TOKEN");
  }

  const url = `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(
    input.commentId
  )}/comments`;

  const form = new URLSearchParams();
  form.set("message", input.message);

  // Bounded: a Graph call may never consume the rest of the Worker's
  // waitUntil window. On abort the outcome is AMBIGUOUS (the request may
  // already have been accepted), never "not sent".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_GRAPH_TIMEOUT_MS));

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        // The token travels in the Authorization header rather than the
        // query string so it cannot leak into URL access logs.
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    throw new FacebookSendError(error?.name === "AbortError" ? "GRAPH_TIMEOUT" : "GRAPH_NETWORK_ERROR", {
      ambiguous: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 200 && response.status < 300) {
    // HTTP 2xx IS the success signal. The body is only read to capture the
    // reply id; a malformed body never downgrades a completed send.
    let id = null;
    try {
      const data = JSON.parse(await response.text());
      if (data && (typeof data.id === "string" || typeof data.id === "number") && String(data.id).length > 0) {
        id = String(data.id);
      }
    } catch {
      id = null;
    }
    return { id };
  }

  if (response.status >= 400 && response.status < 500) {
    // Graph rejected the request (bad params, permissions, rate limit):
    // no reply was created.
    throw new FacebookSendError(`GRAPH_REJECTED_${response.status}`, { statusCode: response.status, ambiguous: false });
  }

  // 5xx / 1xx / 3xx: the request may or may not have been applied.
  throw new FacebookSendError(`GRAPH_UNCERTAIN_${response.status}`, { statusCode: response.status, ambiguous: true });
}
