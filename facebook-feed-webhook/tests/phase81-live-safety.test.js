/**
 * Phase 8.1 -- LIVE safety hardening.
 *   B1  bounded Graph send + explicit Worker time budget + honest outcome states
 *   W1  self-reply protection layer 2 (our stored Facebook reply ids)
 *   W2  webhook page id must equal the configured Page
 * No network: Hermes and Graph are fetch stubs. No real token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { sendFacebookReply, FacebookSendError } from "../src/facebook-reply.js";
import { hermesBudgetMs } from "../src/pipeline.js";
import { resolveConfig, PIPELINE_BUDGET_MS, GRAPH_FINALIZE_MS, MODE_LIVE } from "../src/config.js";
import { hasLiveSendAttempt, isOwnReplyEvent, insertLiveSendMarker, finalizeLiveSend } from "../src/db.js";
import { createFakeD1, createEnv, createCtx, commentPayload, signedRequest, installFetchMock, hermesChat, jsonResponse, TEST_PAGE_ID } from "./helpers.js";

const OK = { action: "REPLY", reply_text: "ขอบคุณที่สนใจครับ", include_affiliate_cta: false };
const LIVE_ENV = { REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "unit-test-page-token", GRAPH_TIMEOUT_MS: "80" };
const isGraph = (url) => /graph\.facebook\.com/.test(url);

/** Run one webhook event in LIVE with a Graph stub. */
async function runLive(db, graph, { value = {}, env = {}, onHermes } = {}) {
  const ctx = createCtx();
  const mock = installFetchMock(async (url, init) => {
    if (isGraph(url)) return graph(url, init);
    onHermes?.();
    return hermesChat(OK);
  });
  try {
    const res = await worker.fetch(await signedRequest(commentPayload({ value })), createEnv({ DB: db, ...LIVE_ENV, ...env }), ctx);
    await ctx.settle();
    return { mock, res };
  } finally {
    mock.restore();
  }
}
const hangUntilAbort = (url, init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); }));
const liveRow = (db) => db._query("SELECT * FROM replies WHERE mode = 'LIVE' ORDER BY id")[0];

/* =============================== B1 =============================== */

test("B1: Graph fetch is aborted at its own timeout and reported AMBIGUOUS", async () => {
  const t0 = Date.now();
  await assert.rejects(
    sendFacebookReply({ commentId: "1", message: "x" }, { mode: MODE_LIVE, accessToken: "t", timeoutMs: 40, fetchImpl: hangUntilAbort }),
    (e) => e instanceof FacebookSendError && e.category === "GRAPH_TIMEOUT" && e.ambiguous === true
  );
  assert.ok(Date.now() - t0 < 1000, "aborted promptly");
});

test("B1: the Hermes budget always leaves the Graph slice inside the pipeline budget", () => {
  for (const hermesTimeoutMs of [20000, 25000, 60000]) {
    const config = { hermesTimeoutMs, graphTimeoutMs: 5000 };
    for (const elapsed of [0, 500, 5000, 15000]) {
      const h = hermesBudgetMs(config, 0, elapsed);
      assert.ok(elapsed + h + config.graphTimeoutMs + GRAPH_FINALIZE_MS <= PIPELINE_BUDGET_MS, `${hermesTimeoutMs}/${elapsed}`);
    }
  }
  assert.equal(hermesBudgetMs({ hermesTimeoutMs: 20000, graphTimeoutMs: 5000 }, 0, 0), 20000);
  const cfg = resolveConfig({});
  assert.equal(cfg.hermesTimeoutMs, 20000, "default Hermes budget is 20 s");
  assert.equal(cfg.graphTimeoutMs, 5000, "default Graph timeout is 5 s");
  assert.ok(PIPELINE_BUDGET_MS < 30000, "below the ~30 s waitUntil window");
});

test("B1: 2xx with a valid JSON id -> SENT with that id, exactly one Graph call", async () => {
  const db = createFakeD1();
  const { mock } = await runLive(db, () => jsonResponse({ id: "853313081388711_555" }));
  assert.equal(mock.graphCalls().length, 1);
  const r = liveRow(db);
  assert.equal(r.status, "SENT");
  assert.equal(r.facebook_reply_id, "853313081388711_555");
  assert.equal(r.error_message, null);
  assert.equal(db._state.comments[0].status, "REPLIED");
});

