/**
 * Phase 8.9 -- layer 2.5 possible-own-echo guard.
 *
 * Suppresses an event with NO author (`from.id` absent/empty) when its
 * thread (replyTargetId) received a LIVE send attempt whose Facebook reply
 * id is unknown -- GRAPH_SEND_IN_PROGRESS, GRAPH_OUTCOME_UNKNOWN:* or
 * SENT_ID_UNPARSEABLE -- within the echo-guard window (default 600 s,
 * inclusive). Read-only D1 lookup; fail closed on a read error.
 *
 * Numbered comments (#1..#29) map to the Phase 8.9 required test matrix.
 * No network: Hermes and Graph are fetch stubs. No real token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { resolveConfig, parseWindowSeconds, DEFAULT_ECHO_GUARD_WINDOW_SECONDS } from "../src/config.js";
import { findUnattributedLiveAttemptInThread, hasUnattributedLiveAttemptInThread } from "../src/db.js";
import { isPossibleOwnEchoFailClosed } from "../src/pipeline.js";
import { recoverComment } from "../src/recovery.js";
import {
  createFakeD1,
  createEnv,
  createCtx,
  commentPayload,
  signedRequest,
  installFetchMock,
  hermesChat,
  captureConsole,
  TEST_PAGE_ID,
} from "./helpers.js";

const isGraph = (url) => /graph\.facebook\.com/i.test(url);
const OK = { action: "REPLY", reply_text: "ขอบคุณที่สนใจครับ", include_affiliate_cta: false };
const LIVE_ENV = { REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "unit-test-page-token", GRAPH_TIMEOUT_MS: "80" };
const POST = "853313081388711_900"; // commentPayload's default post_id
const T = "853313081388711_7100"; // a top-level customer comment (the thread)
const NOW = "2026-09-28 12:00:00"; // fixed clock for boundary tests
const cfg = (extra = {}) => resolveConfig(createEnv(extra));

const STATES = {
  GRAPH_SEND_IN_PROGRESS: { status: "GENERATED", error_message: "GRAPH_SEND_IN_PROGRESS" },
  GRAPH_OUTCOME_UNKNOWN: { status: "GENERATED", error_message: "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT" },
  SENT_ID_UNPARSEABLE: { status: "SENT", error_message: "SENT_ID_UNPARSEABLE" },
};

let seq = 0;
/**
 * Seed one stored comment and one reply row directly.
 * `createdAt` is an SQL expression for replies.created_at (default: D1 now).
 */
function seed(db, {
  pageId = TEST_PAGE_ID, commentId = null, postId = POST, parentId = POST, authorId = "7777777777",
  commentStatus = "PROCESSED", mode = "LIVE", status = "GENERATED", error_message = "GRAPH_SEND_IN_PROGRESS",
  facebook_reply_id = null, createdAt = "datetime('now')",
} = {}) {
  seq += 1;
  const fid = commentId ?? `853313081388711_73${String(seq).padStart(4, "0")}`;
  db._sqlite
    .prepare(`INSERT INTO comments (facebook_comment_id, facebook_post_id, facebook_parent_id, page_id, author_id, comment_text, status)
              VALUES (?, ?, ?, ?, ?, 'seed', ?)`)
    .run(fid, postId, parentId, pageId, authorId, commentStatus);
  const cid = Number(db._query("SELECT id FROM comments WHERE facebook_comment_id = ?", fid)[0].id);
  db._sqlite
    .prepare(`INSERT INTO replies (comment_id, response_text, mode, status, error_message, facebook_reply_id, created_at)
              VALUES (?, 'ours', ?, ?, ?, ?, ${createdAt})`)
    .run(cid, mode, status, error_message, facebook_reply_id);
  return { cid, fid };
}

/** Deliver one signed webhook event and settle the background work. */
async function deliver(db, value, { env = {}, graph = () => assert.fail("no Graph call expected"), hermes = () => hermesChat(OK) } = {}) {
  const ctx = createCtx();
  const mock = installFetchMock(async (url, init) => (isGraph(url) ? graph(url, init) : hermes(url, init)));
  try {
    const res = await worker.fetch(await signedRequest(commentPayload({ value })), createEnv({ DB: db, ...env }), ctx);
    await ctx.settle();
    return { mock, res, body: await res.json() };
  } finally {
    mock.restore();
  }
}

