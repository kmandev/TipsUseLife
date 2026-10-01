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

/** Monotonic clock (performance.now when the runtime has it). */
function monotonicClock() {
  const perf = globalThis.performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

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
  constructor(category, { statusCode = null, ambiguous, late = null, thresholdMs = null, observeUntilMs = null }) {
    super(category);
    this.name = "FacebookSendError";
    this.category = category;
    this.statusCode = statusCode;
    this.ambiguous = Boolean(ambiguous);
    // Phase 8.44: only on GRAPH_TIMEOUT with late capture enabled.
    this.late = late;
    this.thresholdMs = thresholdMs;
    this.observeUntilMs = observeUntilMs;
  }
}

/**
 * @param {{commentId: string, message: string}} input
 * @param {{mode: string, accessToken: string, graphApiVersion: string, timeoutMs?: number, observeUntilMs?: number, fetchImpl?: typeof fetch, clock?: () => number}} options
 *        timeoutMs = ambiguity threshold; observeUntilMs (Phase 8.44) = hard
 *        deadline for the SAME request (<= timeoutMs: pre-8.44 behaviour).
 * @returns {Promise<{id: string|null}>} resolves ONLY on HTTP 2xx; `id` is
 *          null when the body could not be parsed (the send still succeeded).
 * @throws {LiveModeViolationError} before any network activity outside LIVE
 * @throws {FacebookSendError} on any non-2xx / timeout / network failure.
 *         A GRAPH_TIMEOUT with late capture carries `late`: a promise that
 *         never rejects and resolves to the late observation.
 */
export async function sendFacebookReply(input, options) {
  const {
    mode,
    accessToken,
    graphApiVersion = "v21.0",
    timeoutMs = DEFAULT_GRAPH_TIMEOUT_MS,
    observeUntilMs = 0,
    fetchImpl = fetch,
    clock = monotonicClock,
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
  // waitUntil window. On the threshold the outcome is AMBIGUOUS (the request
  // may already have been accepted), never "not sent".
  //
  // Phase 8.44: `timeoutMs` is the AMBIGUITY THRESHOLD; `observeUntilMs`
  // (>= timeoutMs) is the hard deadline at which the one request is
  // aborted. With observeUntilMs <= timeoutMs this is exactly the pre-8.44
  // single-timer behaviour.
  const thresholdMs = Math.max(1, Number(timeoutMs) || DEFAULT_GRAPH_TIMEOUT_MS);
  const hardMs = Math.max(thresholdMs, Math.floor(Number(observeUntilMs) || 0));
  const lateCapture = hardMs > thresholdMs;
  const startedAt = clock();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), hardMs);

  // THE request. Created and dispatched exactly once; never re-created.
  let request;
  try {
    request = dispatch();
  } catch (error) {
    request = Promise.reject(error); // same classification as an async rejection
  }
  function dispatch() {
    return fetchImpl(url, {
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
  }
  // A rejection after we stop racing must never be unhandled.
  Promise.resolve(request).catch(() => {});

  let response;
  if (!lateCapture) {
    try {
      response = await request;
    } catch (error) {
      throw new FacebookSendError(error?.name === "AbortError" ? "GRAPH_TIMEOUT" : "GRAPH_NETWORK_ERROR", {
        ambiguous: true,
      });
    } finally {
      clearTimeout(timer);
    }
  } else {
    let thresholdTimer;
    const THRESHOLD = Symbol("threshold");
    let first;
    try {
      first = await Promise.race([
        Promise.resolve(request).then((r) => ({ response: r })),
        new Promise((resolve) => {
          thresholdTimer = setTimeout(() => resolve(THRESHOLD), thresholdMs);
        }),
      ]);
    } catch (error) {
      // Rejected BEFORE the threshold (network failure, or the hard abort).
      clearTimeout(thresholdTimer);
      clearTimeout(timer);
      throw new FacebookSendError(error?.name === "AbortError" ? "GRAPH_TIMEOUT" : "GRAPH_NETWORK_ERROR", {
        ambiguous: true,
      });
    }
    clearTimeout(thresholdTimer);
    if (first === THRESHOLD) {
      // No headers by the threshold: AMBIGUOUS now, but keep observing the
      // SAME request until the hard deadline. `late` never rejects.
      const late = observeLateResponse(request, { controller, timer, startedAt, clock });
      throw new FacebookSendError("GRAPH_TIMEOUT", { ambiguous: true, late, thresholdMs, observeUntilMs: hardMs });
    }
    clearTimeout(timer);
    response = first.response;
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

/** A Facebook object id we are willing to link: digits, optionally `_digits`. */
const FACEBOOK_ID_PATTERN = /^[0-9]+(_[0-9]+)?$/;

/** Opaque Facebook diagnostic header -> safe short token, or null. */
function safeTraceHeader(response, name) {
  try {
    const v = response?.headers?.get?.(name);
    if (typeof v !== "string") return null;
    const t = v.trim();
    return /^[A-Za-z0-9_+/=.-]{1,80}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Phase 8.44 -- keep observing the ONE request after the ambiguity
 * threshold. Never issues a request, never rejects. Bounded by the hard
 * abort timer, which also bounds the body read. Result kinds:
 *   RESPONSE            headers arrived late (statusCode, id|null, bodyError|null)
 *   PENDING_AT_DEADLINE no headers before the hard deadline (we stopped observing)
 *   NETWORK_ERROR       the request failed after the threshold
 */
async function observeLateResponse(request, { controller, timer, startedAt, clock }) {
  const elapsed = () => Math.max(0, Math.round(clock() - startedAt));
  let response;
  try {
    response = await request;
  } catch (error) {
    clearTimeout(timer);
    return { kind: error?.name === "AbortError" ? "PENDING_AT_DEADLINE" : "NETWORK_ERROR", totalMs: elapsed() };
  }
  const headersMs = elapsed();
  const base = {
    kind: "RESPONSE",
    statusCode: Number(response.status) || null,
    headersMs,
    traceId: safeTraceHeader(response, "x-fb-trace-id"),
    requestId: safeTraceHeader(response, "x-fb-request-id"),
  };
  if (!(response.status >= 200 && response.status < 300)) {
    clearTimeout(timer);
    try {
      await response.body?.cancel?.();
    } catch {
      /* ignore */
    }
    return { ...base, id: null, bodyError: null, totalMs: elapsed() };
  }
  let id = null;
  let bodyError = null;
  try {
    const text = await untilAborted(Promise.resolve().then(() => response.text()), controller.signal);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      bodyError = "BODY_PARSE_ERROR";
    }
    if (!bodyError) {
      const raw = data && (typeof data.id === "string" || typeof data.id === "number") ? String(data.id) : "";
      if (FACEBOOK_ID_PATTERN.test(raw)) id = raw;
      else bodyError = "BODY_ID_MISSING";
    }
  } catch (error) {
    bodyError = error?.name === "AbortError" ? "BODY_TIMEOUT" : "BODY_READ_ERROR";
  } finally {
    clearTimeout(timer);
  }
  return { ...base, id, bodyError, totalMs: elapsed() };
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
