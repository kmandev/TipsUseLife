/**
 * Configuration resolution.
 *
 * SAFETY CONTRACT
 * ---------------
 * The reply mode governs whether the system is allowed to perform a
 * Facebook mutation (posting a real reply). It is deliberately
 * "fail-safe": anything other than the exact literal string "LIVE"
 * resolves to DRY_RUN. A missing, empty, misspelled, lowercase or
 * whitespace-padded environment variable therefore CANNOT accidentally
 * enable live replies.
 *
 * LIVE additionally requires a PAGE_ACCESS_TOKEN to be present, so a
 * half-configured environment also degrades to DRY_RUN rather than
 * erroring into an unexpected state.
 */

export const MODE_DRY_RUN = "DRY_RUN";
export const MODE_LIVE = "LIVE";

export const DEFAULT_PAGE_ID = "853313081388711";
export const DEFAULT_HERMES_URL =
  "https://hermes-feed.cloudnext.icu/webhooks/facebook-comments";

/**
 * @param {Record<string, unknown>} env
 * @returns {"DRY_RUN" | "LIVE"}
 */
export function resolveReplyMode(env) {
  const raw = env?.REPLY_MODE;

  // Only an exact, unambiguous opt-in counts. Note: no trimming, no
  // case-folding -- we do not want "live", " LIVE " or "Live" to work,
  // because a fuzzy match is one typo away from an accidental mutation.
  if (raw !== MODE_LIVE) return MODE_DRY_RUN;

  // LIVE without credentials is not LIVE.
  if (!env?.PAGE_ACCESS_TOKEN) return MODE_DRY_RUN;

  return MODE_LIVE;
}

/**
 * @param {Record<string, unknown>} env
 */
export function resolveConfig(env) {
  return {
    mode: resolveReplyMode(env),
    pageId: String(env?.PAGE_ID || DEFAULT_PAGE_ID),
    hermesUrl: String(env?.HERMES_URL || DEFAULT_HERMES_URL),
    hermesTimeoutMs: Number(env?.HERMES_TIMEOUT_MS || 25000),
    graphApiVersion: String(env?.GRAPH_API_VERSION || "v21.0"),
    maxReplyLength: Number(env?.MAX_REPLY_LENGTH || 600),
  };
}
