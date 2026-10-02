/**
 * READ-ONLY Graph reader for Page posts and reels (Phase AM-2).
 *
 * GET only. This module has no code path that sends a body, uses another
 * HTTP method, or imports the reply sender (facebook-reply.js). The Page
 * access token travels in the Authorization header only -- never in a URL,
 * a log line, a returned value or an error.
 *
 * FAIL CLOSED. A failed read is returned as `error` (a stable category),
 * never as an empty successful result. Items parsed before a failure are
 * still returned (`items`) so the caller can keep them, but `error` is set
 * and `complete` is false, so a partial read can never look like success.
 *
 * No automatic retry: a transient error is reported and the operator runs
 * discovery again.
 *
 * Minimum fields only. No comments, no `from`, no media URLs or bytes, no
 * attachments.
 *
 * VERIFICATION STATUS (see docs/OPERATIONS.md): the edges and field names
 * below follow Meta's Page documentation but were NOT exercised against the
 * live Page -- no Page token is reachable from the build environment.
 */

/** Edge + field set per discovery source. */
export const POST_SOURCES = Object.freeze({
  posts: { edge: "published_posts", fields: "id,message,created_time,permalink_url,status_type", textField: "message" },
  reels: { edge: "video_reels", fields: "id,description,created_time,permalink_url", textField: "description" },
});

export const DISCOVERY_PAGE_LIMIT = 25;
export const DISCOVERY_MAX_PAGES = 2;
export const DISCOVERY_MAX_ITEMS = 50; // per source
// Time budget (AM-2.2). Each edge gets its OWN deadline, so one slow edge cannot
// starve the other (AM-2.1: a shared 20 s deadline let the reels edge use the
// budget and the posts edge timed out after one page). Graph answered in
// roughly 7-10 s per page in production, so an edge may complete 2 pages.
// The total is a hard outer bound for the whole run (2 edges + margin for D1).
export const DISCOVERY_EDGE_DEADLINE_MS = 20000;
export const DISCOVERY_TOTAL_DEADLINE_MS = 45000;

/** Post ids look like `<page>_<post>` (posts) or are numeric (reels/videos). */
export const POST_ID_PATTERN = /^[0-9]{5,}(_[0-9]+)?$/;

export const DISCOVERY_ERRORS = Object.freeze({
  TOKEN_INVALID: "TOKEN_INVALID", // Graph code 190 / 463 / 467 (expired, revoked, invalid)
  PERMISSION_DENIED: "PERMISSION_DENIED", // codes 10, 200-299
  RATE_LIMITED: "RATE_LIMITED", // codes 4, 17, 32, 613 or HTTP 429
  TRANSIENT: "TRANSIENT", // HTTP 5xx, codes 1 / 2
  GRAPH_REJECTED: "GRAPH_REJECTED", // any other 4xx
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  MALFORMED: "MALFORMED",
});

/**
 * Map a failed Graph HTTP response to a category. Only numeric codes are
 * read from the error body; its message text is never kept.
 * @param {number} status
 * @param {any} body parsed JSON or null
 * @returns {{category: string, graphCode: number|null}}
 */
export function classifyGraphFailure(status, body) {
  const code = Number.isInteger(body?.error?.code) ? body.error.code : null;
  if (code === 190 || code === 463 || code === 467) return { category: DISCOVERY_ERRORS.TOKEN_INVALID, graphCode: code };
  if (status === 401) return { category: DISCOVERY_ERRORS.TOKEN_INVALID, graphCode: code };
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return { category: DISCOVERY_ERRORS.PERMISSION_DENIED, graphCode: code };
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) return { category: DISCOVERY_ERRORS.RATE_LIMITED, graphCode: code };
  if (status >= 500 || code === 1 || code === 2) return { category: DISCOVERY_ERRORS.TRANSIENT, graphCode: code };
  if (status === 403) return { category: DISCOVERY_ERRORS.PERMISSION_DENIED, graphCode: code };
  return { category: DISCOVERY_ERRORS.GRAPH_REJECTED, graphCode: code };
}

function normalizePermalink(value) {
  if (typeof value !== "string" || !value || value.length > 500) return null;
  const absolute = value.startsWith("/") ? `https://www.facebook.com${value}` : value;
  try {
    const url = new URL(absolute);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com") ? absolute : null;
  } catch {
    return null;
  }
}

function normalizeCreatedTime(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Canonical Reel identity, derived ONLY from an explicit Reel permalink:
 *   https://www.facebook.com/reel/<digits>   (host www.facebook.com or facebook.com)
 * A trailing slash, query string and fragment are tolerated. Anything else
 * -- other hosts, http, credentials, ports, other paths, a malformed URL --
 * yields null. Nothing is inferred from message text, timestamps, post-id
 * strings or approximate matching.
 * @param {unknown} value
 * @returns {string|null}
 */
export function canonicalReelIdFromPermalink(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "www.facebook.com" && host !== "facebook.com") return null;
  const match = /^\/reel\/([0-9]{5,25})\/?$/.exec(url.pathname);
  return match ? match[1] : null;
}

