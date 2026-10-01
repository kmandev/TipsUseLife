/**
 * Phase 8.44 -- late-response capture for the ONE Graph POST.
 * After the ambiguity threshold (GRAPH_TIMEOUT_MS) the send is recorded
 * AMBIGUOUS exactly as before; the SAME request is then observed until a
 * bounded hard deadline. Only a late 2xx with a valid id may upgrade the
 * same row to SENT, via the shared compare-and-set. Never a second request.
 * No network: Graph and Hermes are stubs; timings are tens of ms and every
 * late response is released by the test itself (controlled promises).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { sendFacebookReply, FacebookSendError } from "../src/facebook-reply.js";
import { finalizeLateSend, reconcileAmbiguousSend, hasLiveSendAttempt, getReplyFinalState } from "../src/db.js";
import { reconcileComment, recoverComment } from "../src/recovery.js";
import { resolveConfig, parseLateObserveMs, DEFAULT_GRAPH_LATE_OBSERVE_MS, GRAPH_LATE_FINALIZE_MS } from "../src/config.js";
import { lateObserveUntilMs } from "../src/pipeline.js";
import {
  createFakeD1, createEnv, createCtx, commentPayload, signedRequest, installFetchMock, hermesChat, captureConsole,
  TEST_PAGE_ID, TEST_META_SECRET, TEST_VERIFY_TOKEN, TEST_HERMES_API_KEY,
} from "./helpers.js";

let unhandled = 0;
process.on("unhandledRejection", () => {
  unhandled += 1;
});

const TOKEN = "unit-test-page-token-phase844";
const OK = { action: "REPLY", reply_text: "ขอบคุณที่สนใจครับ", include_affiliate_cta: false };
const FB_ID = "853313081388711_844001";
const isGraph = (u) => /graph\.facebook\.com/.test(u);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const okResponse = (body = { id: FB_ID }, status = 200, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/* ------------------------------------------------------------------ *
 * Controlled fetch for sendFacebookReply unit tests.
 * ------------------------------------------------------------------ */
