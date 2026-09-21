/**
 * NEXT-02 -- admin read API tests.
 *
 * No network, no real D1, no Facebook. Credentials are test-only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  TEST_PAGE_ID,
  TEST_ADMIN_PASSWORD,
  TEST_SESSION_SECRET,
  createAdminEnv,
  createAdminFakeD1,
  makeSessionToken,
  cookieHeader,
  adminGet,
  adminPost,
  tokenFromSetCookie,
  b64url,
  comment,
  reply,
} from "./admin-helpers.js";

const ctx = { waitUntil() {} };

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function validCookie() {
  const now = nowSeconds();
  const token = await makeSessionToken(TEST_SESSION_SECRET, {
    iat: now,
    exp: now + 3600,
  });
  return cookieHeader(token);
}

/** Eight comments across every status, newest first by construction. */
function seed() {
  return createAdminFakeD1({
    comments: [
      comment(1, { status: "RECEIVED" }),
      comment(2, { status: "PROCESSED", ai_response: "draft 2" }),
      comment(3, { status: "REPLIED", ai_response: "draft 3", matched_product_id: 7 }),
      comment(4, { status: "SKIPPED" }),
      comment(5, { status: "ERROR" }),
      comment(6, { status: "PROCESSED" }),
      comment(7, { status: "PROCESSED" }),
      comment(8, { status: "PROCESSED" }),
    ],
    replies: [reply(1, 3, { mode: "DRY_RUN", status: "GENERATED" })],
    products: [{ id: 7, name: "เครื่องตัดหญ้าไร้สาย DR.WOOT" }],
  });
}

/* ================================================================== *
 * 1-4  Session enforcement on GET /admin/comments
 * ================================================================== */

test("1. GET /admin/comments without a session is 401", async () => {
  const db = seed();
  const response = await worker.fetch(adminGet("/admin/comments"), createAdminEnv({ DB: db }), ctx);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: { code: "UNAUTHENTICATED", message: "Authentication required" },
  });
  // Authentication happens before D1 is consulted.
  assert.equal(db._state.statements.length, 0);
});

test("2. GET /admin/comments with a malformed session is 401", async () => {
  const db = seed();
  const malformed = [
    "garbage",
    "a.b.c",
    "onlyonepart",
    ".",
    `${b64url(JSON.stringify({ iat: 1, exp: 9999999999 }))}.deadbeef`,
  ];

  for (const token of malformed) {
    const response = await worker.fetch(
      adminGet("/admin/comments", { cookie: cookieHeader(token) }),
      createAdminEnv({ DB: db }),
      ctx
    );
    assert.equal(response.status, 401, `token=${token}`);
  }
  assert.equal(db._state.statements.length, 0, "D1 never touched");
});

test("2b. a tampered payload with a stale signature is 401", async () => {
  const db = seed();
  const now = nowSeconds();
  const token = await makeSessionToken(TEST_SESSION_SECRET, { iat: now, exp: now + 3600 });
  const [, signature] = token.split(".");

  // Re-sign nothing: swap the payload for a longer-lived one, keep the old signature.
  const forged = `${b64url(JSON.stringify({ iat: now, exp: now + 999999 }))}.${signature}`;

  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: cookieHeader(forged) }),
    createAdminEnv({ DB: db }),
    ctx
  );
  assert.equal(response.status, 401);
});

test("3. GET /admin/comments with an expired session is 401", async () => {
  const db = seed();
  const now = nowSeconds();
  const expired = await makeSessionToken(TEST_SESSION_SECRET, {
    iat: now - 90000,
    exp: now - 10,
  });

  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: cookieHeader(expired) }),
    createAdminEnv({ DB: db }),
    ctx
  );

  assert.equal(response.status, 401);
  assert.equal(db._state.statements.length, 0);
});

test("3b. a session claiming more than 24h of life is rejected", async () => {
  const db = seed();
  const now = nowSeconds();
  const overlong = await makeSessionToken(TEST_SESSION_SECRET, {
    iat: now,
    exp: now + 86400 * 30,
  });

  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: cookieHeader(overlong) }),
    createAdminEnv({ DB: db }),
    ctx
  );
  assert.equal(response.status, 401);
});