/**
 * @param {string} sourceName 'posts' | 'reels'
 * @param {any} raw one Graph item
 * @returns {object|null} null when the item is unusable (no valid id)
 */
export function normalizeItem(sourceName, raw) {
  const source = POST_SOURCES[sourceName];
  if (!source || !raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : "";
  if (!POST_ID_PATTERN.test(id)) return null;

  const text = raw[source.textField];
  const permalink = normalizePermalink(raw.permalink_url);
  const statusType = typeof raw.status_type === "string" && /^[a-z_]{1,50}$/i.test(raw.status_type) ? raw.status_type : null;

  // Content type only where it is reliably identifiable; otherwise null.
  let contentType;
  if (sourceName === "reels") contentType = "REEL";
  else if (permalink && /\/reels?\//i.test(new URL(permalink).pathname)) contentType = "REEL";
  else if (statusType === "added_video") contentType = null; // video or reel: do not guess
  else contentType = "POST";

  return {
    post_id: id,
    content_type: contentType,
    message: typeof text === "string" ? text : null,
    permalink,
    fb_created_time: normalizeCreatedTime(raw.created_time),
    source_status_type: statusType,
    discovery_source: sourceName,
    canonical_reel_id: canonicalReelIdFromPermalink(permalink),
  };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

/**
 * Read one source, bounded by pages, items and a deadline.
 *
 * @param {"posts"|"reels"} sourceName
 * @param {{pageId: string, accessToken: string, graphApiVersion?: string, deadlineAt: number,
 *          limit?: number, maxPages?: number, maxItems?: number, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{items: object[], skipped: number, pages: number, complete: boolean, truncated: boolean,
 *           error: null | {category: string, graphCode: number|null, statusCode: number|null}}>}
 */
export async function fetchPageContent(sourceName, options) {
  const {
    pageId,
    accessToken,
    graphApiVersion = "v21.0",
    deadlineAt,
    limit = DISCOVERY_PAGE_LIMIT,
    maxPages = DISCOVERY_MAX_PAGES,
    maxItems = DISCOVERY_MAX_ITEMS,
    fetchImpl = fetch,
  } = options || {};
  const source = POST_SOURCES[sourceName];
  const result = { items: [], skipped: 0, pages: 0, complete: false, truncated: false, error: null };
  const fail = (category, statusCode = null, graphCode = null) => {
    result.error = { category, graphCode, statusCode };
    return result;
  };

  if (!source) return fail(DISCOVERY_ERRORS.MALFORMED);
  if (!accessToken) return fail(DISCOVERY_ERRORS.TOKEN_INVALID);
  if (!/^[0-9]+$/.test(String(pageId || ""))) return fail(DISCOVERY_ERRORS.MALFORMED);

  const remaining = Number(deadlineAt) - Date.now();
  if (!(remaining > 0)) return fail(DISCOVERY_ERRORS.TIMEOUT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  const seen = new Set();

  try {
    let after = null;
    for (let page = 1; page <= Math.max(1, maxPages); page += 1) {
      const params = new URLSearchParams({ fields: source.fields, limit: String(limit) });
      if (after) params.set("after", after);
      const url = `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(pageId)}/${source.edge}?${params}`;

      let response;
      let text;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        text = await abortable(Promise.resolve(response.text()), controller.signal);
      } catch (error) {
        return fail(error?.name === "AbortError" ? DISCOVERY_ERRORS.TIMEOUT : DISCOVERY_ERRORS.NETWORK);
      }

      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (response.status < 200 || response.status >= 300) {
        const failure = classifyGraphFailure(response.status, data);
        return fail(failure.category, response.status, failure.graphCode);
      }
      if (!data || typeof data !== "object" || !Array.isArray(data.data)) {
        return fail(DISCOVERY_ERRORS.MALFORMED, response.status);
      }
      // A 200 carrying an error object is a failure, not an empty page.
      if (data.error) return fail(DISCOVERY_ERRORS.MALFORMED, response.status);

      result.pages = page;
      for (const raw of data.data) {
        const item = normalizeItem(sourceName, raw);
        if (!item || seen.has(item.post_id)) {
          result.skipped += 1;
          continue;
        }
        seen.add(item.post_id);
        if (result.items.length >= maxItems) {
          result.truncated = true;
          continue;
        }
        result.items.push(item);
      }

      const hasNext = Boolean(data.paging && data.paging.next);
      if (!hasNext) {
        result.complete = !result.truncated;
        return result;
      }
      if (result.truncated || page >= maxPages) {
        result.truncated = true;
        return result;
      }
      after = data.paging?.cursors?.after;
      if (typeof after !== "string" || !after) return fail(DISCOVERY_ERRORS.MALFORMED, response.status);
    }
    result.truncated = true;
    return result;
  } finally {
    clearTimeout(timer);
  }
}
