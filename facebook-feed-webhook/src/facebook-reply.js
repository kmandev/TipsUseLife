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

/**
 * @param {{commentId: string, message: string}} input
 * @param {{mode: string, accessToken: string, graphApiVersion: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{id: string}>}
 */
export async function sendFacebookReply(input, options) {
  const { mode, accessToken, graphApiVersion = "v21.0", fetchImpl = fetch } = options || {};

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

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      // The token travels in the Authorization header rather than the
      // query string so it cannot leak into URL access logs.
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const error = new Error("FACEBOOK_REPLY_FAILED");
    error.category = "FACEBOOK_REPLY_FAILED";
    error.statusCode = response.status;
    throw error;
  }

  const data = await response.json();
  return { id: String(data?.id ?? "") };
}
