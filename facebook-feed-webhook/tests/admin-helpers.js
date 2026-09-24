/**
 * Test doubles for the NEXT-02 admin API.
 *
 * Kept separate from tests/helpers.js so the existing webhook test
 * harness is not modified at all.
 *
 * Credentials here are test-only literals. No real secret is ever
 * committed.
 */

import { hmacSha256Hex } from "../src/crypto.js";

export const TEST_PAGE_ID = "853313081388711";
export const TEST_ADMIN_PASSWORD = "unit-test-admin-password";
export const TEST_SESSION_SECRET = "unit-test-admin-session-secret";

export function createAdminEnv(overrides = {}) {
  return {
    META_APP_SECRET: "unit-test-meta-app-secret",
    META_VERIFY_TOKEN: "unit-test-verify-token",
    HERMES_API_KEY: "unit-test-hermes-api-key",
    REPLY_MODE: "DRY_RUN",
    PAGE_ID: TEST_PAGE_ID,
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    ADMIN_SESSION_SECRET: TEST_SESSION_SECRET,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * base64url helpers (mirror of the ones in src/admin.js)
 * ------------------------------------------------------------------ */

export function b64url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Forge a session token directly, so expiry/tampering can be tested. */
export async function makeSessionToken(secret, { iat, exp }) {
  const encoded = b64url(JSON.stringify({ iat, exp }));
  const signature = await hmacSha256Hex(secret, encoded);
  return `${encoded}.${signature}`;
}

export function cookieHeader(token) {
  return `admin_session=${token}`;
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export function adminGet(path, { cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  return new Request(`https://worker.example${path}`, { method: "GET", headers });
}

export function adminPost(path, body, { raw = false } = {}) {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
}

/** Extracts the session token from a Set-Cookie header. */
export function tokenFromSetCookie(setCookie) {
  const match = /admin_session=([^;]+)/.exec(setCookie || "");
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ *
 * Fake D1 implementing the listComments query semantics
 * ------------------------------------------------------------------ */

function sortDesc(rows) {
  return [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return Number(b.id) - Number(a.id);
  });
}

/**
 * Emulates the real SQL: page scope, optional status filter, keyset
 * cursor, DESC ordering, LIMIT, product join and latest-reply join.
 *
 * Parameters are decoded positionally in the same order db.js binds
 * them, with the SQL text telling us which optional clauses are present
 * -- so a mismatch between clause construction and parameter order shows
 * up as a test failure rather than passing silently.
 */
export function createAdminFakeD1({
  comments = [],
  replies = [],
  products = [],
  failSelect = false,
} = {}) {
  const state = { comments, replies, products, statements: [] };

  function prepare(sql) {
    state.statements.push(sql);
    return {
      bind(...args) {
        return {
          async all() {
            if (failSelect) throw new Error("d1 down");
            if (!/FROM comments c/i.test(sql)) {
              throw new Error("unexpected all(): " + sql);
            }

            let i = 0;
            const pageId = args[i++];
            const status = /c\.status = \?/.test(sql) ? args[i++] : null;

            let cursor = null;
            if (/c\.created_at < \?/.test(sql)) {
              const createdAt = args[i++];
              i++; // the repeated created_at in the OR branch
              const id = args[i++];
              cursor = { created_at: createdAt, id };
            }

            const limit = args[i++];

            let rows = state.comments.filter((c) => c.page_id === pageId);
            if (status) rows = rows.filter((c) => c.status === status);

            if (cursor) {
              rows = rows.filter(
                (c) =>
                  c.created_at < cursor.created_at ||
                  (c.created_at === cursor.created_at && Number(c.id) < Number(cursor.id))
              );
            }

            rows = sortDesc(rows).slice(0, limit);

            const results = rows.map((c) => {
              const product =
                c.matched_product_id === null || c.matched_product_id === undefined
                  ? null
                  : state.products.find((p) => Number(p.id) === Number(c.matched_product_id)) ?? null;

              const latest = sortDesc(
                state.replies.filter((r) => Number(r.comment_id) === Number(c.id))
              )[0];

              return {
                id: c.id,
                facebook_comment_id: c.facebook_comment_id,
                author_name: c.author_name,
                comment_text: c.comment_text,
                status: c.status,
                ai_response: c.ai_response ?? null,
                matched_product_id: c.matched_product_id ?? null,
                created_at: c.created_at,
                updated_at: c.updated_at,
                product_id: product ? product.id : null,
                product_name: product ? product.name : null,
                reply_mode: latest ? latest.mode : null,
                reply_status: latest ? latest.status : null,
                reply_facebook_reply_id: latest ? latest.facebook_reply_id ?? null : null,
              };
            });

            return { results };
          },

          async first() {
            throw new Error("unexpected first(): " + sql);
          },
          async run() {
            throw new Error("unexpected run(): " + sql);
          },
        };
      },
    };
  }

  return { prepare, _state: state };
}

/** Builds a deterministic comment fixture. */
export function comment(id, overrides = {}) {
  return {
    id,
    facebook_comment_id: `853313081388711_${1000 + id}`,
    facebook_post_id: "853313081388711_900",
    page_id: TEST_PAGE_ID,
    author_id: `author-${id}`,
    author_name: `User ${id}`,
    comment_text: `comment ${id}`,
    matched_product_id: null,
    ai_response: null,
    status: "PROCESSED",
    created_at: `2026-09-20 10:${String(id).padStart(2, "0")}:00`,
    updated_at: `2026-09-20 10:${String(id).padStart(2, "0")}:00`,
    ...overrides,
  };
}

export function reply(id, commentId, overrides = {}) {
  return {
    id,
    comment_id: commentId,
    response_text: "draft",
    mode: "DRY_RUN",
    facebook_reply_id: null,
    status: "GENERATED",
    error_message: null,
    created_at: `2026-09-20 11:${String(id).padStart(2, "0")}:00`,
    ...overrides,
  };
}