function controlledFetch() {
  const calls = [];
  let settle;
  const impl = (url, init) => {
    calls.push({ url, method: init.method, init });
    return new Promise((resolve, reject) => {
      settle = { resolve, reject };
      init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };
  return { impl, calls, resolve: (r) => settle.resolve(r), reject: (e) => settle.reject(e), signal: () => calls[0]?.init.signal };
}
const send = (fx, { timeoutMs = 30, observeUntilMs = 400 } = {}) =>
  sendFacebookReply({ commentId: "1_2", message: "hi" }, { mode: "LIVE", accessToken: TOKEN, timeoutMs, observeUntilMs, fetchImpl: fx.impl });

async function expectTimeout(promise) {
  const err = await promise.then(
    () => assert.fail("expected GRAPH_TIMEOUT"),
    (e) => e
  );
  assert.ok(err instanceof FacebookSendError);
  assert.equal(err.category, "GRAPH_TIMEOUT");
  assert.equal(err.ambiguous, true);
  return err;
}
const onePost = (fx) => {
  assert.equal(fx.calls.length, 1, "exactly one request");
  assert.equal(fx.calls[0].method, "POST");
};

test("8.44 U1 2xx before the threshold -> {id}; one POST; no late handle", async () => {
  const fx = controlledFetch();
  const p = send(fx);
  fx.resolve(okResponse());
  assert.deepEqual(await p, { id: FB_ID });
  onePost(fx);
  assert.equal(fx.signal().aborted, false);
});

test("8.44 U2/U3 2xx just after the threshold -> GRAPH_TIMEOUT now, late RESPONSE with the valid id + trace id; same request", async () => {
  const fx = controlledFetch();
  const err = await expectTimeout(send(fx));
  assert.equal(err.thresholdMs, 30);
  assert.equal(err.observeUntilMs, 400);
  fx.resolve(okResponse({ id: FB_ID }, 200, { "x-fb-trace-id": "AbC123xyz", "x-fb-request-id": "Req_9.9" }));
  const late = await err.late;
  assert.equal(late.kind, "RESPONSE");
  assert.equal(late.statusCode, 200);
  assert.equal(late.id, FB_ID);
  assert.equal(late.bodyError, null);
  assert.equal(late.traceId, "AbC123xyz");
  assert.equal(late.requestId, "Req_9.9");
  assert.ok(late.headersMs >= 25 && late.totalMs >= late.headersMs);
  onePost(fx);
});

test("8.44 U4 late 2xx with malformed JSON -> id null, BODY_PARSE_ERROR", async () => {
  const fx = controlledFetch();
  const err = await expectTimeout(send(fx));
  fx.resolve(okResponse("not json{"));
  const late = await err.late;
  assert.equal(late.id, null);
  assert.equal(late.bodyError, "BODY_PARSE_ERROR");
  onePost(fx);
});

test("8.44 U5 late 2xx without a usable id (missing / empty / non-numeric) -> id null, BODY_ID_MISSING", async () => {
  for (const body of [{}, { id: "" }, { id: "abc" }, { id: "1_2_3" }, { success: true }]) {
    const fx = controlledFetch();
    const err = await expectTimeout(send(fx));
    fx.resolve(okResponse(body));
    const late = await err.late;
    assert.equal(late.id, null, JSON.stringify(body));
    assert.equal(late.bodyError, "BODY_ID_MISSING");
    onePost(fx);
  }
});

test("8.44 U6/U7 late 4xx and 5xx -> RESPONSE with status, no id, body not parsed", async () => {
  for (const status of [400, 403, 500, 503]) {
    const fx = controlledFetch();
    const err = await expectTimeout(send(fx));
    fx.resolve(okResponse({ id: FB_ID }, status));
    const late = await err.late;
    assert.equal(late.kind, "RESPONSE");
    assert.equal(late.statusCode, status);
    assert.equal(late.id, null, "a non-2xx id is never used");
    onePost(fx);
  }
});

test("8.44 U8 network rejection before the threshold -> GRAPH_NETWORK_ERROR (unchanged), no late handle", async () => {
  const fx = controlledFetch();
  const p = send(fx);
  fx.reject(new TypeError("network down"));
  const err = await p.then(() => assert.fail(), (e) => e);
  assert.equal(err.category, "GRAPH_NETWORK_ERROR");
  assert.equal(err.ambiguous, true);
  assert.equal(err.late, null);
  onePost(fx);
});

test("8.44 U8b synchronous fetch throw is classified exactly like an async rejection", async () => {
  for (const observeUntilMs of [0, 400]) {
    let n = 0;
    const err = await sendFacebookReply({ commentId: "1_2", message: "x" }, {
      mode: "LIVE", accessToken: TOKEN, timeoutMs: 30, observeUntilMs,
      fetchImpl: () => { n += 1; throw new TypeError("boom"); },
    }).then(() => assert.fail(), (e) => e);
    assert.equal(err.category, "GRAPH_NETWORK_ERROR");
    assert.equal(n, 1);
  }
});

test("8.44 U9 still pending at the hard deadline -> PENDING_AT_DEADLINE; the one request is aborted", async () => {
  const fx = controlledFetch();
  const err = await expectTimeout(send(fx, { timeoutMs: 20, observeUntilMs: 80 }));
  const late = await err.late;
  assert.equal(late.kind, "PENDING_AT_DEADLINE");
  assert.ok(late.totalMs >= 70);
  assert.equal(fx.signal().aborted, true);
  onePost(fx);
});

test("8.44 U10 a response after the observation window changes nothing and raises nothing", async () => {
  const fx = controlledFetch();
  const err = await expectTimeout(send(fx, { timeoutMs: 20, observeUntilMs: 60 }));
  const late = await err.late;
  assert.equal(late.kind, "PENDING_AT_DEADLINE");
  fx.resolve(okResponse()); // settles an already-rejected promise: no-op
  await sleep(10);
  assert.equal((await err.late).kind, "PENDING_AT_DEADLINE");
  onePost(fx);
});

test("8.44 U11 late network error after the threshold -> NETWORK_ERROR", async () => {
  const fx = controlledFetch();
  const err = await expectTimeout(send(fx));
  fx.reject(new TypeError("reset"));
  assert.equal((await err.late).kind, "NETWORK_ERROR");
  onePost(fx);
});

test("8.44 U12 disabled (observeUntilMs <= timeoutMs) -> exact pre-8.44 behaviour: GRAPH_TIMEOUT, no late handle", async () => {
  for (const observeUntilMs of [0, 30, 10]) {
    const fx = controlledFetch();
    const err = await expectTimeout(send(fx, { timeoutMs: 30, observeUntilMs }));
    assert.equal(err.late, null);
    assert.equal(fx.signal().aborted, true, "aborted at the threshold as before");
    onePost(fx);
  }
});

test("8.44 U18 2xx headers before the threshold + malformed body -> {id:null} (existing semantics, never a timeout)", async () => {
  const fx = controlledFetch();
  const p = send(fx);
  fx.resolve(okResponse("<html>"));
  assert.deepEqual(await p, { id: null });
  onePost(fx);
});

test("8.44 U19 slow BODY after early headers is not a header timeout; slow late body hits BODY_TIMEOUT at the deadline", async () => {
  // early headers, body slower than the threshold -> still success
  const fx = controlledFetch();
  const p = send(fx, { timeoutMs: 20, observeUntilMs: 200 });
  fx.resolve({ status: 200, headers: new Headers(), text: () => sleep(60).then(() => JSON.stringify({ id: FB_ID })) });
  assert.deepEqual(await p, { id: FB_ID });
  onePost(fx);
  // late headers, body never finishes -> bounded by the hard deadline
  const fx2 = controlledFetch();
  const err = await expectTimeout(send(fx2, { timeoutMs: 20, observeUntilMs: 90 }));
  fx2.resolve({ status: 200, headers: new Headers(), text: () => new Promise(() => {}) });
  const late = await err.late;
  assert.equal(late.kind, "RESPONSE");
  assert.equal(late.id, null);
  assert.equal(late.bodyError, "BODY_TIMEOUT");
  onePost(fx2);
});

test("8.44 U20 headers and threshold at the same instant -> exactly one consistent outcome, one POST", async () => {
  for (let i = 0; i < 20; i += 1) {
    const calls = [];
    const impl = (url, init) => {
      calls.push(init.method);
      return new Promise((resolve, reject) => {
        setTimeout(() => resolve(okResponse()), 25); // registered before the threshold timer
        init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    };
    let outcome;
    try {
      outcome = await sendFacebookReply({ commentId: "1_2", message: "x" }, { mode: "LIVE", accessToken: TOKEN, timeoutMs: 25, observeUntilMs: 300, fetchImpl: impl });
      assert.deepEqual(outcome, { id: FB_ID });
    } catch (e) {
      assert.equal(e.category, "GRAPH_TIMEOUT");
      const late = await e.late;
      assert.equal(late.id, FB_ID, "if classified late, the late id is captured");
    }
    assert.deepEqual(calls, ["POST"]);
  }
});

test("8.44 U-guard DRY_RUN / missing token never touch the network (guards unchanged)", async () => {
  let n = 0;
  for (const opts of [{ mode: "DRY_RUN", accessToken: TOKEN }, { mode: "LIVE", accessToken: "" }]) {
    await assert.rejects(sendFacebookReply({ commentId: "1_2", message: "x" }, { ...opts, observeUntilMs: 400, fetchImpl: () => { n += 1; } }));
  }
  assert.equal(n, 0);
});

/* ------------------------------------------------------------------ *
 * Config + budget
 * ------------------------------------------------------------------ */
test("8.44 C1 GRAPH_LATE_OBSERVE_MS parsing: unset/invalid -> default, '0' disables, bounded", () => {
  assert.equal(DEFAULT_GRAPH_LATE_OBSERVE_MS, 15000);
  for (const raw of [undefined, null, "", "abc", "-1", "1.5", "20001", "99999"]) assert.equal(parseLateObserveMs(raw), 15000, String(raw));
  assert.equal(parseLateObserveMs("0"), 0);
  assert.equal(parseLateObserveMs("500"), 500);
  assert.equal(parseLateObserveMs("20000"), 20000);
  assert.equal(resolveConfig(createEnv()).graphLateObserveMs, 15000, "production default = enabled");
});

test("8.44 C2 observation deadline is capped by GRAPH_LATE_OBSERVE_MS and by the remaining budget minus the late-finalize reserve", () => {
  const cfg = (ms) => ({ graphLateObserveMs: ms });
  assert.equal(GRAPH_LATE_FINALIZE_MS, 2000);
  // production shape: Hermes ~6 s -> ~20 s left
  assert.equal(lateObserveUntilMs(cfg(15000), 10000, 20000), 18000);
  assert.equal(lateObserveUntilMs(cfg(5000), 10000, 20000), 15000);
  assert.equal(lateObserveUntilMs(cfg(15000), 10000, 11500), 10000, "no room -> off");
  assert.equal(lateObserveUntilMs(cfg(0), 10000, 20000), 10000, "disabled");
});

/* ------------------------------------------------------------------ *
 * D1 compare-and-set (real SQLite)
 * ------------------------------------------------------------------ */
let seq = 0;
function seedLive(db, { status = "GENERATED", error = "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT", fb = null } = {}) {
  seq += 1;
  const fid = `1688743123260784_844${String(seq).padStart(4, "0")}`;
  db._sqlite
    .prepare(`INSERT INTO comments (facebook_comment_id, facebook_post_id, facebook_parent_id, page_id, author_id, author_name, comment_text, status)
              VALUES (?, '853313081388711_1688743123260784', '853313081388711_1688743123260784', ?, 'a844', 'A', 'x', 'ERROR')`)
    .run(fid, TEST_PAGE_ID);
  const id = Number(db._query("SELECT id FROM comments WHERE facebook_comment_id = ?", fid)[0].id);
  db._sqlite
    .prepare(`INSERT INTO replies (comment_id, response_text, mode, status, error_message, facebook_reply_id) VALUES (?, 'r', 'LIVE', ?, ?, ?)`)
    .run(id, status, error, fb);
  return { id, replyId: Number(db._query("SELECT id FROM replies WHERE comment_id = ?", id)[0].id) };
}
const replyRow = (db, id) => db._query("SELECT * FROM replies WHERE id = ?", id)[0];

test("8.44 D1 late CAS success: same row -> SENT, LATE_RESPONSE provenance, id linked; no new row", async () => {
  const db = createFakeD1();
  const s = seedLive(db);
  const before = db._query("SELECT COUNT(*) AS n FROM replies")[0].n;
  assert.equal(await finalizeLateSend(db, s.replyId, FB_ID), true);
  const r = replyRow(db, s.replyId);
  assert.equal(r.status, "SENT");
  assert.equal(r.facebook_reply_id, FB_ID);
  assert.equal(r.error_message, "LATE_RESPONSE:GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT");
  assert.equal(db._query("SELECT COUNT(*) AS n FROM replies")[0].n, before);
  assert.deepEqual(await getReplyFinalState(db, s.replyId), { status: "SENT", provenance: "LATE_RESPONSE", linked: true });
});

test("8.44 D2 late CAS refused for every finalized / non-ambiguous state", async () => {
  const db = createFakeD1();
  const cases = [
    { status: "SENT", error: null, fb: "1_1" },
    { status: "SENT", error: "RECONCILED:GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT", fb: "1_2" },
    { status: "FAILED", error: "GRAPH_REJECTED_400", fb: null },
    { status: "SKIPPED", error: "AI_ACTION_SKIP", fb: null },
    { status: "GENERATED", error: null, fb: null },
  ];
  for (const c of cases) {
    const s = seedLive(db, c);
    const before = replyRow(db, s.replyId);
    assert.equal(await finalizeLateSend(db, s.replyId, `853313081388711_9${s.replyId}`), false, JSON.stringify(c));
    assert.deepEqual(replyRow(db, s.replyId), before);
  }
});

test("8.44 D3 a Facebook id already linked to another row is never linked twice (late or reconcile)", async () => {
  const db = createFakeD1();
  seedLive(db, { status: "SENT", error: null, fb: FB_ID });
  const s = seedLive(db);
  assert.equal(await finalizeLateSend(db, s.replyId, FB_ID), false);
  assert.equal(await reconcileAmbiguousSend(db, s.replyId, FB_ID), false);
  assert.equal(replyRow(db, s.replyId).status, "GENERATED");
});

test("8.44 D4 late vs reconcile CAS race, both orders and concurrently -> exactly one winner", async () => {
  const db = createFakeD1();
  const a = seedLive(db);
  assert.equal(await reconcileAmbiguousSend(db, a.replyId, FB_ID), true);
  assert.equal(await finalizeLateSend(db, a.replyId, FB_ID), false);
  assert.match(replyRow(db, a.replyId).error_message, /^RECONCILED:/);

  const b = seedLive(db);
  assert.equal(await finalizeLateSend(db, b.replyId, "853313081388711_844b"), true);
  assert.equal(await reconcileAmbiguousSend(db, b.replyId, "853313081388711_844b"), false);
  assert.match(replyRow(db, b.replyId).error_message, /^LATE_RESPONSE:/);

  const c = seedLive(db);
  const results = await Promise.all([finalizeLateSend(db, c.replyId, "853313081388711_844c"), reconcileAmbiguousSend(db, c.replyId, "853313081388711_844c")]);
  assert.equal(results.filter(Boolean).length, 1);
});

/* ------------------------------------------------------------------ *
 * Pipeline integration (worker.fetch, fake D1, fetch stub)
 * ------------------------------------------------------------------ */
const LIVE = { REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: TOKEN, GRAPH_TIMEOUT_MS: "60", GRAPH_LATE_OBSERVE_MS: "600" };

/** Start the webhook; returns handles to observe and to finish. */
async function startLive(db, graph, { envExtra = {}, payload = commentPayload(), agent = OK } = {}) {
  const ctx = createCtx();
  const logs = captureConsole();
  const mock = installFetchMock(async (url, init) => (isGraph(url) ? graph(url, init) : hermesChat(agent)));
  const res = await worker.fetch(await signedRequest(payload), createEnv({ DB: db, ...LIVE, ...envExtra }), ctx);
  assert.equal(res.status, 200);
  return {
    mock,
    async finish() {
      try {
        await ctx.settle();
      } finally {
        mock.restore();
        logs.restore();
      }
      const events = logs.lines.flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      return { events, text: logs.text() };
    },
  };
}
const posts = (mock) => mock.calls.filter((c) => isGraph(c.url) && c.method === "POST");
const liveRows = (db) => db._query("SELECT * FROM replies WHERE mode = 'LIVE' ORDER BY id");
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(3);
  }
  assert.fail("condition not reached");
}
/** POST stub: records D1 state at dispatch, then answers only when the test releases it. */
function heldPost(db) {
  const seen = { markerAtDispatch: null };
  let release;
  const handler = (url, init) => {
    if (init.method !== "POST") throw new Error("unexpected method");
    seen.markerAtDispatch = liveRows(db).map((r) => r.error_message);
    return new Promise((resolve, reject) => {
      release = resolve;
      init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };
  return { handler, seen, release: (r) => release(r) };
}
const ambiguousRecorded = (db) => liveRows(db).some((r) => r.error_message === "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT");
const ev = (events, name) => events.filter((e) => e.event === name);

test("8.44 P1 late 2xx: marker before POST, AMBIGUOUS at threshold, then same row SENT + comment REPLIED; one POST, one row", async () => {
  const db = createFakeD1();
  const g = heldPost(db);
  const run = await startLive(db, g.handler);
  await waitFor(() => ambiguousRecorded(db));
  assert.deepEqual(g.seen.markerAtDispatch, ["GRAPH_SEND_IN_PROGRESS"], "marker written before the request");
  assert.equal(db._state.comments[0].status, "ERROR", "ambiguous outcome recorded at the threshold");
  g.release(okResponse({ id: FB_ID }, 200, { "x-fb-trace-id": "Tr4ce" }));
  const { events } = await run.finish();

  assert.equal(posts(run.mock).length, 1);
  const rows = liveRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "SENT");
  assert.equal(rows[0].facebook_reply_id, FB_ID);
  assert.equal(rows[0].error_message, "LATE_RESPONSE:GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT");
  assert.equal(db._state.comments[0].status, "REPLIED");
  assert.equal(ev(events, "reply_send_ambiguous").length, 1);
  const late = ev(events, "graph_late_response");
  assert.equal(late.length, 1);
  assert.equal(late[0].cas_applied, true);
  assert.equal(late[0].outcome, "SENT");
  assert.equal(late[0].status_code, 200);
  assert.equal(late[0].has_valid_id, true);
  assert.equal(late[0].fb_trace_id, "Tr4ce");
  assert.equal(late[0].comment_status, "REPLIED");
  assert.equal(late[0].threshold_ms, 60);
  assert.ok(late[0].headers_ms >= 55);
  assert.equal(ev(events, "reply_sent").length, 0, "no claim of an early success");
});

test("8.44 P2 late non-success / unusable id / pending -> row stays AMBIGUOUS + protected; comment ERROR; never retried", async () => {
  const outcomes = [
    { name: "late 400", release: () => okResponse({ error: {} }, 400), code: "GRAPH_LATE_HTTP_400", event: "graph_late_response" },
    { name: "late 503", release: () => okResponse("oops", 503), code: "GRAPH_LATE_HTTP_503", event: "graph_late_response" },
    { name: "late 2xx bad json", release: () => okResponse("{{"), code: "BODY_PARSE_ERROR", event: "graph_late_response" },
    { name: "late 2xx no id", release: () => okResponse({}), code: "BODY_ID_MISSING", event: "graph_late_response" },
    { name: "pending", release: null, code: "GRAPH_PENDING_AT_OBSERVATION_DEADLINE", event: "graph_response_never_arrived" },
    { name: "late network error", release: "reject", code: "GRAPH_LATE_NETWORK_ERROR", event: "graph_late_network_error" },
  ];
  for (const o of outcomes) {
    const db = createFakeD1();
    let rejectIt;
    const g = heldPost(db);
    const handler = (url, init) => {
      const p = g.handler(url, init);
      return new Promise((resolve, reject) => {
        rejectIt = reject;
        p.then(resolve, reject);
      });
    };
    const run = await startLive(db, handler, { envExtra: { GRAPH_LATE_OBSERVE_MS: "150" } });
    await waitFor(() => ambiguousRecorded(db));
    if (typeof o.release === "function") g.release(o.release());
    else if (o.release === "reject") rejectIt(new TypeError("reset"));
    const { events } = await run.finish();

    assert.equal(posts(run.mock).length, 1, o.name);
    const rows = liveRows(db);
    assert.equal(rows.length, 1, o.name);
    assert.equal(rows[0].status, "GENERATED", o.name);
    assert.equal(rows[0].facebook_reply_id, null, o.name);
    assert.equal(rows[0].error_message, "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT", o.name);
    assert.equal(db._state.comments[0].status, "ERROR", o.name);
    const e = ev(events, o.event);
    assert.equal(e.length, 1, o.name);
    assert.equal(e[0].error_category, o.code, o.name);
    assert.equal(e[0].outcome, "KEPT_AMBIGUOUS", o.name);
    assert.equal(await hasLiveSendAttempt(db, db._state.comments[0].id), true);
    const rec = await recoverComment(db._state.comments[0].id, { db, env: createEnv({ DB: db, ...LIVE }), config: resolveConfig(createEnv({ ...LIVE })) });
    assert.equal(rec.status, "NOT_ELIGIBLE", `${o.name}: recovery can never resend`);
  }
});

test("8.44 P3 operator reconcile wins while the POST is still pending -> late CAS refused, winner logged, no overwrite", async () => {
  const db = createFakeD1();
  const g = heldPost(db);
  const handler = (url, init) => {
    if (init.method === "GET") {
      const r = liveRows(db)[0];
      return okResponse({ data: [{ id: FB_ID, from: { id: TEST_PAGE_ID, name: "Page" }, created_time: new Date().toISOString().replace(/\.\d{3}Z$/, "+0000"), message: r.response_text }] });
    }
    return g.handler(url, init);
  };
  const run = await startLive(db, handler);
  await waitFor(() => ambiguousRecorded(db));
  const commentRowId = db._state.comments[0].id;
  const rc = await reconcileComment(commentRowId, { db, env: createEnv({ DB: db, ...LIVE }), config: resolveConfig(createEnv({ ...LIVE })) });
  assert.equal(rc.reason, "RECONCILED");
  g.release(okResponse({ id: FB_ID }));
  const { events } = await run.finish();

  assert.equal(posts(run.mock).length, 1);
  const rows = liveRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "SENT");
  assert.match(rows[0].error_message, /^RECONCILED:GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT$/);
  const late = ev(events, "graph_late_response");
  assert.equal(late.length, 1);
  assert.equal(late[0].error_category, "LATE_CAS_REFUSED");
  assert.equal(late[0].cas_applied, false);
  assert.equal(late[0].current_status, "SENT");
  assert.equal(late[0].current_provenance, "RECONCILED");
  assert.equal(db._state.comments[0].status, "REPLIED");
});

test("8.44 P4 late capture wins first -> a later operator reconcile is NOT_ELIGIBLE and makes no Graph call", async () => {
  const db = createFakeD1();
  const g = heldPost(db);
  const run = await startLive(db, g.handler);
  await waitFor(() => ambiguousRecorded(db));
  g.release(okResponse({ id: FB_ID }));
  await run.finish();
  const mock = installFetchMock(async () => assert.fail("no network"));
  try {
    const rc = await reconcileComment(db._state.comments[0].id, { db, env: createEnv({ DB: db, ...LIVE }), config: resolveConfig(createEnv({ ...LIVE })) });
    assert.equal(rc.reason, "NOT_ELIGIBLE");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
  assert.match(liveRows(db)[0].error_message, /^LATE_RESPONSE:/);
});

test("8.44 P5 historical protected rows are untouched by a late success elsewhere", async () => {
  const db = createFakeD1();
  const h1 = seedLive(db); // like row 196
  const h2 = seedLive(db, { status: "SENT", error: "RECONCILED:GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT", fb: "1692949516173478_2518270098681726" });
  const snap = () => [replyRow(db, h1.replyId), replyRow(db, h2.replyId)];
  const before = snap();
  const g = heldPost(db);
  const run = await startLive(db, g.handler);
  await waitFor(() => ambiguousRecorded(db) && liveRows(db).length === 3);
  g.release(okResponse({ id: FB_ID }));
  await run.finish();
  assert.deepEqual(snap(), before);
  assert.equal(posts(run.mock).length, 1);
});

test("8.44 P6 duplicate webhook delivery of the same comment during/after late capture -> still exactly one POST", async () => {
  const db = createFakeD1();
  const g = heldPost(db);
  const run = await startLive(db, g.handler);
  await waitFor(() => ambiguousRecorded(db));
  const ctx2 = createCtx();
  await worker.fetch(await signedRequest(commentPayload()), createEnv({ DB: db, ...LIVE }), ctx2);
  await ctx2.settle();
  g.release(okResponse({ id: FB_ID }));
  await run.finish();
  assert.equal(posts(run.mock).length, 1);
  assert.equal(liveRows(db).length, 1);
});

test("8.44 P7 GRAPH_LATE_OBSERVE_MS='0' -> pre-8.44 pipeline behaviour (abort at the threshold, stays ambiguous)", async () => {
  const db = createFakeD1();
  const g = heldPost(db);
  const run = await startLive(db, g.handler, { envExtra: { GRAPH_LATE_OBSERVE_MS: "0" } });
  const { events } = await run.finish();
  assert.equal(posts(run.mock).length, 1);
  assert.equal(liveRows(db)[0].error_message, "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT");
  assert.equal(ev(events, "graph_late_response").length + ev(events, "graph_response_never_arrived").length, 0);
  assert.equal(ev(events, "reply_send_ambiguous")[0].late_observe_until_ms, null);
});

test("8.44 P8 DRY_RUN -> no POST at all, late capture irrelevant", async () => {
  const db = createFakeD1();
  const run = await startLive(db, () => assert.fail("Graph must not be called"), { envExtra: { REPLY_MODE: "DRY_RUN" } });
  await run.finish();
  assert.equal(posts(run.mock).length, 0);
  assert.equal(db._query("SELECT mode FROM replies")[0].mode, "DRY_RUN");
});

test("8.44 P9 early 2xx is unchanged: reply_sent, SENT without provenance prefix, no late events", async () => {
  const db = createFakeD1();
  const run = await startLive(db, () => okResponse({ id: FB_ID }));
  const { events } = await run.finish();
  assert.equal(posts(run.mock).length, 1);
  const r = liveRows(db)[0];
  assert.equal(r.status, "SENT");
  assert.equal(r.error_message, null);
  assert.equal(ev(events, "reply_sent").length, 1);
  assert.equal(ev(events, "graph_late_response").length, 0);
});

test("8.44 P10 no secret, authorization value or reply body in any log line", async () => {
  const texts = [];
  for (const rel of [() => okResponse({ id: FB_ID }), () => okResponse("x", 500), null]) {
    const db = createFakeD1();
    const g = heldPost(db);
    const run = await startLive(db, g.handler, { envExtra: { GRAPH_LATE_OBSERVE_MS: "150" } });
    await waitFor(() => ambiguousRecorded(db));
    if (rel) g.release(rel());
    texts.push((await run.finish()).text);
  }
  const all = texts.join("\n");
  for (const secret of [TOKEN, TEST_META_SECRET, TEST_VERIFY_TOKEN, TEST_HERMES_API_KEY]) assert.ok(!all.includes(secret));
  assert.ok(!/bearer\s/i.test(all));
  assert.ok(!all.includes(OK.reply_text), "reply body never logged");
});

test("8.44 U15 no unhandled promise rejection anywhere in this file", async () => {
  await sleep(50);
  assert.equal(unhandled, 0);
});
