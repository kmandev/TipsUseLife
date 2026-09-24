/**
 * Admin surface: Dashboard shell, session, and JSON APIs.
 *
 *   GET  /admin, /admin/          -> Dashboard single-page app (static)
 *   GET  /admin/app.js, app.css   -> Dashboard assets (static)
 *   POST /admin/login             -> issues a signed, HttpOnly session cookie
 *   POST /admin/logout            -> clears it
 *   GET  /admin/session           -> {authenticated}
 *   GET  /admin/comments          -> paginated, page-scoped comment activity
 *   *    /admin/api/...           -> products / content mappings / overview
 *                                    (see admin-api.js)
 *
 * SCOPE / SAFETY
 * --------------
 * Never touches Facebook, Hermes or Meta, and cannot change REPLY_MODE.
 * Every data route authenticates BEFORE touching D1. State-changing
 * requests additionally require a same-origin `Origin` header and a JSON
 * body (CSRF defence on top of the SameSite=Strict cookie).
 *
 * Secrets (ADMIN_PASSWORD, ADMIN_SESSION_SECRET) are read from env only.
 * They are never logged, never returned, never sent to the browser and
 * never stored in D1. The browser only ever receives an opaque
 * payload+HMAC session token.
 */

import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";
import { resolveConfig } from "./config.js";
import { listComments } from "./db.js";
import { logEvent, logError } from "./log.js";
import { handleAdminApi } from "./admin-api.js";
import { DASHBOARD_HTML, DASHBOARD_JS, DASHBOARD_CSS, DASHBOARD_CSP } from "./dashboard.js";

const SESSION_COOKIE = "admin_session";
const SESSION_TTL_SECONDS = 86400; // 24 hours

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

export const ADMIN_LOGIN_PATH = "/admin/login";
export const ADMIN_LOGOUT_PATH = "/admin/logout";
export const ADMIN_SESSION_PATH = "/admin/session";
export const ADMIN_COMMENTS_PATH = "/admin/comments";
export const ADMIN_API_PREFIX = "/admin/api/";

/**
 * Exactly the comment statuses the schema allows
 * (see database/migrations/0001_initial.sql).
 */
export const ALLOWED_STATUSES = Object.freeze([
  "RECEIVED",
  "PROCESSED",
  "REPLIED",
  "SKIPPED",
  "ERROR",
]);

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

function apiJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/**
 * The only error shape this API ever emits. No SQL, no exception text,
 * no environment values -- just a stable code and a generic message.
 */
function apiError(status, code, message, extraHeaders = {}) {
  return apiJson({ error: { code, message } }, status, extraHeaders);
}

function unauthenticated(message) {
  return apiError(401, "UNAUTHENTICATED", message);
}

function methodNotAllowed(allow) {
  return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: allow });
}

/* ------------------------------------------------------------------ *
 * base64url (payload encoding for sessions and cursors)
 * ------------------------------------------------------------------ */

function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on malformed input -- every caller wraps this in try/catch. */
function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Session token = base64url(JSON payload) + "." + HMAC-SHA256 hex.
 *
 * The signing secret never leaves the Worker; the browser holds only the
 * payload and its signature, and cannot forge or extend either.
 */
export async function issueSession(secret, issuedAt = nowSeconds()) {
  const payload = { iat: issuedAt, exp: issuedAt + SESSION_TTL_SECONDS };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256Hex(secret, encoded);
  return `${encoded}.${signature}`;
}

/**
 * Fail-closed verification. Returns true only for a well-formed,
 * correctly-signed, unexpired session.
 */
export async function verifySession(secret, token, at = nowSeconds()) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof token !== "string" || token.length === 0) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [encoded, signature] = parts;
  if (!encoded || !signature) return false;

  // Both sides are fixed-length hex digests, so the comparison is
  // constant-time over equal lengths.
  const expected = await hmacSha256Hex(secret, encoded);
  if (!timingSafeEqual(expected, signature)) return false;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return false;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const { iat, exp } = payload;
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return false;
  if (exp <= at) return false;
  // A signed token may not claim a longer life than we ever issue.
  if (exp - iat > SESSION_TTL_SECONDS) return false;

  return true;
}

/** Reads the session cookie. The raw Cookie header is never logged. */
function readSessionCookie(request) {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    return part.slice(index + 1).trim();
  }
  return null;
}

function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

/* ------------------------------------------------------------------ *
 * Password comparison
 * ------------------------------------------------------------------ */