test("B1: 2xx with a malformed / empty body is still a successful send (never FAILED, never re-sent)", async () => {
  for (const body of ["not json", "", "{\"id\":", "{}"]) {
    const db = createFakeD1();
    const { mock } = await runLive(db, () => new Response(body, { status: 200 }));
    assert.equal(mock.graphCalls().length, 1, JSON.stringify(body));
    const r = liveRow(db);
    assert.equal(r.status, "SENT", JSON.stringify(body));
    assert.equal(r.facebook_reply_id, null);
    assert.equal(r.error_message, "SENT_ID_UNPARSEABLE");
    assert.equal(db._state.comments[0].status, "REPLIED");
  }
});

test("B1: 4xx is a confirmed rejection -> FAILED, no retry", async () => {
  for (const status of [400, 403, 429]) {
    const db = createFakeD1();
    const { mock } = await runLive(db, () => jsonResponse({ error: { message: "x" } }, status));
    assert.equal(mock.graphCalls().length, 1, String(status));
    const r = liveRow(db);
    assert.equal(r.status, "FAILED");
    assert.equal(r.error_message, `GRAPH_REJECTED_${status}`);
    assert.equal(db._state.comments[0].status, "ERROR");
  }
});

test("B1: 5xx, timeout and network failure are AMBIGUOUS -> stay GENERATED (never FAILED), no retry", async () => {
  const cases = [
    [() => new Response("oops", { status: 500 }), "GRAPH_OUTCOME_UNKNOWN:GRAPH_UNCERTAIN_500"],
    [() => new Response("oops", { status: 503 }), "GRAPH_OUTCOME_UNKNOWN:GRAPH_UNCERTAIN_503"],
    [hangUntilAbort, "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT"],
    [() => { throw new TypeError("fetch failed"); }, "GRAPH_OUTCOME_UNKNOWN:GRAPH_NETWORK_ERROR"],
  ];
  for (const [graph, expected] of cases) {
    const db = createFakeD1();
    const { mock } = await runLive(db, graph);
    assert.equal(mock.graphCalls().length, 1, expected);
    const rows = db._query("SELECT * FROM replies WHERE mode = 'LIVE'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "GENERATED", expected);
    assert.notEqual(rows[0].status, "FAILED");
    assert.equal(rows[0].error_message, expected);
    assert.equal(db._state.comments[0].status, "ERROR");
  }
});

test("B1: the send marker is on record BEFORE the Graph request is made", async () => {
  const db = createFakeD1();
  let atCallTime = null;
  await runLive(db, () => {
    atCallTime = db._query("SELECT mode, status, error_message FROM replies")[0];
    return jsonResponse({ id: "r1" });
  });
  assert.deepEqual({ ...atCallTime }, { mode: "LIVE", status: "GENERATED", error_message: "GRAPH_SEND_IN_PROGRESS" });
});

test("B1: if the marker cannot be written, nothing is sent", async () => {
  const db = createFakeD1({ failOn: /INSERT INTO replies/i });
  const { mock } = await runLive(db, () => assert.fail("Graph must not be called"));
  assert.equal(mock.graphCalls().length, 0);
  assert.equal(db._state.comments[0].status, "ERROR");
});

test("B1: a send that no longer fits the Worker budget is not started", async () => {
  const db = createFakeD1();
  const realNow = Date.now;
  try {
    // Hermes "takes" 26 s of the 27 s budget.
    const { mock } = await runLive(db, () => assert.fail("Graph must not be called"), {
      env: { GRAPH_TIMEOUT_MS: "5000" },
      onHermes: () => { const base = realNow(); Date.now = () => base + 26000; },
    });
    assert.equal(mock.graphCalls().length, 0);
  } finally {
    Date.now = realNow;
  }
  const r = liveRow(db);
  assert.equal(r.status, "SKIPPED");
  assert.equal(r.error_message, "SEND_BUDGET_EXHAUSTED");
  assert.equal(db._state.comments[0].status, "ERROR");
});

test("B1: redelivery after an AMBIGUOUS send never produces a second Graph call", async () => {
  const db = createFakeD1();
  await runLive(db, hangUntilAbort);
  const second = await runLive(db, () => assert.fail("no second send"));
  assert.equal(second.mock.graphCalls().length, 0);
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode='LIVE'")[0].n, 1);
});

test("B1: the LIVE gate treats any recorded attempt (GENERATED/SENT/FAILED) as already attempted", async () => {
  const db = createFakeD1();
  db._sqlite.exec(`INSERT INTO comments (facebook_comment_id, page_id, comment_text) VALUES ('c1','p','t'), ('c2','p','t'), ('c3','p','t'), ('c4','p','t'), ('c5','p','t')`);
  db._sqlite.exec(`INSERT INTO replies (comment_id, response_text, mode, status) VALUES
    (1,'a','LIVE','GENERATED'), (2,'a','LIVE','SENT'), (3,'a','LIVE','FAILED'), (4,'a','LIVE','SKIPPED'), (5,'a','DRY_RUN','GENERATED')`);
  assert.equal(await hasLiveSendAttempt(db, 1), true);
  assert.equal(await hasLiveSendAttempt(db, 2), true);
  assert.equal(await hasLiveSendAttempt(db, 3), true);
  assert.equal(await hasLiveSendAttempt(db, 4), false, "LIVE SKIPPED = nothing sent");
  assert.equal(await hasLiveSendAttempt(db, 5), false, "DRY_RUN never counts");
});

test("B1: a finished outcome is never overwritten by a later finalize", async () => {
  const db = createFakeD1();
  db._sqlite.exec(`INSERT INTO comments (facebook_comment_id, page_id, comment_text) VALUES ('c1','p','t')`);
  const id = await insertLiveSendMarker(db, { commentId: 1, responseText: "x" });
  await finalizeLiveSend(db, id, { status: "SENT", facebookReplyId: "r1" });
  await assert.rejects(finalizeLiveSend(db, id, { status: "FAILED", errorMessage: "late" }), /MARKER_NOT_FINALIZED/);
  assert.equal(db._query("SELECT status FROM replies")[0].status, "SENT");
});

test("B1: DRY_RUN never reaches Graph and writes no marker", async () => {
  const db = createFakeD1();
  const { mock } = await runLive(db, () => assert.fail("no Graph in DRY_RUN"), { env: { REPLY_MODE: "DRY_RUN" } });
  assert.equal(mock.graphCalls().length, 0);
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode='LIVE'")[0].n, 0);
  assert.equal(db._state.replies[0].status, "GENERATED");
  assert.equal(db._state.replies[0].mode, "DRY_RUN");
});

/* =============================== W1 =============================== */

function seedOwnReply(db, facebookReplyId) {
  db._sqlite.exec(`INSERT INTO comments (facebook_comment_id, page_id, comment_text) VALUES ('853313081388711_orig', '${TEST_PAGE_ID}', 't')`);
  db._sqlite.prepare(`INSERT INTO replies (comment_id, response_text, mode, status, facebook_reply_id) VALUES (1, 'ours', 'LIVE', 'SENT', ?)`).run(facebookReplyId);
}

async function deliver(db, value, env = {}) {
  const ctx = createCtx();
  const mock = installFetchMock((url) => (isGraph(url) ? assert.fail("no Graph") : hermesChat(OK)));
  try {
    const res = await worker.fetch(await signedRequest(commentPayload({ value })), createEnv({ DB: db, ...env }), ctx);
    await ctx.settle();
    return { mock, res, body: await res.json() };
  } finally {
    mock.restore();
  }
}

test("W1: a normal customer comment still processes", async () => {
  const db = createFakeD1();
  const { mock } = await deliver(db, { comment_id: "853313081388711_2001" });
  assert.equal(mock.calls.length, 1, "one Hermes call");
  assert.equal(db._state.replies.length, 1);
});

test("W1: the Page's own top-level reply event (from.id == Page) is skipped", async () => {
  const db = createFakeD1();
  const { mock, body } = await deliver(db, { comment_id: "853313081388711_2002", from: { id: TEST_PAGE_ID, name: "Page" } });
  assert.equal(mock.calls.length, 0);
  assert.equal(body.reason, "self_authored");
  assert.equal(db._state.comments.length, 0);
});

test("W1: an event whose comment id is one of our stored Facebook reply ids is skipped (even without from)", async () => {
  const db = createFakeD1();
  seedOwnReply(db, "853313081388711_3001");
  const { mock } = await deliver(db, { comment_id: "853313081388711_3001", parent_id: "853313081388711_orig", from: undefined });
  assert.equal(mock.calls.length, 0, "no AI call");
  assert.equal(db._query("SELECT COUNT(*) n FROM comments")[0].n, 1, "not stored");
  assert.equal(db._query("SELECT COUNT(*) n FROM replies")[0].n, 1, "no new reply");
});

test("W1: an event nested directly under our own reply is skipped", async () => {
  const db = createFakeD1();
  seedOwnReply(db, "853313081388711_3002");
  const { mock } = await deliver(db, { comment_id: "853313081388711_3003", parent_id: "853313081388711_3002" });
  assert.equal(mock.calls.length, 0);
  assert.equal(db._query("SELECT COUNT(*) n FROM comments")[0].n, 1);
});

test("W1: duplicate delivery of our own reply event is still skipped, no AI call, no reply", async () => {
  const db = createFakeD1();
  seedOwnReply(db, "853313081388711_3004");
  for (let i = 0; i < 3; i++) {
    const { mock } = await deliver(db, { comment_id: "853313081388711_3004", parent_id: "853313081388711_orig" });
    assert.equal(mock.calls.length, 0);
  }
  assert.equal(db._query("SELECT COUNT(*) n FROM replies")[0].n, 1);
});

test("W1: if the own-reply lookup fails, the event is dropped (fail closed)", async () => {
  const db = createFakeD1({ failOn: /facebook_reply_id IN/i });
  const { mock } = await deliver(db, { comment_id: "853313081388711_3005" });
  assert.equal(mock.calls.length, 0);
  assert.equal(db._query("SELECT COUNT(*) n FROM comments")[0].n, 0);
});

test("W1: LIVE end to end -- the webhook for the reply we just posted is ignored even if Meta omits from", async () => {
  const db = createFakeD1();
  await runLive(db, () => jsonResponse({ id: "853313081388711_9001" }), { value: { comment_id: "853313081388711_8001" } });
  const echo = await runLive(db, () => assert.fail("no loop"), {
    value: { comment_id: "853313081388711_9001", parent_id: "853313081388711_8001", from: undefined, message: "ขอบคุณที่สนใจครับ" },
  });
  assert.equal(echo.mock.calls.length, 0, "no Hermes, no Graph");
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode='LIVE'")[0].n, 1);
});

test("W1: isOwnReplyEvent ignores empty ids", async () => {
  const db = createFakeD1();
  assert.equal(await isOwnReplyEvent(db, { commentId: null, parentId: "" }), false);
});

/* =============================== W2 =============================== */

function payloadForPage(pageId, value = {}) {
  const p = commentPayload({ value });
  if (pageId === undefined) delete p.entry[0].id;
  else p.entry[0].id = pageId;
  return p;
}

async function deliverRaw(db, payload) {
  const ctx = createCtx();
  const mock = installFetchMock((url) => (isGraph(url) ? assert.fail("no Graph") : hermesChat(OK)));
  try {
    const res = await worker.fetch(await signedRequest(payload), createEnv({ DB: db }), ctx);
    await ctx.settle();
    return { mock, res, body: await res.json().catch(() => null) };
  } finally {
    mock.restore();
  }
}

test("W2: the configured Page id processes (DRY_RUN)", async () => {
  const db = createFakeD1();
  const { mock, body } = await deliverRaw(db, payloadForPage(TEST_PAGE_ID));
  assert.equal(body.status, "accepted");
  assert.equal(body.mode, "DRY_RUN");
  assert.equal(mock.calls.length, 1);
  assert.equal(db._state.replies[0].mode, "DRY_RUN");
});

test("W2: a different, missing or malformed Page id is ignored -- no storage, no Hermes, no Graph", async () => {
  for (const pageId of ["999999999999999", undefined, "", " 853313081388711", "853313081388711x", "0"]) {
    const db = createFakeD1();
    const { mock, body } = await deliverRaw(db, payloadForPage(pageId));
    assert.equal(mock.calls.length, 0, String(pageId));
    assert.equal(db._state.comments.length, 0, String(pageId));
    assert.equal(body.status, "ignored", String(pageId));
  }
});

test("W2: the incoming id is compared, never replaced -- a mixed batch only processes our Page", async () => {
  const db = createFakeD1();
  const payload = commentPayload({ value: { comment_id: "853313081388711_4001" } });
  payload.entry.push({ id: "111111111111111", time: 1, changes: [{ field: "feed", value: { ...payload.entry[0].changes[0].value, comment_id: "111111111111111_4002" } }] });
  const { mock } = await deliverRaw(db, payload);
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(db._state.comments.map((c) => c.page_id), [TEST_PAGE_ID]);
});

test("W2: signature verification still happens first (wrong page + bad signature -> 401)", async () => {
  const ctx = createCtx();
  const res = await worker.fetch(await signedRequest(payloadForPage("999"), { signature: "sha256=00" }), createEnv({ DB: createFakeD1() }), ctx);
  assert.equal(res.status, 401);
});