test("4. GET /admin/comments with a valid session is 200", async () => {
  const db = seed();
  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: db }),
    ctx
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.data));
  assert.equal(body.data.length, 8);
  assert.equal(body.has_more, false);
  assert.equal(body.next_cursor, null);
});

/* ================================================================== *
 * 5-7  POST /admin/login
 * ================================================================== */

test("5. POST /admin/login with the correct password sets a session cookie", async () => {
  const response = await worker.fetch(
    adminPost("/admin/login", { password: TEST_ADMIN_PASSWORD }),
    createAdminEnv({ DB: seed() }),
    ctx
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Set-Cookie present");
  assert.match(setCookie, /^admin_session=/);
  assert.match(setCookie, /Path=\/admin/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=86400/);
});

test("5b. the issued cookie actually authenticates the comments route", async () => {
  const env = createAdminEnv({ DB: seed() });

  const login = await worker.fetch(
    adminPost("/admin/login", { password: TEST_ADMIN_PASSWORD }),
    env,
    ctx
  );
  const token = tokenFromSetCookie(login.headers.get("set-cookie"));
  assert.ok(token);

  const listed = await worker.fetch(
    adminGet("/admin/comments", { cookie: cookieHeader(token) }),
    env,
    ctx
  );
  assert.equal(listed.status, 200);
});

test("6. POST /admin/login with the wrong password is 401", async () => {
  const db = seed();
  for (const password of ["wrong", "", "unit-test-admin-passwor", "unit-test-admin-passwordX"]) {
    const response = await worker.fetch(
      adminPost("/admin/login", { password }),
      createAdminEnv({ DB: db }),
      ctx
    );
    assert.equal(response.status, 401, `password=${JSON.stringify(password)}`);
    assert.deepEqual(await response.json(), {
      error: { code: "UNAUTHENTICATED", message: "Invalid credentials" },
    });
  }
});

test("7. missing/invalid password bodies are 401 and indistinguishable", async () => {
  const db = seed();
  const bodies = [{}, { password: null }, { password: 123 }, { password: { a: 1 } }, []];

  for (const body of bodies) {
    const response = await worker.fetch(
      adminPost("/admin/login", body),
      createAdminEnv({ DB: db }),
      ctx
    );
    assert.equal(response.status, 401, JSON.stringify(body));
    assert.deepEqual(await response.json(), {
      error: { code: "UNAUTHENTICATED", message: "Invalid credentials" },
    });
  }

  // Malformed JSON gets the exact same answer -- no enumeration signal.
  const malformed = await worker.fetch(
    adminPost("/admin/login", "{not json", { raw: true }),
    createAdminEnv({ DB: db }),
    ctx
  );
  assert.equal(malformed.status, 401);
  assert.deepEqual(await malformed.json(), {
    error: { code: "UNAUTHENTICATED", message: "Invalid credentials" },
  });
});

test("7b. login fails closed when the admin secrets are not configured", async () => {
  for (const env of [
    createAdminEnv({ DB: seed(), ADMIN_PASSWORD: undefined }),
    createAdminEnv({ DB: seed(), ADMIN_SESSION_SECRET: undefined }),
    createAdminEnv({ DB: seed(), ADMIN_PASSWORD: "" }),
  ]) {
    const response = await worker.fetch(
      adminPost("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      env,
      ctx
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

/* ================================================================== *
 * 8-14  status filtering
 * ================================================================== */

test("8. status omitted returns every status", async () => {
  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: seed() }),
    ctx
  );

  const body = await response.json();
  const statuses = new Set(body.data.map((c) => c.status));
  assert.deepEqual(
    [...statuses].sort(),
    ["ERROR", "PROCESSED", "RECEIVED", "REPLIED", "SKIPPED"]
  );
});

for (const status of ["RECEIVED", "PROCESSED", "REPLIED", "SKIPPED", "ERROR"]) {
  test(`9-13. status=${status} returns only that status`, async () => {
    const response = await worker.fetch(
      adminGet(`/admin/comments?status=${status}`, { cookie: await validCookie() }),
      createAdminEnv({ DB: seed() }),
      ctx
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.data.length > 0, `${status} has fixtures`);
    for (const row of body.data) assert.equal(row.status, status);
  });
}

test("14. an unknown status is 400 INVALID_STATUS", async () => {
  const db = seed();
  for (const status of ["BOGUS", "received", "'; DROP TABLE comments;--", ""]) {
    const response = await worker.fetch(
      adminGet(`/admin/comments?status=${encodeURIComponent(status)}`, {
        cookie: await validCookie(),
      }),
      createAdminEnv({ DB: db }),
      ctx
    );

    assert.equal(response.status, 400, `status=${status}`);
    assert.deepEqual(await response.json(), {
      error: { code: "INVALID_STATUS", message: "Invalid comment status" },
    });
  }
  assert.equal(db._state.statements.length, 0, "rejected before any query");
});

/* ================================================================== *
 * 15-19  limit validation
 * ================================================================== */

test("15. omitted limit defaults to 20", async () => {
  const db = createAdminFakeD1({
    comments: Array.from({ length: 30 }, (_, i) => comment(i + 1)),
  });

  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: db }),
    ctx
  );

  const body = await response.json();
  assert.equal(body.data.length, 20);
  assert.equal(body.has_more, true);
});