const countComments = (db) => db._query("SELECT COUNT(*) n FROM comments")[0].n;
const countReplies = (db) => db._query("SELECT COUNT(*) n FROM replies")[0].n;
/** An author-less echo of a Page reply posted under thread T. */
const echoOf = (thread, id = "853313081388711_7999") => ({ comment_id: id, parent_id: thread, from: undefined, message: OK.reply_text });

/** Assert the event was suppressed before storage, Hermes and Graph. */
function assertSuppressed(db, run, before) {
  assert.equal(run.mock.calls.length, 0, "no Hermes and no Graph call");
  assert.equal(countComments(db), before.comments, "no comment row created");
  assert.equal(countReplies(db), before.replies, "no reply row created");
}
const snapshot = (db) => ({ comments: countComments(db), replies: countReplies(db) });

/* ============ #1-#3, #18-#20: each covered state, end to end ============ */

for (const [name, st] of Object.entries(STATES)) {
  test(`#1-#3/#18-#20: missing from + ${name} (reply id NULL) in the same thread -> suppressed (LIVE, no Hermes, no Graph)`, async () => {
    const db = createFakeD1();
    seed(db, { commentId: T, ...st });
    const before = snapshot(db);
    const run = await deliver(db, echoOf(T), { env: LIVE_ENV });
    assertSuppressed(db, run, before);
  });
}

test("#18-#20: helper reports which covered state matched", async () => {
  for (const [name, st] of Object.entries(STATES)) {
    const db = createFakeD1();
    seed(db, { commentId: T, ...st });
    assert.equal(await findUnattributedLiveAttemptInThread(db, { pageId: TEST_PAGE_ID, threadId: T, windowSeconds: 600 }), name);
  }
});

/* ============================ #4-#9 positive controls ============================ */

test("#4: a customer event WITH from.id in the same thread is not suppressed (guard never queried)", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.GRAPH_OUTCOME_UNKNOWN });
  const run = await deliver(db, { comment_id: "853313081388711_7401", parent_id: T, from: { id: "5555555555", name: "Customer" } });
  assert.equal(run.mock.calls.length, 1, "processed: one Hermes call (DRY_RUN, no Graph)");
  assert.equal(run.mock.graphCalls().length, 0);
  assert.equal(countComments(db), 2, "customer comment stored");
  assert.ok(!db._statements.some((s) => /r\.facebook_reply_id IS NULL/.test(s)), "layer 2.5 query not run for an authored event");
});

test("#5: missing from + NO matching LIVE state -> processed normally", async () => {
  const db = createFakeD1();
  const run = await deliver(db, echoOf(T));
  assert.equal(run.mock.calls.length, 1);
  assert.equal(countComments(db), 1);
});

test("#6: missing from + expired state (601 s old) -> processed", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.GRAPH_SEND_IN_PROGRESS, createdAt: "datetime('now', '-601 seconds')" });
  const run = await deliver(db, echoOf(T));
  assert.equal(run.mock.calls.length, 1);
  assert.equal(countComments(db), 2);
});

test("#7: missing from + DRY_RUN row in the thread -> processed", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, mode: "DRY_RUN", status: "GENERATED", error_message: null });
  const run = await deliver(db, echoOf(T));
  assert.equal(run.mock.calls.length, 1);
  assert.equal(countComments(db), 2);
});

test("#8: missing from + LIVE FAILED row in the thread -> processed", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, status: "FAILED", error_message: "GRAPH_REJECTED_400" });
  const run = await deliver(db, echoOf(T));
  assert.equal(run.mock.calls.length, 1);
  assert.equal(countComments(db), 2);
});

test("#9: a row WITH a usable facebook_reply_id is never matched by layer 2.5 (layer 2 owns it)", async () => {
  for (const st of Object.values(STATES)) {
    const db = createFakeD1();
    seed(db, { commentId: T, ...st, facebook_reply_id: "853313081388711_7777" });
    assert.equal(await hasUnattributedLiveAttemptInThread(db, { pageId: TEST_PAGE_ID, threadId: T, windowSeconds: 600 }), false, st.error_message);
  }
  // End to end: an unrelated author-less event in that thread is processed.
  const db = createFakeD1();
  seed(db, { commentId: T, status: "SENT", error_message: null, facebook_reply_id: "853313081388711_7777" });
  const run = await deliver(db, echoOf(T, "853313081388711_7998"));
  assert.equal(run.mock.calls.length, 1);
});

/* ============================== #10 page isolation ============================== */

