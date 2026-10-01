/**
 * Phase 8.36 -- operator reconciliation of an AMBIGUOUS LIVE send.
 * Read-only Graph GET + strict match + one compare-and-set. Every test
 * asserts that NO non-GET request (no Graph POST) was ever made.
 * Real in-memory SQLite with all migrations; Graph is a fetch stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { reconcileComment, selectReconcileMatches, normalizeReplyText, getRecoveryState } from "../src/recovery.js";
import { fetchCommentReplies, FacebookReadError } from "../src/facebook-reply.js";
import { reconcileAmbiguousSend, hasLiveSendAttempt } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  createFakeD1, createEnv, createCtx, commentPayload, signedRequest, installFetchMock, jsonResponse, captureConsole, TEST_PAGE_ID,
} from "./helpers.js";
import { makeSessionToken, cookieHeader, TEST_SESSION_SECRET, TEST_ADMIN_PASSWORD } from "./admin-helpers.js";

const TOKEN = "unit-test-page-token-phase836";
const POST = "853313081388711_1694107882724308";
const REPLY_TEXT = "กดดูพิกัดสินค้าได้ที่ลิงก์นี้เลยครับ 👇\nhttps://s.shopee.co.th/4qG2R8DzWR";
const env = (extra = {}) => createEnv({ PAGE_ACCESS_TOKEN: TOKEN, ...extra });
const cfg = (extra = {}) => resolveConfig(env(extra));
const isGraph = (u) => /graph\.facebook\.com/.test(u);

let seq = 0;
/**
 * A top-level comment whose LIVE send is ambiguous. Its reply target is the
 * comment itself (parent = post). The marker was written `ageSec` ago.
 */
function seedAmbiguous(db, { error = "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT", mode = "LIVE", status = "GENERATED", fbReplyId = null, page = TEST_PAGE_ID, ageSec = 60, text = REPLY_TEXT, commentStatus = "ERROR" } = {}) {
  seq += 1;
  const fid = `1694107882724308_836${String(seq).padStart(4, "0")}`;
  db._sqlite
    .prepare(
      `INSERT INTO comments (facebook_comment_id, facebook_post_id, facebook_parent_id, page_id, author_id, author_name, comment_text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'author-836', 'A', 'สนใจครับ ขอพิกัดหน่อยครับ', ?, datetime('now', ?), datetime('now', ?))`
    )
    .run(fid, POST, POST, page, commentStatus, `-${ageSec + 6} seconds`, `-${ageSec - 10} seconds`);
  const id = Number(db._query("SELECT id FROM comments WHERE facebook_comment_id = ?", fid)[0].id);
  db._sqlite
    .prepare(
      `INSERT INTO replies (comment_id, response_text, mode, status, error_message, facebook_reply_id, affiliate_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'https://s.shopee.co.th/4qG2R8DzWR', datetime('now', ?))`
    )
    .run(id, text, mode, status, error, fbReplyId, `-${ageSec} seconds`);
  const replyId = Number(db._query("SELECT id FROM replies WHERE comment_id = ?", id)[0].id);
  return { id, fid, replyId };
}

/** Graph timestamp `offsetSec` relative to now, in Graph's "+0000" form. */
function graphTime(offsetSec) {
  return new Date(Date.now() + offsetSec * 1000).toISOString().replace(/\.\d{3}Z$/, "+0000");
}
function pageReply(id, { parent, created = graphTime(-59), from = TEST_PAGE_ID, message = REPLY_TEXT } = {}) {
  return { id, from: { id: from, name: "Page" }, created_time: created, message, parent: parent ? { id: parent } : undefined };
}

/** Install a Graph stub; returns the mock. Any non-GET request fails loudly. */
function graphStub(handler) {
  return installFetchMock(async (url, init) => {
    if ((init?.method || "GET") !== "GET") throw new Error(`unexpected ${init?.method} to ${url}`);
    if (!isGraph(url)) throw new Error(`unexpected host ${url}`);
    return handler(url, init);
  });
}
function assertNoPost(mock) {
  const nonGet = mock.calls.filter((c) => c.method !== "GET");
  assert.equal(nonGet.length, 0, "POST count must be 0");
}
const row = (db, replyId) => db._query("SELECT * FROM replies WHERE id = ?", replyId)[0];
const commentRow = (db, id) => db._query("SELECT * FROM comments WHERE id = ?", id)[0];
function assertUnchanged(db, s, before) {
  const r = row(db, s.replyId);
  assert.equal(r.status, "GENERATED");
  assert.equal(r.facebook_reply_id, null);
  assert.equal(r.error_message, before.error_message);
  assert.equal(commentRow(db, s.id).status, "ERROR");
}

