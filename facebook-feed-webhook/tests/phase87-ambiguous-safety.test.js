/**
 * Phase 8.7 -- ambiguous-send self-reply safety: recon + regression only.
 *
 * These tests LOCK CURRENT BEHAVIOUR. They change no production code.
 * Phase 8.9 update: the GRAPH_OUTCOME_UNKNOWN + missing-from gap they
 * documented is now closed by the layer 2.5 possible-own-echo guard; those
 * tests were flipped on purpose ("FIXED in 8.9").
 *
 * Coverage note: timeout / network-failure / 5xx already have direct
 * regression in tests/phase81-live-safety.test.js
 * ("B1: 5xx, timeout and network failure are AMBIGUOUS -> stay GENERATED
 * (never FAILED), no retry"), which proves the Graph-call-level outcome
 * (GENERATED, GRAPH_OUTCOME_UNKNOWN:<category>, no facebook_reply_id, no
 * retry). This file does NOT duplicate that; it covers what phase81 does
 * not: what happens on the NEXT webhook event after an ambiguous send,
 * i.e. whether that ambiguous outcome leaves an echo/self-reply exposed --
 * the same question tests/phase86-safe-scope.test.js already answered for
 * SENT_ID_UNPARSEABLE.
 *
 * No network: Hermes and Graph are fetch stubs (helpers.installFetchMock).
 * No real token: LIVE runs use a unit-test placeholder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  createFakeD1,
  createEnv,
  createCtx,
  commentPayload,
  signedRequest,
  installFetchMock,
  hermesChat,
  jsonResponse,
  TEST_PAGE_ID,
} from "./helpers.js";

const isGraph = (url) => /graph\.facebook\.com/i.test(url);
const OK = { action: "REPLY", reply_text: "ขอบคุณที่สนใจครับ", include_affiliate_cta: false };
const LIVE_ENV = { REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "unit-test-page-token", GRAPH_TIMEOUT_MS: "80" };

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

const hangUntilAbort = (url, init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); }));

/** Every case tests/phase81-live-safety.test.js already proves maps to the
 *  same D1 state: mode=LIVE, status=GENERATED, error=GRAPH_OUTCOME_UNKNOWN:*,
 *  facebook_reply_id=null. Re-verified here, once, as the precondition the
 *  rest of this file depends on. */
const AMBIGUOUS_CASES = [
  ["timeout", hangUntilAbort],
  ["network error", () => { throw new TypeError("fetch failed"); }],
  ["5xx", () => new Response("oops", { status: 503 })],
];

for (const [label, graphStub] of AMBIGUOUS_CASES) {
  test(`ambiguous send precondition (${label}): mode=LIVE status=GENERATED, no facebook_reply_id`, async () => {
    const db = createFakeD1();
    const { mock } = await deliver(db, { comment_id: `853313081388711_87${label.replace(/\W/g, "")}` }, { env: LIVE_ENV, graph: graphStub });
    assert.equal(mock.graphCalls().length, 1);
    const row = db._query("SELECT mode, status, facebook_reply_id FROM replies WHERE mode = 'LIVE'")[0];
    assert.equal(row.mode, "LIVE");
    assert.equal(row.status, "GENERATED");
    assert.equal(row.facebook_reply_id, null);
    assert.match(row && String(db._query("SELECT error_message e FROM replies WHERE mode='LIVE'")[0].e), /^GRAPH_OUTCOME_UNKNOWN:/);
  });
}

/* =============== Test D: ambiguous send + missing-from echo =============== */