/**
 * Constant-time password check that is safe for unequal lengths.
 *
 * Comparing the raw strings would short-circuit on a length mismatch and
 * leak the secret's length. Instead both sides are HMAC'd first: the
 * digests are always 64 hex characters, so timingSafeEqual always runs
 * its full loop and never sees inputs of differing length.
 */
async function passwordMatches(env, supplied) {
  const expected = env?.ADMIN_PASSWORD;
  const signingSecret = env?.ADMIN_SESSION_SECRET;

  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof signingSecret !== "string" || signingSecret.length === 0) return false;
  if (typeof supplied !== "string") return false;

  const [suppliedDigest, expectedDigest] = await Promise.all([
    hmacSha256Hex(signingSecret, supplied),
    hmacSha256Hex(signingSecret, expected),
  ]);

  return timingSafeEqual(suppliedDigest, expectedDigest);
}

/* ------------------------------------------------------------------ *
 * Cursor
 * ------------------------------------------------------------------ */

/**
 * The cursor is an opaque position marker, NOT an authorization
 * credential -- authorization is the session cookie's job -- so it is
 * encoded but deliberately not signed.
 */
export function encodeCursor(row) {
  return base64UrlEncode(JSON.stringify({ created_at: row.created_at, id: row.id }));
}

/** @returns {{created_at: string, id: number}|null} null when malformed. */
export function decodeCursor(value) {
  try {
    const parsed = JSON.parse(base64UrlDecode(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const { created_at: createdAt, id } = parsed;
    if (typeof createdAt !== "string" || createdAt.length === 0) return null;
    if (!Number.isInteger(id)) return null;

    return { created_at: createdAt, id };
  } catch {
    // Parser exceptions are swallowed on purpose: callers turn this into
    // a generic INVALID_CURSOR, never a stack trace.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

/**
 * Maps a joined D1 row onto the public contract.
 *
 * Deliberately omitted: author_id (PII), page_id, facebook_post_id,
 * and replies.error_message (an internal category, not a UI field).
 */
function mapRow(row) {
  const hasProduct = row.product_id !== null && row.product_id !== undefined;
  const hasReply = row.reply_mode !== null && row.reply_mode !== undefined;

  return {
    id: Number(row.id),
    facebook_comment_id: row.facebook_comment_id ?? null,
    author_name: row.author_name ?? null,
    comment_text: row.comment_text ?? null,
    status: row.status,
    matched_product: hasProduct
      ? { id: Number(row.product_id), name: row.product_name ?? null }
      : null,
    product_source: row.product_source ?? null,
    ai_action: row.ai_action ?? null,
    facebook_post_id: row.facebook_post_id ?? null,
    ai_response: row.ai_response ?? null,
    reply: hasReply
      ? {
          mode: row.reply_mode,
          status: row.reply_status ?? null,
          facebook_reply_id: row.reply_facebook_reply_id ?? null,
          response_text: row.reply_text ?? null,
          // A fixed, secret-free category (e.g. AI_ACTION_SKIP), never
          // exception text.
          reason: row.reply_reason ?? null,
        }
      : null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Route handlers
 * ------------------------------------------------------------------ */

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    // Malformed JSON gets the same generic answer as a wrong password:
    // an attacker learns nothing about which part failed.
    logError("admin_login_rejected", "INVALID_REQUEST");
    return unauthenticated("Invalid credentials");
  }

  const supplied = body?.password;
  const ok =
    typeof supplied === "string" &&
    supplied.length > 0 &&
    (await passwordMatches(env, supplied));

  if (!ok) {
    // One category for every failure mode -- missing password, wrong
    // password, and unconfigured secret are indistinguishable.
    logError("admin_login_rejected", "INVALID_CREDENTIALS");
    return unauthenticated("Invalid credentials");
  }

  const token = await issueSession(env.ADMIN_SESSION_SECRET);
  logEvent("admin_login_ok", {});

  return apiJson({ ok: true }, 200, { "set-cookie": sessionCookieHeader(token) });
}

async function handleComments(request, url, env) {
  // ---- 1. Authenticate BEFORE touching D1 --------------------------
  const authenticated = await verifySession(
    env?.ADMIN_SESSION_SECRET,
    readSessionCookie(request)
  );

  if (!authenticated) {
    logError("admin_request_rejected", "UNAUTHENTICATED", { path: url.pathname });
    return unauthenticated("Authentication required");
  }

  // ---- 2. Validate query parameters --------------------------------
  const statusParam = url.searchParams.get("status");
  let status = null;
  if (statusParam !== null) {
    if (!ALLOWED_STATUSES.includes(statusParam)) {
      return apiError(400, "INVALID_STATUS", "Invalid comment status");
    }
    status = statusParam;
  }

  const limitParam = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    // Values outside the range are rejected, never silently clamped.
    if (!/^\d+$/.test(limitParam.trim())) {
      return apiError(400, "INVALID_LIMIT", "Invalid limit");
    }
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < MIN_LIMIT || parsed > MAX_LIMIT) {
      return apiError(400, "INVALID_LIMIT", "Invalid limit");
    }
    limit = parsed;
  }

  const cursorParam = url.searchParams.get("cursor");
  let cursor = null;
  if (cursorParam !== null) {
    cursor = decodeCursor(cursorParam);
    if (!cursor) {
      return apiError(400, "INVALID_CURSOR", "Invalid cursor");
    }
  }

  if (!env?.DB) {
    logError("admin_comments_failed", "D1_BINDING_MISSING");
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }

  // ---- 3. Query, scoped to our own Page ----------------------------
  const config = resolveConfig(env);

  let rows;
  try {
    rows = await listComments(env.DB, {
      pageId: config.pageId,
      status,
      // One extra row is the has_more probe.
      limit: limit + 1,
      cursor,
    });
  } catch {
    logError("admin_comments_failed", "D1_SELECT_FAILED");
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.length > 0 ? page[page.length - 1] : null;

  logEvent("admin_comments_listed", {
    status: status ?? "ALL",
    limit,
    returned: page.length,
    has_more: hasMore,
  });

  return apiJson({
    data: page.map(mapRow),
    next_cursor:
      hasMore && last ? encodeCursor({ created_at: last.created_at, id: Number(last.id) }) : null,
    has_more: hasMore,
  });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

/** Claims "/admin" and everything under "/admin/"; nothing else. */
export function isAdminPath(pathname) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function staticAsset(body, contentType, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...extra,
    },
  });
}

async function isAuthenticated(request, env) {
  return verifySession(env?.ADMIN_SESSION_SECRET, readSessionCookie(request));
}

/** Same-origin + JSON requirement for every state-changing request. */
function passesCsrfCheck(request, url) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== url.origin) return false;
  const type = request.headers.get("content-type") || "";
  if (request.method !== "DELETE" && !type.toLowerCase().startsWith("application/json")) return false;
  return true;
}