async function reconcile(db, id, handler, extra = {}) {
  const mock = graphStub(handler);
  try {
    const result = await reconcileComment(id, { db, env: env(), config: cfg(), reconcileTimeoutMs: 80, ...extra });
    return { result, mock };
  } finally {
    mock.restore();
  }
}

/* ================================ match ================================ */

test("8.36 #1 reply found -> SENT + facebook_reply_id, RECONCILED provenance, comment REPLIED, GET only", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  const { result, mock } = await reconcile(db, s.id, () => jsonResponse({ data: [pageReply("1694107882724308_1550653533745108", { parent: s.fid })] }));
  assert.equal(result.reason, "RECONCILED");
  assert.equal(result.facebookReplyId, "1694107882724308_1550653533745108");
  assert.equal(mock.calls.length, 1);
  assertNoPost(mock);
  // The listing was requested for the reply target, with the read fields, token in header only.
  const call = mock.calls[0];
  assert.match(call.url, new RegExp(`/v21\\.0/${s.fid}/comments\\?`));
  assert.match(call.url, /fields=id%2Cfrom%2Ccreated_time%2Cmessage%2Cparent/);
  assert.ok(!call.url.includes(TOKEN), "token never in the URL");
  assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.body, undefined);
  const r = row(db, s.replyId);
  assert.equal(r.status, "SENT");
  assert.equal(r.facebook_reply_id, "1694107882724308_1550653533745108");
  assert.equal(r.error_message, "RECONCILED:GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT");
  assert.equal(commentRow(db, s.id).status, "REPLIED");
  assert.equal(result.commentStatusUpdated, true);
  // Recovery now sees it as sent; the send gate still blocks forever.
  assert.equal((await getRecoveryState(db, s.id, TEST_PAGE_ID)).reason, "ALREADY_SENT");
  assert.equal(await hasLiveSendAttempt(db, s.id), true);
});

test("8.36 #1b GRAPH_SEND_IN_PROGRESS rows (outcome never recorded) reconcile the same way", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db, { error: "GRAPH_SEND_IN_PROGRESS" });
  const { result, mock } = await reconcile(db, s.id, () => jsonResponse({ data: [pageReply("P_1", { parent: s.fid })] }));
  assert.equal(result.reason, "RECONCILED");
  assert.equal(row(db, s.replyId).error_message, "RECONCILED:GRAPH_SEND_IN_PROGRESS");
  assertNoPost(mock);
});

test("8.36 #1c whitespace/newline differences still match; any real text difference does not", async () => {
  assert.equal(normalizeReplyText("  a \n\n b  "), "a b");
  const base = { pageId: TEST_PAGE_ID, targetId: "T", markerCreatedAt: new Date(Date.now() - 60000).toISOString().slice(0, 19).replace("T", " "), responseText: "ab cd\nhttps://x.y/z" };
  const t = graphTime(-59);
  const m = (message) => selectReconcileMatches([{ id: "1", fromId: TEST_PAGE_ID, parentId: "T", createdTime: t, message }], base);
  assert.equal(m("ab  cd https://x.y/z").length, 1);
  assert.equal(m(" ab cd\r\n https://x.y/z ").length, 1);
  assert.equal(m("ab cd https://x.y/zz").length, 0, "URL not stripped");
  assert.equal(m("ab cd. https://x.y/z").length, 0, "punctuation not ignored");
  assert.equal(m("AB cd https://x.y/z").length, 0, "case-sensitive");
});

test("8.36 #2 reply not found -> unchanged", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  const before = row(db, s.replyId);
  const { result, mock } = await reconcile(db, s.id, () => jsonResponse({ data: [] }));
  assert.equal(result.reason, "NOT_FOUND");
  assertUnchanged(db, s, before);
  assertNoPost(mock);
});