test("#10: the same thread id on a DIFFERENT Page never suppresses this Page's event", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, pageId: "999999999999999", ...STATES.GRAPH_OUTCOME_UNKNOWN });
  assert.equal(await hasUnattributedLiveAttemptInThread(db, { pageId: TEST_PAGE_ID, threadId: T, windowSeconds: 600 }), false);
  const run = await deliver(db, echoOf(T));
  assert.equal(run.mock.calls.length, 1, "processed");
});

/* ============================ #11-#13 thread semantics ============================ */

test("#11: top-level original T (parent = post) matches an echo whose parent is T", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, parentId: POST, ...STATES.SENT_ID_UNPARSEABLE });
  const before = snapshot(db);
  assertSuppressed(db, await deliver(db, echoOf(T), { env: LIVE_ENV }), before);
});

test("#11b: top-level original with parent_id NULL also counts as thread = its own id", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, parentId: null, ...STATES.GRAPH_SEND_IN_PROGRESS });
  assert.equal(await hasUnattributedLiveAttemptInThread(db, { pageId: TEST_PAGE_ID, threadId: T, windowSeconds: 600 }), true);
});

test("#12: an author-less NESTED incoming event (parent T) matches thread T", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.GRAPH_OUTCOME_UNKNOWN });
  const before = snapshot(db);
  const run = await deliver(db, { comment_id: "853313081388711_7501", parent_id: T, from: undefined, message: "สนใจครับ" });
  assertSuppressed(db, run, before);
});

test("#13: nested original N (parent T) -- reply posted under T -- is matched by thread T, not by N's own id", async () => {
  const db = createFakeD1();
  const N = "853313081388711_7601";
  seed(db, { commentId: N, parentId: T, ...STATES.SENT_ID_UNPARSEABLE });
  assert.notEqual(N, T);
  assert.equal(await hasUnattributedLiveAttemptInThread(db, { pageId: TEST_PAGE_ID, threadId: T, windowSeconds: 600 }), true, "thread T matches");
  assert.equal(await hasUnattributedLiveAttemptInThread(db, { pageId: TEST_PAGE_ID, threadId: N, windowSeconds: 600 }), false, "comment-level id N does not");
  const before = snapshot(db);
  assertSuppressed(db, await deliver(db, echoOf(T), { env: LIVE_ENV }), before);
});

/* ============================== #14-#17 boundaries ============================== */

async function matchAtAge(ageSeconds) {
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.GRAPH_OUTCOME_UNKNOWN, createdAt: `datetime('${NOW}', '${ageSeconds >= 0 ? "-" : "+"}${Math.abs(ageSeconds)} seconds')` });
  return hasUnattributedLiveAttemptInThread(db, { pageId: TEST_PAGE_ID, threadId: T, windowSeconds: 600, now: NOW });
}

test("#14: age 599 s -> match", async () => assert.equal(await matchAtAge(599), true));
test("#15: age 600 s -> match (inclusive lower bound)", async () => assert.equal(await matchAtAge(600), true));
test("#16: age 601 s -> no match", async () => assert.equal(await matchAtAge(601), false));
test("#17: a future row (created_at > now) -> no match", async () => assert.equal(await matchAtAge(-1), false));
test("#14-#17: age 0 s (created exactly now) -> match (inclusive upper bound)", async () => assert.equal(await matchAtAge(0), true));

test("window comes from config: ECHO_GUARD_WINDOW_SECONDS overrides; invalid values fall back to 600", async () => {
  assert.equal(DEFAULT_ECHO_GUARD_WINDOW_SECONDS, 600);
  assert.equal(cfg().echoGuardWindowSeconds, 600);
  assert.equal(cfg({ ECHO_GUARD_WINDOW_SECONDS: "120" }).echoGuardWindowSeconds, 120);
  for (const bad of ["", "0", "-5", "abc", "1.5", undefined]) assert.equal(parseWindowSeconds(bad), 600, String(bad));

  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.GRAPH_OUTCOME_UNKNOWN, createdAt: "datetime('now', '-300 seconds')" });
  const short = await isPossibleOwnEchoFailClosed(db, { comment_id: "x_1", parent_id: T, post_id: POST, author_id: null }, cfg({ ECHO_GUARD_WINDOW_SECONDS: "120" }));
  assert.equal(short.suppress, false, "300 s old is outside a 120 s window");
  const dflt = await isPossibleOwnEchoFailClosed(db, { comment_id: "x_1", parent_id: T, post_id: POST, author_id: null }, cfg());
  assert.equal(dflt.suppress, true, "but inside the default 600 s window");
});