export async function handleAdminRequest(request, url, env) {
  try {
    const path = url.pathname;

    if (path === "/admin" || path === "/admin/") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return staticAsset(DASHBOARD_HTML, "text/html; charset=utf-8", {
        "content-security-policy": DASHBOARD_CSP,
        "x-frame-options": "DENY",
      });
    }
    if (path === "/admin/app.js") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return staticAsset(DASHBOARD_JS, "text/javascript; charset=utf-8");
    }
    if (path === "/admin/app.css") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return staticAsset(DASHBOARD_CSS, "text/css; charset=utf-8");
    }

    if (path === ADMIN_LOGIN_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await handleLogin(request, env);
    }

    if (path === ADMIN_LOGOUT_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return apiJson({ ok: true }, 200, {
        "set-cookie": `${SESSION_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      });
    }

    if (path === ADMIN_SESSION_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return apiJson({ authenticated: await isAuthenticated(request, env) });
    }

    if (path === ADMIN_COMMENTS_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await handleComments(request, url, env);
    }

    if (path.startsWith(ADMIN_API_PREFIX)) {
      if (!(await isAuthenticated(request, env))) {
        logError("admin_request_rejected", "UNAUTHENTICATED", { path });
        return unauthenticated("Authentication required");
      }
      if (request.method !== "GET" && !passesCsrfCheck(request, url)) {
        logError("admin_request_rejected", "CSRF_CHECK_FAILED", { path });
        return apiError(403, "FORBIDDEN", "Cross-site request rejected");
      }
      return await handleAdminApi(request, url, env, path.slice("/admin/api".length));
    }

    return apiError(404, "NOT_FOUND", "Not found");
  } catch {
    // Last line of defence: no exception, message or stack ever escapes.
    logError("admin_unhandled", "UNHANDLED_EXCEPTION", { path: url.pathname });
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
}