test("16. limit=1 returns one row", async () => {
  const response = await worker.fetch(
    adminGet("/admin/comments?limit=1", { cookie: await validCookie() }),
    createAdminEnv({ DB: seed() }),
    ctx
  );

  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.has_more, true);
  assert.ok(body.next_cursor);
});

test("17. limit=100 is accepted", async () => {
  const response = await worker.fetch(
    adminGet("/admin/comments?limit=100", { cookie: await validCookie() }),
    createAdminEnv({ DB: seed() }),
    ctx
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 8);
  assert.equal(body.has_more, false);
});

test("18/19. out-of-range limits are 400 INVALID_LIMIT, never clamped", async () => {
  const db = seed();
  for (const limit of ["0", "101", "-1", "1000", "abc", "1.5", " ", "1e2"]) {
    const response = await worker.fetch(
      adminGet(`/admin/comments?limit=${encodeURIComponent(limit)}`, {
        cookie: await validCookie(),
      }),
      createAdminEnv({ DB: db }),
      ctx
    );

    assert.equal(response.status, 400, `limit=${limit}`);
    assert.deepEqual(await response.json(), {
      error: { code: "INVALID_LIMIT", message: "Invalid limit" },
    });
  }
  assert.equal(db._state.statements.length, 0, "rejected before any query");
});

/* ================================================================== *
 * 20-24  cursor pagination
 * ================================================================== */