/* ============================ #21-#23 fail closed ============================ */

test("#21-#23: layer 2.5 read error -> fail closed: no comment row, no Hermes, no Graph", async () => {
  const db = createFakeD1({ failOn: /r\.facebook_reply_id IS NULL/ });
  const run = await deliver(db, echoOf(T), { env: LIVE_ENV });
  assert.equal(run.mock.calls.length, 0, "no Hermes, no Graph");
  assert.equal(countComments(db), 0);
  assert.equal(countReplies(db), 0);
});

test("#21: the fail-closed wrapper reports POSSIBLE_OWN_ECHO_GUARD_ERROR (never 'no match')", async () => {
  const db = createFakeD1({ failOn: /r\.facebook_reply_id IS NULL/ });
  const out = await isPossibleOwnEchoFailClosed(db, { comment_id: "x_2", parent_id: T, post_id: POST, author_id: null }, cfg());
  assert.deepEqual(out, { suppress: true, reason: "POSSIBLE_OWN_ECHO_GUARD_ERROR" });
});

test("#21: a guard read error never affects an event WITH an author (query not run)", async () => {
  const db = createFakeD1({ failOn: /r\.facebook_reply_id IS NULL/ });
  const run = await deliver(db, { comment_id: "853313081388711_7402", from: { id: "5555555555", name: "Customer" } });
  assert.equal(run.mock.calls.length, 1, "processed normally");
  assert.equal(countComments(db), 1);
});

/* ============================ #24-#27 integration ============================ */

test("#24-#27: the guard runs BEFORE insertCommentIfNew; a suppressed event stores nothing and never reaches Hermes", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.GRAPH_SEND_IN_PROGRESS });
  const before = snapshot(db);
  const stmtStart = db._statements.length;
  const run = await deliver(db, echoOf(T), { env: LIVE_ENV });
  const executed = db._statements.slice(stmtStart);
  assert.ok(executed.some((s) => /r\.facebook_reply_id IS NULL/.test(s)), "layer 2.5 query ran");
  assert.ok(!executed.some((s) => /INSERT INTO comments/i.test(s)), "insertCommentIfNew never prepared");
  assert.ok(!executed.some((s) => /INSERT INTO replies/i.test(s)), "no reply insert");
  assertSuppressed(db, run, before);
});

test("observability: suppression logs event_ignored POSSIBLE_OWN_ECHO with ids and state only", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.SENT_ID_UNPARSEABLE });
  const logs = captureConsole();
  try {
    await deliver(db, { ...echoOf(T), message: "ข้อความลับของลูกค้า" });
  } finally {
    logs.restore();
  }
  const line = logs.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o?.reason === "POSSIBLE_OWN_ECHO");
  assert.ok(line, "POSSIBLE_OWN_ECHO logged");
  assert.equal(line.event, "event_ignored");
  assert.equal(line.thread_id, T);
  assert.equal(line.guard_state, "SENT_ID_UNPARSEABLE");
  assert.ok(!logs.text().includes("ข้อความลับของลูกค้า"), "no comment text in logs");
});

/* =================== §17 the exact previously-identified failure =================== */

for (const [label, graph] of [
  ["GRAPH_OUTCOME_UNKNOWN (503)", () => new Response("oops", { status: 503 })],
  ["SENT_ID_UNPARSEABLE (2xx, no id)", () => new Response("{}", { status: 200 })],
]) {
  test(`§17: real LIVE send -> ${label} -> author-less Page echo -> POSSIBLE_OWN_ECHO, no second send`, async () => {
    const db = createFakeD1();
    const first = await deliver(db, { comment_id: T }, { env: LIVE_ENV, graph });
    assert.equal(first.mock.graphCalls().length, 1, "exactly one real send attempt");
    const row = db._query("SELECT facebook_reply_id FROM replies WHERE mode='LIVE'")[0];
    assert.equal(row.facebook_reply_id, null);
    const before = snapshot(db);
    const run = await deliver(db, echoOf(T), { env: LIVE_ENV });
    assertSuppressed(db, run, before);
  });
}

