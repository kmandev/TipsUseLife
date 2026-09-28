/**
 * Phase 8.6 -- safe-scope tests from the Facebook write readiness audit.
 *
 * These tests LOCK CURRENT BEHAVIOUR. They change no production code.
 * Two of them deliberately document KNOWN SAFETY GAPS that have not been
 * hardened yet (see "KNOWN GAP" in the test names). When the hardening is
 * approved and implemented, those assertions must be flipped on purpose --
 * a failure there is the signal that behaviour changed.
 *
 * No network: Hermes and Graph are fetch stubs (helpers.installFetchMock).
 * No real token: the LIVE runs use a unit-test placeholder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { requestAgentReply, HermesError } from "../src/hermes.js";
import { isSelfEvent, extractCommentEvents } from "../src/facebook.js";
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

/** The retired async webhook acknowledgement shape (/webhooks/{route}). */
const ACK = { status: "accepted", route: "facebook-comments", event: "feed", delivery_id: "delivery-test-1" };

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

/* ===================== 1. Hermes async acknowledgement ===================== */

for (const status of [202, 200]) {
  test(`Hermes ACK: an HTTP ${status} {status,route,event,delivery_id} body is never an AI reply (HERMES_RESPONSE_NO_CHOICES)`, async () => {
    await assert.rejects(
      requestAgentReply(
        { systemPrompt: "s", userMessage: "u" },
        { url: "https://hermes.example.invalid/v1/chat/completions", apiKey: "k", fetchImpl: async () => jsonResponse(ACK, status) }
      ),
      (e) => e instanceof HermesError && e.category === "HERMES_RESPONSE_NO_CHOICES" && e.statusCode === status
    );
  });
}

for (const [label, env] of [["DRY_RUN", {}], ["LIVE", LIVE_ENV]]) {
  test(`Hermes ACK end to end (${label}): comment becomes ERROR, no reply row, no Graph call`, async () => {
    for (const status of [202, 200]) {
      const db = createFakeD1();
      const { mock } = await deliver(db, { comment_id: `853313081388711_86${status}` }, { env, hermes: () => jsonResponse(ACK, status) });
      assert.equal(mock.graphCalls().length, 0, `no Graph call (${status})`);
      assert.equal(mock.calls.length, 1, `exactly one Hermes call, not retried (${status})`);
      assert.equal(db._state.comments.length, 1);
      assert.equal(db._state.comments[0].status, "ERROR", `status ${status}`);
      assert.equal(db._state.comments[0].ai_response, null);
      assert.equal(db._query("SELECT COUNT(*) n FROM replies")[0].n, 0, `no reply row (${status})`);
    }
  });
}

/* ========================== 2. Missing `from` ========================== */

test("missing from: the parser keeps the event with author_id = null", () => {
  const events = extractCommentEvents(commentPayload({ value: { comment_id: "853313081388711_8601", from: undefined } }));
  assert.equal(events.length, 1);
  assert.equal(events[0].author_id, null);
  assert.equal(events[0].author_name, null);
});

test("KNOWN GAP (not hardened): isSelfEvent() returns false when from is missing -- layer 1 does not treat it as self", () => {
  // Current behaviour, locked on purpose. Layer 1 can only recognise the
  // Page when Meta sends from.id; without it, only layer 2 (stored reply
  // ids) can catch our own reply. Fail-closed hardening is NOT approved yet.
  assert.equal(isSelfEvent({ author_id: null }, TEST_PAGE_ID), false);
  assert.equal(isSelfEvent({ author_id: undefined }, TEST_PAGE_ID), false);
  // Contrast: the cases layer 1 does catch today.
  assert.equal(isSelfEvent({ author_id: TEST_PAGE_ID }, TEST_PAGE_ID), true);
  assert.equal(isSelfEvent({ author_id: null }, ""), true, "unknown Page id still fails closed");
});

test("KNOWN GAP (not hardened): a webhook event without from is processed like a customer comment (DRY_RUN, no Graph)", async () => {
  const db = createFakeD1();
  const { mock, body } = await deliver(db, { comment_id: "853313081388711_8602", from: undefined });
  assert.equal(body.status, "accepted");
  assert.equal(mock.calls.length, 1, "one Hermes call");
  assert.equal(mock.graphCalls().length, 0);
  assert.equal(db._state.comments.length, 1);
  assert.equal(db._state.comments[0].author_id, null);
  assert.equal(db._query("SELECT mode, status FROM replies")[0].mode, "DRY_RUN");
});

/* ================ 3. SENT_ID_UNPARSEABLE -> own-reply echo ================ */

/** LIVE send of a customer comment whose Graph 2xx body has no usable id. */
async function sendWithUnparseableId(db) {
  const first = await deliver(db, { comment_id: "853313081388711_8701" }, { env: LIVE_ENV, graph: () => new Response("{}", { status: 200 }) });
  assert.equal(first.mock.graphCalls().length, 1);
  const row = db._query("SELECT status, facebook_reply_id, error_message FROM replies WHERE mode = 'LIVE'")[0];
  assert.deepEqual({ ...row }, { status: "SENT", facebook_reply_id: null, error_message: "SENT_ID_UNPARSEABLE" });
}

test("SENT_ID_UNPARSEABLE: the echo of our reply WITH from.id == Page is still ignored by layer 1 (safe)", async () => {
  const db = createFakeD1();
  await sendWithUnparseableId(db);
  const echo = await deliver(
    db,
    { comment_id: "853313081388711_9701", parent_id: "853313081388711_8701", from: { id: TEST_PAGE_ID, name: "Page" }, message: OK.reply_text },
    { env: LIVE_ENV, graph: () => assert.fail("no loop") }
  );
  assert.equal(echo.body.reason, "self_authored");
  assert.equal(echo.mock.calls.length, 0, "no Hermes, no Graph");
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode = 'LIVE'")[0].n, 1);
});

test("KNOWN GAP (not hardened): after SENT_ID_UNPARSEABLE, an echo WITHOUT from is not recognised and gets a second LIVE reply", async () => {
  // Current behaviour, locked on purpose so the gap stays visible:
  //   layer 1 cannot match (no from.id), layer 2 cannot match (no stored
  //   facebook_reply_id), and the echo is a NEW comment row, so
  //   hasLiveSendAttempt() does not block it either. Each further echo with
  //   the same two conditions would repeat this -- a potential loop.
  // Both conditions must hold at once; the tests above show that either
  // from.id or a parsed reply id is enough to stop it.
  const db = createFakeD1();
  await sendWithUnparseableId(db);
  const echo = await deliver(
    db,
    { comment_id: "853313081388711_9702", parent_id: "853313081388711_8701", from: undefined, message: OK.reply_text },
    { env: LIVE_ENV, graph: () => jsonResponse({ id: "853313081388711_9703" }) }
  );
  assert.equal(echo.mock.calls.length, 2, "one Hermes call + one Graph call for our own echo");
  assert.equal(echo.mock.graphCalls().length, 1);
  assert.equal(db._query("SELECT COUNT(*) n FROM comments")[0].n, 2, "echo stored as a new comment");
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode = 'LIVE' AND status = 'SENT'")[0].n, 2, "second LIVE reply");
});

test("SENT_ID_UNPARSEABLE: redelivery of the ORIGINAL customer comment is still blocked (no second send)", async () => {
  const db = createFakeD1();
  await sendWithUnparseableId(db);
  const again = await deliver(db, { comment_id: "853313081388711_8701" }, { env: LIVE_ENV, graph: () => assert.fail("no resend") });
  assert.equal(again.mock.calls.length, 0);
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE mode = 'LIVE'")[0].n, 1);
});