test("20-22/24. pages walk the whole set with no overlap and no gaps", async () => {
  const env = createAdminEnv({ DB: seed() });
  const cookie = await validCookie();

  const seen = [];
  let cursor = null;
  let pages = 0;

  for (;;) {
    const path = cursor
      ? `/admin/comments?limit=3&cursor=${encodeURIComponent(cursor)}`
      : "/admin/comments?limit=3";

    const response = await worker.fetch(adminGet(path, { cookie }), env, ctx);
    assert.equal(response.status, 200);

    const body = await response.json();
    seen.push(...body.data.map((c) => c.id));
    pages += 1;

    if (!body.has_more) {
      // 24. final page
      assert.equal(body.next_cursor, null);
      break;
    }

    assert.ok(body.next_cursor, "has_more implies a cursor");
    cursor = body.next_cursor;
    assert.ok(pages < 10, "terminates");
  }

  // Newest first, every row exactly once.
  assert.deepEqual(seen, [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(new Set(seen).size, seen.length, "no overlap between pages");
  assert.equal(pages, 3);
});

test("21b. cursor pagination is stable when created_at ties", async () => {
  // Same created_at on every row: the id tiebreaker must still give a
  // total order with no repeats.
  const db = createAdminFakeD1({
    comments: [1, 2, 3, 4, 5].map((id) =>
      comment(id, { created_at: "2026-09-20 10:00:00", updated_at: "2026-09-20 10:00:00" })
    ),
  });
  const env = createAdminEnv({ DB: db });
  const cookie = await validCookie();

  const seen = [];
  let cursor = null;

  for (;;) {
    const path = cursor
      ? `/admin/comments?limit=2&cursor=${encodeURIComponent(cursor)}`
      : "/admin/comments?limit=2";
    const body = await (await worker.fetch(adminGet(path, { cookie }), env, ctx)).json();
    seen.push(...body.data.map((c) => c.id));
    if (!body.has_more) break;
    cursor = body.next_cursor;
  }

  assert.deepEqual(seen, [5, 4, 3, 2, 1]);
});

test("23. an invalid cursor is 400 INVALID_CURSOR", async () => {
  const db = seed();
  const bad = [
    "not-base64!!",
    b64url("not json"),
    b64url(JSON.stringify({ created_at: 5, id: 1 })),
    b64url(JSON.stringify({ created_at: "2026-09-20 10:00:00" })),
    b64url(JSON.stringify({ id: 3 })),
    b64url(JSON.stringify({ created_at: "x", id: 1.5 })),
    b64url(JSON.stringify([1, 2])),
    "",
  ];

  for (const cursor of bad) {
    const response = await worker.fetch(
      adminGet(`/admin/comments?cursor=${encodeURIComponent(cursor)}`, {
        cookie: await validCookie(),
      }),
      createAdminEnv({ DB: db }),
      ctx
    );

    assert.equal(response.status, 400, `cursor=${cursor}`);
    assert.deepEqual(await response.json(), {
      error: { code: "INVALID_CURSOR", message: "Invalid cursor" },
    });
  }
  assert.equal(db._state.statements.length, 0, "rejected before any query");
});

/* ================================================================== *
 * 25-27  row mapping
 * ================================================================== */

test("25. a comment with no matched product maps matched_product to null", async () => {
  const response = await worker.fetch(
    adminGet("/admin/comments?status=RECEIVED", { cookie: await validCookie() }),
    createAdminEnv({ DB: seed() }),
    ctx
  );

  const body = await response.json();
  assert.equal(body.data[0].matched_product, null);
  assert.equal(body.data[0].ai_response, null);
});

test("25b. a matched product maps to {id, name}", async () => {
  const response = await worker.fetch(
    adminGet("/admin/comments?status=REPLIED", { cookie: await validCookie() }),
    createAdminEnv({ DB: seed() }),
    ctx
  );

  const body = await response.json();
  assert.deepEqual(body.data[0].matched_product, {
    id: 7,
    name: "เครื่องตัดหญ้าไร้สาย DR.WOOT",
  });
});

test("26. a comment with no reply row maps reply to null", async () => {
  const response = await worker.fetch(
    adminGet("/admin/comments?status=RECEIVED", { cookie: await validCookie() }),
    createAdminEnv({ DB: seed() }),
    ctx
  );

  const body = await response.json();
  assert.equal(body.data[0].reply, null);
});

test("27. only the latest reply is returned, and the comment is not duplicated", async () => {
  const db = createAdminFakeD1({
    comments: [comment(1, { status: "REPLIED" })],
    replies: [
      reply(1, 1, { mode: "DRY_RUN", status: "SKIPPED", created_at: "2026-09-20 11:01:00" }),
      reply(2, 1, { mode: "DRY_RUN", status: "GENERATED", created_at: "2026-09-20 11:02:00" }),
      reply(3, 1, {
        mode: "LIVE",
        status: "SENT",
        facebook_reply_id: "fb-reply-9",
        created_at: "2026-09-20 11:03:00",
      }),
    ],
  });

  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: db }),
    ctx
  );

  const body = await response.json();
  assert.equal(body.data.length, 1, "three replies must not fan out into three rows");
  assert.deepEqual(body.data[0].reply, {
    mode: "LIVE",
    status: "SENT",
    facebook_reply_id: "fb-reply-9",
  });
});

/* ================================================================== *
 * Page scoping
 * ================================================================== */

test("page scoping: comments belonging to another Page are never returned", async () => {
  const db = createAdminFakeD1({
    comments: [
      comment(1),
      comment(2, { page_id: "999999999999999" }),
      comment(3, { page_id: "999999999999999" }),
    ],
  });

  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: db }),
    ctx
  );

  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, 1);
});