test("§17: echo arriving while the send is still GRAPH_SEND_IN_PROGRESS (before finalize) is suppressed", async () => {
  const db = createFakeD1();
  let echoRun;
  // The Graph stub delivers the echo webhook DURING the send, before the
  // outcome is recorded -- the marker row is the only state that exists.
  const first = await deliver(db, { comment_id: T }, {
    env: LIVE_ENV,
    graph: async () => {
      const state = db._query("SELECT status, error_message FROM replies WHERE mode='LIVE'")[0];
      assert.deepEqual({ ...state }, { status: "GENERATED", error_message: "GRAPH_SEND_IN_PROGRESS" });
      const ctx = createCtx();
      const res = await worker.fetch(await signedRequest(commentPayload({ value: echoOf(T) })), createEnv({ DB: db, ...LIVE_ENV }), ctx);
      await ctx.settle();
      echoRun = await res.json();
      return new Response(JSON.stringify({ id: "853313081388711_7888" }), { status: 200 });
    },
  });
  assert.equal(first.mock.graphCalls().length, 1, "only the original send reached Graph");
  assert.equal(first.mock.calls.length, 2, "one Hermes (original) + one Graph (original); echo made no calls");
  assert.equal(echoRun.status, "accepted");
  assert.equal(countComments(db), 1, "echo not stored");
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode='LIVE'")[0].n, 1);
});

/* ============================== #28-#29 recovery ============================== */

test("#28-#29: recovery refuses a stored author-less comment in a thread with an unattributed attempt; no Hermes/Graph", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.GRAPH_OUTCOME_UNKNOWN });
  // A stored author-less comment in thread T, eligible for recovery on its
  // own terms (ERROR, fresh, no reply row).
  db._sqlite
    .prepare(`INSERT INTO comments (facebook_comment_id, facebook_post_id, facebook_parent_id, page_id, author_id, comment_text, status)
              VALUES ('853313081388711_7701', ?, ?, ?, NULL, 'x', 'ERROR')`)
    .run(POST, T, TEST_PAGE_ID);
  const id = Number(db._query("SELECT id FROM comments WHERE facebook_comment_id = '853313081388711_7701'")[0].id);
  const mock = installFetchMock(() => assert.fail("no network during refused recovery"));
  let r;
  try {
    r = await recoverComment(id, { db, env: createEnv({ DB: db, ...LIVE_ENV }), config: cfg(LIVE_ENV) });
  } finally {
    mock.restore();
  }
  assert.deepEqual(r, { status: "NOT_ELIGIBLE", reason: "POSSIBLE_OWN_ECHO" });
  assert.equal(mock.calls.length, 0);
  assert.equal(db._query("SELECT status FROM comments WHERE id = ?", id)[0].status, "ERROR", "not claimed");
});

test("#28: recovery guard read error also refuses (fail closed)", async () => {
  const db = createFakeD1({ failOn: /r\.facebook_reply_id IS NULL/ });
  db._sqlite
    .prepare(`INSERT INTO comments (facebook_comment_id, facebook_post_id, facebook_parent_id, page_id, author_id, comment_text, status)
              VALUES ('853313081388711_7702', ?, ?, ?, NULL, 'x', 'ERROR')`)
    .run(POST, T, TEST_PAGE_ID);
  const id = Number(db._query("SELECT id FROM comments WHERE facebook_comment_id = '853313081388711_7702'")[0].id);
  const mock = installFetchMock(() => assert.fail("no network"));
  let r;
  try {
    r = await recoverComment(id, { db, env: createEnv({ DB: db }), config: cfg() });
  } finally {
    mock.restore();
  }
  assert.deepEqual(r, { status: "NOT_ELIGIBLE", reason: "POSSIBLE_OWN_ECHO_GUARD_ERROR" });
  assert.equal(mock.calls.length, 0);
});

/* ============================== LIVE OFF ============================== */

test("LIVE OFF: with the guard present and matching, DRY_RUN never calls Graph", async () => {
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.GRAPH_OUTCOME_UNKNOWN });
  const suppressed = await deliver(db, echoOf(T));
  assert.equal(suppressed.mock.graphCalls().length, 0);
  const customer = await deliver(db, { comment_id: "853313081388711_7403", parent_id: T, from: { id: "5555555555", name: "C" } });
  assert.equal(customer.mock.graphCalls().length, 0);
});

test("health: live_sent_id_unparseable is counted", async () => {
  const { healthStats } = await import("../src/recovery.js");
  const db = createFakeD1();
  seed(db, { commentId: T, ...STATES.SENT_ID_UNPARSEABLE });
  const h = await healthStats(db, TEST_PAGE_ID);
  assert.equal(h.live_sent_id_unparseable, 1);
});