test("8.36 #3 multiple matching Page replies -> MULTIPLE_MATCHES, unchanged", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  const before = row(db, s.replyId);
  const { result, mock } = await reconcile(db, s.id, () =>
    jsonResponse({ data: [pageReply("P_a", { parent: s.fid }), pageReply("P_b", { parent: s.fid, created: graphTime(-30) })] })
  );
  assert.equal(result.reason, "MULTIPLE_MATCHES");
  assert.equal(result.candidates, 2);
  assertUnchanged(db, s, before);
  assertNoPost(mock);
});

test("8.36 #4 same text but wrong parent -> unchanged", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  const before = row(db, s.replyId);
  const { result, mock } = await reconcile(db, s.id, () => jsonResponse({ data: [pageReply("P_x", { parent: "1694107882724308_999" })] }));
  assert.equal(result.reason, "NOT_FOUND");
  assertUnchanged(db, s, before);
  assertNoPost(mock);
});

test("8.36 #5 same text but outside the time window (both sides) -> unchanged", async () => {
  for (const created of [graphTime(-60 - 121), graphTime(-60 + 15 * 60 + 5)]) {
    const db = createFakeD1();
    const s = seedAmbiguous(db);
    const before = row(db, s.replyId);
    const { result, mock } = await reconcile(db, s.id, () => jsonResponse({ data: [pageReply("P_t", { parent: s.fid, created })] }));
    assert.equal(result.reason, "NOT_FOUND", created);
    assertUnchanged(db, s, before);
    assertNoPost(mock);
  }
  // Inside both edges still matches.
  for (const created of [graphTime(-60 - 110), graphTime(-60 + 14 * 60)]) {
    const db = createFakeD1();
    const s = seedAmbiguous(db);
    const { result } = await reconcile(db, s.id, () => jsonResponse({ data: [pageReply("P_in", { parent: s.fid, created })] }));
    assert.equal(result.reason, "RECONCILED", created);
  }
});

test("8.36 #6 non-Page author (and missing author) -> unchanged", async () => {
  for (const from of ["7777777777", null]) {
    const db = createFakeD1();
    const s = seedAmbiguous(db);
    const before = row(db, s.replyId);
    const item = pageReply("P_u", { parent: s.fid, from });
    if (from === null) delete item.from;
    const { result, mock } = await reconcile(db, s.id, () => jsonResponse({ data: [item] }));
    assert.equal(result.reason, "NOT_FOUND");
    assertUnchanged(db, s, before);
    assertNoPost(mock);
  }
});

test("8.36 #7 a Facebook reply id already linked to another row -> unchanged (never linked twice)", async () => {
  const db = createFakeD1();
  const other = seedAmbiguous(db, { status: "SENT", error: null, fbReplyId: "P_dup" });
  const s = seedAmbiguous(db);
  const before = row(db, s.replyId);
  const { result, mock } = await reconcile(db, s.id, () => jsonResponse({ data: [pageReply("P_dup", { parent: s.fid })] }));
  assert.equal(result.reason, "NOT_FOUND");
  assertUnchanged(db, s, before);
  assertNoPost(mock);
  // The CAS itself also refuses, even if called directly.
  assert.equal(await reconcileAmbiguousSend(db, s.replyId, "P_dup"), false);
  assert.equal(row(db, other.replyId).facebook_reply_id, "P_dup");
  assertUnchanged(db, s, before);
});

test("8.36 #8 concurrent reconcile -> exactly one winner, the other CAS_LOST", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  // Both reads resolve together, so both callers pass matching before
  // either writes: the compare-and-set alone must pick the single winner.
  const mock = graphStub(async () => jsonResponse({ data: [pageReply("P_c", { parent: s.fid })] }));
  try {
    const run = () => reconcileComment(s.id, { db, env: env(), config: cfg(), reconcileTimeoutMs: 500 });
    const results = await Promise.all([run(), run()]);
    const reasons = results.map((r) => r.reason).sort();
    assert.deepEqual(reasons, ["CAS_LOST", "RECONCILED"]);
    assertNoPost(mock);
  } finally {
    mock.restore();
  }
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE facebook_reply_id = 'P_c'")[0].n, 1);
  // The same row cannot be reconciled twice, even directly.
  assert.equal(await reconcileAmbiguousSend(db, s.replyId, "P_other"), false);
  assert.equal(row(db, s.replyId).facebook_reply_id, "P_c");
  // Two different ambiguous rows cannot both take the same Facebook reply.
  const a = seedAmbiguous(db);
  const b = seedAmbiguous(db);
  assert.equal(await reconcileAmbiguousSend(db, a.replyId, "P_same"), true);
  assert.equal(await reconcileAmbiguousSend(db, b.replyId, "P_same"), false);
});

