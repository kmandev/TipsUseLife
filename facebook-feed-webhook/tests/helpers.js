/**
 * Test doubles. No network, no real database, no Facebook.
 */

import { hmacSha256Hex } from "../src/crypto.js";
import { createSqliteD1 } from "./sqlite-d1.js";

export const TEST_PAGE_ID = "853313081388711";
export const TEST_META_SECRET = "unit-test-meta-app-secret";
export const TEST_VERIFY_TOKEN = "unit-test-verify-token";
export const TEST_HERMES_API_KEY = "unit-test-hermes-api-key-0123456789";

/**
 * D1 test double: a real in-memory SQLite database with all migrations
 * applied (see sqlite-d1.js). `products` rows are inserted as given;
 * `mappings` are content_mappings rows; `failInsert` makes the comment
 * INSERT fail like a D1 outage.
 */
export function createFakeD1({ products = [], mappings = [], failInsert = false, failOn = null } = {}) {
  const db = createSqliteD1({ failOn: failInsert ? /INSERT INTO comments/i : failOn });
  for (const p of products) {
    db._sqlite
      .prepare(
        `INSERT INTO products (id, name, description, keywords, shopee_url, affiliate_url, platform, active, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        p.id,
        p.name,
        p.description ?? null,
        p.keywords ?? "",
        p.shopee_url ?? null,
        p.affiliate_url ?? p.shopee_url ?? null,
        p.platform ?? "shopee",
        p.active ?? 1,
        p.deleted_at ?? null
      );
  }
  for (const m of mappings) {
    db._sqlite
      .prepare(
        `INSERT INTO content_mappings (facebook_page_id, facebook_post_id, facebook_content_type, product_id, active)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(m.facebook_page_id ?? TEST_PAGE_ID, m.facebook_post_id, m.facebook_content_type ?? "POST", m.product_id, m.active ?? 1);
  }
  return db;
}

export function createEnv(overrides = {}) {
  return {
    META_APP_SECRET: TEST_META_SECRET,
    META_VERIFY_TOKEN: TEST_VERIFY_TOKEN,
    HERMES_API_KEY: TEST_HERMES_API_KEY,
    REPLY_MODE: "DRY_RUN",
    PAGE_ID: TEST_PAGE_ID,
    HERMES_URL: "https://hermes-feed.example.invalid/v1/chat/completions",
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

/**
 * A Hermes /v1/chat/completions success body whose assistant content is
 * `content` (an object is JSON-encoded, a string is used verbatim).
 */
export function hermesChat(content, status = 200) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return jsonResponse(
    {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    status
  );
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