/* ================================================================== *
 * 28-31  errors and leakage
 * ================================================================== */

test("28. a D1 failure is 500 INTERNAL_ERROR", async () => {
  const db = createAdminFakeD1({ comments: [comment(1)], failSelect: true });

  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: db }),
    ctx
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: "INTERNAL_ERROR", message: "Internal error" },
  });
});

test("28b. a missing D1 binding is 500 INTERNAL_ERROR", async () => {
  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: undefined }),
    ctx
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: "INTERNAL_ERROR", message: "Internal error" },
  });
});

test("29. no secret ever appears in a response", async () => {
  const env = createAdminEnv({ DB: seed(), PAGE_ACCESS_TOKEN: "unit-test-page-access-token" });
  const cookie = await validCookie();

  const bodies = [];
  bodies.push(
    await (await worker.fetch(adminGet("/admin/comments", { cookie }), env, ctx)).text()
  );
  bodies.push(
    await (
      await worker.fetch(adminPost("/admin/login", { password: TEST_ADMIN_PASSWORD }), env, ctx)
    ).text()
  );
  bodies.push(
    await (await worker.fetch(adminPost("/admin/login", { password: "wrong" }), env, ctx)).text()
  );

  const combined = bodies.join("\n");
  for (const secret of [
    TEST_ADMIN_PASSWORD,
    TEST_SESSION_SECRET,
    "unit-test-meta-app-secret",
    "unit-test-verify-token",
    "unit-test-hermes-secret",
    "unit-test-page-access-token",
  ]) {
    assert.ok(!combined.includes(secret), `secret leaked: ${secret}`);
  }
});

test("30. the response never exposes author_id or internal reply fields", async () => {
  const db = createAdminFakeD1({
    comments: [comment(1, { author_id: "author-secret-id", status: "ERROR" })],
    replies: [reply(1, 1, { status: "FAILED", error_message: "HERMES_TIMEOUT" })],
  });

  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: db }),
    ctx
  );

  const raw = await response.text();
  assert.ok(!raw.includes("author-secret-id"), "author_id leaked");
  assert.ok(!raw.includes("author_id"), "author_id key present");
  assert.ok(!raw.includes("HERMES_TIMEOUT"), "internal error_message leaked");
  assert.ok(!raw.includes("error_message"), "error_message key present");
  assert.ok(!raw.includes("page_id"), "page_id key present");

  const row = JSON.parse(raw).data[0];
  assert.deepEqual(Object.keys(row).sort(), [
    "ai_response",
    "author_name",
    "comment_text",
    "created_at",
    "facebook_comment_id",
    "id",
    "matched_product",
    "reply",
    "status",
    "updated_at",
  ]);
});

test("31. an internal error response carries no exception text", async () => {
  const db = createAdminFakeD1({ comments: [comment(1)], failSelect: true });

  const raw = await (
    await worker.fetch(
      adminGet("/admin/comments", { cookie: await validCookie() }),
      createAdminEnv({ DB: db }),
      ctx
    )
  ).text();

  assert.ok(!raw.includes("d1 down"), "raw exception message leaked");
  assert.ok(!/SELECT|FROM comments|stack|Error:/i.test(raw), "SQL or stack leaked");
  assert.deepEqual(JSON.parse(raw), {
    error: { code: "INTERNAL_ERROR", message: "Internal error" },
  });
});

test("31b. admin responses carry no CORS headers", async () => {
  const response = await worker.fetch(
    adminGet("/admin/comments", { cookie: await validCookie() }),
    createAdminEnv({ DB: seed() }),
    ctx
  );

  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

/* ================================================================== *
 * Method handling on the new routes
 * ================================================================== */

test("wrong methods on admin routes are 405 with an Allow header", async () => {
  const env = createAdminEnv({ DB: seed() });

  const getLogin = await worker.fetch(adminGet("/admin/login"), env, ctx);
  assert.equal(getLogin.status, 405);
  assert.equal(getLogin.headers.get("Allow"), "POST");

  const postComments = await worker.fetch(
    adminPost("/admin/comments", {}),
    env,
    ctx
  );
  assert.equal(postComments.status, 405);
  assert.equal(postComments.headers.get("Allow"), "GET");
});