/* ============================= read failures ============================= */

const hangUntilAbort = (url, init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));

const failureCases = [
  ["#9 header timeout", hangUntilAbort, "GRAPH_READ_TIMEOUT"],
  [
    "#10 body timeout (headers arrive, body stalls)",
    () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"data":[')); } }), { status: 200 }),
    "GRAPH_READ_TIMEOUT",
  ],
  ["#11 Graph 4xx", () => jsonResponse({ error: { message: "x" } }, 403), "GRAPH_READ_4XX"],
  ["#12 Graph 5xx", () => new Response("oops", { status: 503 }), "GRAPH_READ_5XX"],
  ["#13 network error", () => { throw new TypeError("fetch failed"); }, "GRAPH_READ_NETWORK_ERROR"],
  ["#14a malformed (not JSON)", () => new Response("not json", { status: 200 }), "GRAPH_READ_MALFORMED"],
  ["#14b malformed (no data array)", () => jsonResponse({ items: [] }), "GRAPH_READ_MALFORMED"],
  ["#14c malformed (item without id)", () => jsonResponse({ data: [{ message: "x" }] }), "GRAPH_READ_MALFORMED"],
  ["#14d malformed (next page without cursor)", () => jsonResponse({ data: [], paging: { next: "https://graph.facebook.com/next" } }), "GRAPH_READ_MALFORMED"],
];
for (const [name, handler, expected] of failureCases) {
  test(`8.36 ${name} -> ${expected}, unchanged, no retry, no POST`, async () => {
    const db = createFakeD1();
    const s = seedAmbiguous(db);
    const before = row(db, s.replyId);
    const t0 = Date.now();
    const { result, mock } = await reconcile(db, s.id, handler);
    assert.equal(result.reason, expected);
    assert.ok(Date.now() - t0 < 2000, "bounded");
    assert.equal(mock.calls.length, 1, "one read, no retry");
    assertUnchanged(db, s, before);
    assertNoPost(mock);
  });
}

test("8.36 #15 pagination: 2 pages are followed by cursor; a 3rd page -> INCOMPLETE, unchanged", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  const before = row(db, s.replyId);
  const page = (n, next) => jsonResponse({ data: [pageReply(`P_p${n}`, { parent: s.fid, message: "other" })], paging: next ? { cursors: { after: `c${n}` }, next: "https://graph.facebook.com/x" } : {} });
  let n = 0;
  const { result, mock } = await reconcile(db, s.id, (url) => {
    n += 1;
    if (n === 2) assert.match(url, /after=c1/);
    return page(n, true);
  });
  assert.equal(result.reason, "INCOMPLETE");
  assert.equal(mock.calls.length, 2, "never follows a 3rd page");
  assertUnchanged(db, s, before);
  assertNoPost(mock);

  // Two pages, match on page 2, no further page -> reconciled.
  const db2 = createFakeD1();
  const s2 = seedAmbiguous(db2);
  let m = 0;
  const r2 = await reconcile(db2, s2.id, () => {
    m += 1;
    return m === 1
      ? jsonResponse({ data: [], paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/x" } })
      : jsonResponse({ data: [pageReply("P_page2", { parent: s2.fid })] });
  });
  assert.equal(r2.result.reason, "RECONCILED");
  assertNoPost(r2.mock);
});

/* ============================== eligibility ============================== */

const notEligible = [
  ["#16 already SENT", { status: "SENT", error: null, fbReplyId: "P_old" }],
  ["#17 DRY_RUN", { mode: "DRY_RUN", status: "GENERATED", error: null }],
  ["#18 FAILED", { status: "FAILED", error: "GRAPH_REJECTED_400" }],
  ["#19 wrong page", { page: "999999999" }],
  ["#19b different error", { error: "SOMETHING_ELSE" }],
  ["#19c SKIPPED", { status: "SKIPPED", error: "AI_ACTION_SKIP" }],
];
for (const [name, opts] of notEligible) {
  test(`8.36 ${name} -> NOT_ELIGIBLE, no network, no change`, async () => {
    const db = createFakeD1();
    const s = seedAmbiguous(db, opts);
    const before = row(db, s.replyId);
    const { result, mock } = await reconcile(db, s.id, () => assert.fail("no Graph call"));
    assert.equal(result.reason, "NOT_ELIGIBLE");
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(row(db, s.replyId), before);
  });
}

test("8.36 missing PAGE_ACCESS_TOKEN or unknown comment -> NOT_ELIGIBLE, no network", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  const mock = graphStub(() => assert.fail("no Graph call"));
  try {
    const r = await reconcileComment(s.id, { db, env: createEnv(), config: resolveConfig(createEnv()) });
    assert.equal(r.reason, "NOT_ELIGIBLE");
    assert.equal(r.detail, "NO_PAGE_ACCESS_TOKEN");
    const r2 = await reconcileComment(999999, { db, env: env(), config: cfg() });
    assert.equal(r2.reason, "NOT_ELIGIBLE");
    assert.equal(r2.commentFound, false);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("8.36 fetchCommentReplies never issues anything but GET and refuses unsafe ids", async () => {
  const seen = [];
  const out = await fetchCommentReplies("1694107882724308_1", {
    accessToken: "t",
    fetchImpl: async (url, init) => {
      seen.push(init.method);
      return jsonResponse({ data: [] });
    },
  });
  assert.deepEqual(seen, ["GET"]);
  assert.equal(out.complete, true);
  await assert.rejects(fetchCommentReplies("../me/feed", { accessToken: "t", fetchImpl: () => assert.fail() }), (e) => e instanceof FacebookReadError && e.category === "GRAPH_READ_MALFORMED");
});

test("8.36 after reconcile the row is NOT_ELIGIBLE on repeat (idempotent) and still never re-sendable", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  await reconcile(db, s.id, () => jsonResponse({ data: [pageReply("P_r", { parent: s.fid })] }));
  const { result, mock } = await reconcile(db, s.id, () => assert.fail("no Graph call"));
  assert.equal(result.reason, "NOT_ELIGIBLE");
  assert.equal(mock.calls.length, 0);
  assert.equal(row(db, s.replyId).facebook_reply_id, "P_r");
});

test("8.36 echo from the reconciled reply is then recognised by layer 2 (OWN_REPLY_EVENT), nothing stored", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  await reconcile(db, s.id, () => jsonResponse({ data: [pageReply("1694107882724308_777", { parent: s.fid })] }));
  const before = db._query("SELECT COUNT(*) n FROM comments")[0].n;
  const ctx = createCtx();
  const mock = installFetchMock(() => assert.fail("no Hermes, no Graph"));
  try {
    const payload = commentPayload({ value: { comment_id: "1694107882724308_777", parent_id: s.fid, post_id: POST, from: undefined, message: REPLY_TEXT } });
    delete payload.entry[0].changes[0].value.from;
    await worker.fetch(await signedRequest(payload), createEnv({ DB: db }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
  }
  assert.equal(db._query("SELECT COUNT(*) n FROM comments")[0].n, before);
});

/* ============================ admin endpoint ============================ */

const W = "https://worker.example";
async function adminCall(db, method, path, { auth = true, origin = W, type = "application/json", envExtra = {} } = {}) {
  const headers = {};
  if (auth) {
    const now = Math.floor(Date.now() / 1000);
    headers.cookie = cookieHeader(await makeSessionToken(TEST_SESSION_SECRET, { iat: now, exp: now + 3600 }));
  }
  if (origin) headers.origin = origin;
  if (type) headers["content-type"] = type;
  const req = new Request(W + path, { method, headers, body: method === "GET" ? undefined : "{}" });
  const res = await worker.fetch(
    req,
    createEnv({ DB: db, ADMIN_PASSWORD: TEST_ADMIN_PASSWORD, ADMIN_SESSION_SECRET: TEST_SESSION_SECRET, PAGE_ACCESS_TOKEN: TOKEN, ...envExtra }),
    createCtx()
  );
  return { res, text: await res.text() };
}

test("8.36 API: POST /admin/api/comments/:id/reconcile -- auth, CSRF, method, ids; success then NOT_ELIGIBLE; no secrets", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  const path = `/admin/api/comments/${s.id}/reconcile`;
  const logs = captureConsole();
  const mock = graphStub(() => jsonResponse({ data: [pageReply("1694107882724308_1550653533745108", { parent: s.fid })] }));
  let ok;
  let again;
  try {
    assert.equal((await adminCall(db, "POST", path, { auth: false })).res.status, 401);
    assert.equal((await adminCall(db, "POST", path, { origin: "https://evil.example" })).res.status, 403);
    assert.equal((await adminCall(db, "POST", path, { type: "text/plain" })).res.status, 403);
    assert.equal((await adminCall(db, "GET", path)).res.status, 405);
    assert.equal((await adminCall(db, "POST", `/admin/api/comments/abc/reconcile`)).res.status, 400);
    assert.equal((await adminCall(db, "POST", `/admin/api/comments/999999/reconcile`)).res.status, 404);
    assert.equal((await adminCall(db, "POST", `${path}/x`)).res.status, 404);
    assert.equal(mock.calls.length, 0, "no Graph call on any rejected request");
    assert.equal(row(db, s.replyId).status, "GENERATED");

    ok = await adminCall(db, "POST", path);
    again = await adminCall(db, "POST", path);
  } finally {
    mock.restore();
    logs.restore();
  }
  assert.equal(ok.res.status, 200);
  const body = JSON.parse(ok.text).data;
  assert.equal(body.reason, "RECONCILED");
  assert.equal(body.facebook_reply_id, "1694107882724308_1550653533745108");
  assert.equal(again.res.status, 409);
  assert.equal(JSON.parse(again.text).data.reason, "NOT_ELIGIBLE");
  assertNoPost(mock);
  for (const t of [ok.text, again.text, logs.text()]) {
    assert.ok(!t.includes(TOKEN), "token never returned or logged");
    assert.ok(!t.includes(TEST_ADMIN_PASSWORD) && !t.includes(TEST_SESSION_SECRET));
    assert.ok(!t.includes("s.shopee.co.th"), "no reply/Graph text in response or logs");
  }
});

test("8.36 API: a Graph read failure answers 502 and changes nothing", async () => {
  const db = createFakeD1();
  const s = seedAmbiguous(db);
  const mock = graphStub(() => new Response("oops", { status: 500 }));
  let r;
  try {
    r = await adminCall(db, "POST", `/admin/api/comments/${s.id}/reconcile`);
  } finally {
    mock.restore();
  }
  assert.equal(r.res.status, 502);
  assert.equal(JSON.parse(r.text).data.reason, "GRAPH_READ_5XX");
  assert.equal(row(db, s.replyId).status, "GENERATED");
  assertNoPost(mock);
});

/* ============================ echo telemetry ============================ */

test("8.36 #20 SELF_AUTHORED telemetry carries ids + created_time only; event still ignored, nothing stored", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const logs = captureConsole();
  const mock = installFetchMock(() => assert.fail("no Hermes, no Graph"));
  let res;
  try {
    const payload = commentPayload({
      value: { comment_id: "1694107882724308_555", parent_id: "1694107882724308_444", post_id: POST, created_time: 1790834016, message: "SECRET-LOOKING-TEXT ข้อความ", from: { id: TEST_PAGE_ID, name: "Page" } },
    });
    res = await worker.fetch(await signedRequest(payload), createEnv({ DB: db }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
    logs.restore();
  }
  assert.deepEqual(await res.json(), { status: "ignored", reason: "self_authored" });
  assert.equal(db._query("SELECT COUNT(*) n FROM comments")[0].n, 0);
  const line = logs.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.reason === "SELF_AUTHORED");
  assert.ok(line);
  assert.equal(line.event, "event_ignored");
  assert.equal(line.count, 1);
  assert.equal(line.comment_id, "1694107882724308_555");
  assert.equal(line.parent_id, "1694107882724308_444");
  assert.equal(line.created_time, "2026-10-01T05:53:36.000Z");
  assert.deepEqual(line.self_events, [{ comment_id: "1694107882724308_555", parent_id: "1694107882724308_444", created_time: "2026-10-01T05:53:36.000Z" }]);
  assert.ok(!logs.text().includes("SECRET-LOOKING-TEXT"), "message text never logged");
});