for (const [label, graphStub] of AMBIGUOUS_CASES) {
  test(`FIXED in 8.9: after an ambiguous send (${label}), an echo WITHOUT from is suppressed by layer 2.5 -- no second LIVE reply`, async () => {
    const db = createFakeD1();
    const original = await deliver(db, { comment_id: "853313081388711_8801" }, { env: LIVE_ENV, graph: graphStub });
    assert.equal(original.mock.graphCalls().length, 1);
    assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode='LIVE' AND status='GENERATED'")[0].n, 1);

    // Redelivery of the SAME event is still blocked (hasLiveSendAttempt
    // treats an ambiguous GENERATED row as an attempt already made).
    const redelivered = await deliver(db, { comment_id: "853313081388711_8801" }, { env: LIVE_ENV, graph: () => assert.fail("no resend of the original event") });
    assert.equal(redelivered.mock.calls.length, 0, "duplicate delivery short-circuits before Hermes/Graph");

    // A DIFFERENT comment id (Facebook's echo of the ambiguous reply, if it
    // was in fact posted) with no `from`. Layer 1 needs from.id and layer 2
    // needs a stored facebook_reply_id -- neither is available. Layer 2.5
    // matches the thread's GRAPH_OUTCOME_UNKNOWN row instead.
    const echo = await deliver(
      db,
      { comment_id: "853313081388711_8802", parent_id: "853313081388711_8801", from: undefined, message: OK.reply_text },
      { env: LIVE_ENV, graph: () => assert.fail("no second send") }
    );
    assert.equal(echo.mock.calls.length, 0, "no Hermes, no Graph");
    assert.equal(db._query("SELECT COUNT(*) n FROM comments")[0].n, 1, "echo not stored");
    assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode='LIVE'")[0].n, 1, "still exactly one LIVE row");
  });
}

test("contrast: after an ambiguous send, an echo WITH from.id == Page IS ignored (layer 1 works when from is present)", async () => {
  const db = createFakeD1();
  await deliver(db, { comment_id: "853313081388711_8901" }, { env: LIVE_ENV, graph: hangUntilAbort });
  const echo = await deliver(
    db,
    { comment_id: "853313081388711_8902", parent_id: "853313081388711_8901", from: { id: TEST_PAGE_ID, name: "Page" }, message: OK.reply_text },
    { env: LIVE_ENV, graph: () => assert.fail("no loop") }
  );
  assert.equal(echo.body.reason, "self_authored");
  assert.equal(echo.mock.calls.length, 0);
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode='LIVE' AND status='SENT'")[0].n, 0);
});

/* ==================== Top-level vs. nested comparison ==================== */

test("FIXED in 8.9: top-level and nested originals -- an author-less echo in the same thread is suppressed at either depth", async () => {
  // Facebook threads are one level deep (facebook.js replyTargetId): a
  // customer's nested reply N under top-level T is answered UNDER T, so the
  // Page's echo arrives with parent_id = T in both cases.
  //
  // Case 1 -- top-level original T gets an ambiguous LIVE send.
  const db1 = createFakeD1();
  await deliver(db1, { comment_id: "853313081388711_8951" }, { env: LIVE_ENV, graph: hangUntilAbort });
  const topLevelEcho = await deliver(
    db1,
    { comment_id: "853313081388711_8952", parent_id: "853313081388711_8951", from: undefined, message: OK.reply_text },
    { env: LIVE_ENV, graph: () => assert.fail("no second send") }
  );
  assert.equal(topLevelEcho.mock.calls.length, 0, "top-level: suppressed, no Hermes/Graph");

  // Case 2 -- nested original N (parent T) gets the ambiguous send, which
  // was posted under T. The echo's parent is T, not N.
  const db2 = createFakeD1();
  await deliver(db2, { comment_id: "853313081388711_8961", parent_id: "853313081388711_8960" }, { env: LIVE_ENV, graph: hangUntilAbort });
  const nestedEcho = await deliver(
    db2,
    { comment_id: "853313081388711_8962", parent_id: "853313081388711_8960", from: undefined, message: OK.reply_text },
    { env: LIVE_ENV, graph: () => assert.fail("no second send") }
  );
  assert.equal(nestedEcho.mock.calls.length, 0, "nested: suppressed, no Hermes/Graph");
  assert.equal(db2._query("SELECT COUNT(*) n FROM replies WHERE mode='LIVE'")[0].n, 1);
});

test("top-level vs nested: a NESTED echo WITH from.id == Page is ignored just like a top-level one", async () => {
  const db = createFakeD1();
  await deliver(db, { comment_id: "853313081388711_8971" }, { env: LIVE_ENV, graph: hangUntilAbort });
  const nestedEcho = await deliver(
    db,
    { comment_id: "853313081388711_8972", parent_id: "853313081388711_8971", from: { id: TEST_PAGE_ID, name: "Page" }, message: OK.reply_text },
    { env: LIVE_ENV, graph: () => assert.fail("no loop") }
  );
  assert.equal(nestedEcho.body.reason, "self_authored");
  assert.equal(nestedEcho.mock.calls.length, 0);
});
