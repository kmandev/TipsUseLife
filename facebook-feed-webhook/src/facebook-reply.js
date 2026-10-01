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

/* ===================================================================
 * Phase 8.36 -- READ-ONLY reply lookup for ambiguous-send reconciliation.
 *
 * GET /{targetId}/comments only. This function has no code path that
 * issues any other HTTP method and it never sends a body. It is used by
 * operator reconciliation (recovery.js reconcileComment) to discover a
 * reply Facebook already created after a send whose HTTP outcome was not
 * observed (GRAPH_OUTCOME_UNKNOWN). It never creates anything.
 *
 * Unlike sendFacebookReply, ONE deadline covers everything: connection,
 * response headers AND body reads, for every page. Pagination is bounded:
 * at most `maxPages` pages; if more exist the result is reported
 * incomplete instead of following an unbounded chain.
 * =================================================================== */

/** Dedicated read deadline (ms). Deliberately NOT GRAPH_TIMEOUT_MS. */
export const DEFAULT_RECONCILE_TIMEOUT_MS = 8000;
export const RECONCILE_PAGE_LIMIT = 100;
export const RECONCILE_MAX_PAGES = 2;

/**
 * A failed read. `category` is one of GRAPH_READ_TIMEOUT, GRAPH_READ_4XX,
 * GRAPH_READ_5XX, GRAPH_READ_NETWORK_ERROR, GRAPH_READ_MALFORMED.
 */
export class FacebookReadError extends Error {
  constructor(category, { statusCode = null } = {}) {
    super(category);
    this.name = "FacebookReadError";
    this.category = category;
    this.statusCode = statusCode;
  }
}

const READ_FIELDS = "id,from,created_time,message,parent";

/** Reject `promise` as soon as `signal` aborts (covers body reads too). */
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/**
 * @param {string} targetId comment id whose replies are listed
 * @param {{accessToken: string, graphApiVersion?: string, timeoutMs?: number, limit?: number, maxPages?: number, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{items: Array<{id: string, fromId: string|null, createdTime: string|null, message: string|null, parentId: string|null}>, complete: boolean, reason?: string, pages: number}>}
 * @throws {FacebookReadError}
 */
export async function fetchCommentReplies(targetId, options) {
  const {
    accessToken,
    graphApiVersion = "v21.0",
    timeoutMs = DEFAULT_RECONCILE_TIMEOUT_MS,
    limit = RECONCILE_PAGE_LIMIT,
    maxPages = RECONCILE_MAX_PAGES,
    fetchImpl = fetch,
  } = options || {};
  if (!accessToken) throw new FacebookReadError("GRAPH_READ_4XX");
  const target = String(targetId || "");
  if (!/^[0-9]+(_[0-9]+)?$/.test(target)) throw new FacebookReadError("GRAPH_READ_MALFORMED");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_RECONCILE_TIMEOUT_MS));
  const items = [];
  try {
    let after = null;
    for (let page = 1; page <= Math.max(1, maxPages); page += 1) {
      const params = new URLSearchParams({ fields: READ_FIELDS, order: "chronological", limit: String(limit) });
      if (after) params.set("after", after);
      const url = `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(target)}/comments?${params}`;

      let response;
      let text;
      try {
        // GET, no body. The token travels in the Authorization header,
        // never in the URL.
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        text = await untilAborted(Promise.resolve(response.text()), controller.signal);
      } catch (error) {
        if (error instanceof FacebookReadError) throw error;
        throw new FacebookReadError(error?.name === "AbortError" ? "GRAPH_READ_TIMEOUT" : "GRAPH_READ_NETWORK_ERROR");
      }

      if (response.status >= 400 && response.status < 500) {
        throw new FacebookReadError("GRAPH_READ_4XX", { statusCode: response.status });
      }
      if (response.status < 200 || response.status >= 300) {
        // 5xx and any other unexpected status.
        throw new FacebookReadError("GRAPH_READ_5XX", { statusCode: response.status });
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new FacebookReadError("GRAPH_READ_MALFORMED", { statusCode: response.status });
      }
      if (!data || typeof data !== "object" || !Array.isArray(data.data)) {
        throw new FacebookReadError("GRAPH_READ_MALFORMED", { statusCode: response.status });
      }
      for (const raw of data.data) {
        if (!raw || typeof raw !== "object" || (typeof raw.id !== "string" && typeof raw.id !== "number")) {
          throw new FacebookReadError("GRAPH_READ_MALFORMED", { statusCode: response.status });
        }
        items.push({
          id: String(raw.id),
          fromId: raw.from && raw.from.id !== undefined && raw.from.id !== null ? String(raw.from.id) : null,
          createdTime: typeof raw.created_time === "string" ? raw.created_time : null,
          message: typeof raw.message === "string" ? raw.message : null,
          parentId: raw.parent && raw.parent.id !== undefined && raw.parent.id !== null ? String(raw.parent.id) : null,
        });
      }

      const hasNext = Boolean(data.paging && data.paging.next);
      if (!hasNext) return { items, complete: true, pages: page };
      if (page >= maxPages) return { items, complete: false, reason: "INCOMPLETE", pages: page };
      after = data.paging?.cursors?.after;
      if (typeof after !== "string" || !after) {
        throw new FacebookReadError("GRAPH_READ_MALFORMED", { statusCode: response.status });
      }
    }
    return { items, complete: false, reason: "INCOMPLETE", pages: maxPages };
  } finally {
    clearTimeout(timer);
  }
}
