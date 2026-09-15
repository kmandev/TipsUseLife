/**
 * Test doubles. No network, no real database, no Facebook.
 */

import { hmacSha256Hex } from "../src/crypto.js";

export const TEST_PAGE_ID = "853313081388711";
export const TEST_META_SECRET = "unit-test-meta-app-secret";
export const TEST_VERIFY_TOKEN = "unit-test-verify-token";
export const TEST_HERMES_SECRET = "unit-test-hermes-secret";

/** Minimal in-memory D1 stand-in with the real UNIQUE / ON CONFLICT semantics. */
export function createFakeD1({ products = [], failInsert = false } = {}) {
  const state = {
    comments: [],
    replies: [],
    products,
    nextCommentId: 1,
    statements: [],
  };

  function prepare(sql) {
    state.statements.push(sql);
    return {
      bind(...args) {
        return {
          async first() {
            if (/INSERT INTO comments/i.test(sql)) {
              if (failInsert) throw new Error("d1 down");
              const [
                facebook_comment_id,
                facebook_post_id,
                facebook_parent_id,
                page_id,
                author_id,
                author_name,
                comment_text,
                facebook_created_time,
              ] = args;

              // UNIQUE(facebook_comment_id) + ON CONFLICT DO NOTHING
              if (state.comments.some((c) => c.facebook_comment_id === facebook_comment_id)) {
                return null;
              }

              const row = {
                id: state.nextCommentId++,
                facebook_comment_id,
                facebook_post_id,
                facebook_parent_id,
                page_id,
                author_id,
                author_name,
                comment_text,
                facebook_created_time,
                matched_product_id: null,
                ai_response: null,
                status: "RECEIVED",
              };
              state.comments.push(row);
              return { id: row.id };
            }
            throw new Error("unexpected first(): " + sql);
          },

          async all() {
            if (/FROM products/i.test(sql)) {
              return { results: state.products.filter((p) => Number(p.active) === 1) };
            }
            throw new Error("unexpected all(): " + sql);
          },

          async run() {
            if (/UPDATE comments\s+SET status = \?,\s+ai_response/i.test(sql)) {
              const [status, aiResponse, matchedProductId, id] = args;
              const row = state.comments.find((c) => c.id === id);
              if (row) {
                row.status = status;
                row.ai_response = aiResponse;
                row.matched_product_id = matchedProductId;
              }
              return { success: true };
            }
            if (/UPDATE comments/i.test(sql)) {
              const [status, id] = args;
              const row = state.comments.find((c) => c.id === id);
              if (row) row.status = status;
              return { success: true };
            }
            if (/INSERT INTO replies/i.test(sql)) {
              const [comment_id, response_text, mode, facebook_reply_id, status, error_message] = args;
              state.replies.push({
                id: state.replies.length + 1,
                comment_id,
                response_text,
                mode,
                facebook_reply_id,
                status,
                error_message,
              });
              return { success: true };
            }
            throw new Error("unexpected run(): " + sql);
          },
        };
      },
    };
  }

  return { prepare, _state: state };
}

export function createEnv(overrides = {}) {
  return {
    META_APP_SECRET: TEST_META_SECRET,
    META_VERIFY_TOKEN: TEST_VERIFY_TOKEN,
    HERMES_SECRET: TEST_HERMES_SECRET,
    REPLY_MODE: "DRY_RUN",
    PAGE_ID: TEST_PAGE_ID,
    HERMES_URL: "https://hermes-feed.example.invalid/webhooks/facebook-comments",
    ...overrides,
  };
}

/** ctx double that lets tests await the background work deterministically. */
export function createCtx() {
  const promises = [];
  return {
    waitUntil(p) {
      promises.push(p);
    },
    async settle() {
      await Promise.allSettled(promises);
    },
  };
}

export function commentPayload(overrides = {}) {
  const value = {
    item: "comment",
    verb: "add",
    comment_id: "853313081388711_1001",
    post_id: "853313081388711_900",
    parent_id: null,
    message: "สนใจครับ",
    created_time: 1789400000,
    from: { id: "7777777777", name: "Somchai" },
    ...(overrides.value || {}),
  };

  return {
    object: overrides.object ?? "page",
    entry: [
      {
        id: TEST_PAGE_ID,
        time: 1789400000,
        changes: [{ field: overrides.field ?? "feed", value }],
      },
    ],
  };
}

export async function signedRequest(body, { secret = TEST_META_SECRET, signature } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const sig = signature ?? `sha256=${await hmacSha256Hex(secret, raw)}`;

  return new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
}

/**
 * Replace global fetch. Returns a recorder so tests can assert exactly
 * which hosts were contacted -- this is how "no Facebook mutation" is
 * proven rather than assumed.
 */
export function installFetchMock(handler) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET", init });
    return handler(String(url), init, calls.length);
  };

  return {
    calls,
    graphCalls: () => calls.filter((c) => /graph\.facebook\.com/i.test(c.url)),
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function jsonResponse(data, status = 200) {
  return new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Capture console output so tests can assert secrets never appear. */
export function captureConsole() {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];

  console.log = (...args) => lines.push(args.map(String).join(" "));
  console.error = (...args) => lines.push(args.map(String).join(" "));

  return {
    lines,
    text: () => lines.join("\n"),
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}
