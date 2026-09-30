/**
 * Phase 8.22 -- observability only (no behavior change).
 *   reply_sent / reply_send_failed / reply_send_ambiguous carry
 *     graph_elapsed_ms (monotonic, whole ms) and effective_timeout_ms
 *     (the exact timeout passed to sendFacebookReply);
 *   ai_action_skip carries a bounded skip_reason.
 * No network: Hermes and Graph are fetch stubs. No real token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  createFakeD1, createEnv, createCtx, commentPayload, signedRequest,
  installFetchMock, hermesChat, jsonResponse, captureConsole,
  TEST_META_SECRET, TEST_VERIFY_TOKEN, TEST_HERMES_API_KEY,
} from "./helpers.js";

const OK = { action: "REPLY", reply_text: "ขอบคุณที่สนใจครับ", include_affiliate_cta: false };
const TOKEN = "unit-test-page-token-phase822";
const LIVE_ENV = { REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: TOKEN, GRAPH_TIMEOUT_MS: "80" };
const isGraph = (url) => /graph\.facebook\.com/.test(url);
const hangUntilAbort = (url, init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); }));

/** Run one webhook event; returns the fetch mock, parsed log events and raw log text. */
async function run(db, { graph = () => assert.fail("Graph must not be called"), agent = OK, env = LIVE_ENV, onHermes } = {}) {
  const ctx = createCtx();
  const logs = captureConsole();
  const mock = installFetchMock(async (url, init) => {
    if (isGraph(url)) return graph(url, init);
    onHermes?.();
    return hermesChat(agent);
  });
  try {
    await worker.fetch(await signedRequest(commentPayload()), createEnv({ DB: db, ...env }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
    logs.restore();
  }
  const events = logs.lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return { mock, events, text: logs.text() };
}
const one = (events, name) => {
  const hits = events.filter((e) => e.event === name);
  assert.equal(hits.length, 1, `exactly one ${name}`);
  return hits[0];
};
const assertGraphTiming = (e) => {
  assert.ok(Number.isInteger(e.graph_elapsed_ms) && e.graph_elapsed_ms >= 0, `graph_elapsed_ms ${e.graph_elapsed_ms}`);
  assert.equal(e.effective_timeout_ms, 80, "effective_timeout_ms is the timeout actually used");
};

test("8.22 #1 Graph success -> reply_sent with graph_elapsed_ms + effective_timeout_ms; behavior unchanged", async () => {
  const db = createFakeD1();
  const { mock, events } = await run(db, { graph: () => jsonResponse({ id: "853313081388711_555" }) });
  assert.equal(mock.graphCalls().length, 1);
  const e = one(events, "reply_sent");
  assertGraphTiming(e);
  assert.equal(e.has_reply_id, true);
  const r = db._query("SELECT * FROM replies WHERE mode='LIVE'")[0];
  assert.equal(r.status, "SENT");
  assert.equal(r.facebook_reply_id, "853313081388711_555");
  assert.equal(db._state.comments[0].status, "REPLIED");
});

test("8.22 #2 Graph HTTP 4xx -> reply_send_failed with timing; FAILED unchanged; no retry", async () => {
  const db = createFakeD1();
  const { mock, events } = await run(db, { graph: () => jsonResponse({ error: { message: "x" } }, 400) });
  assert.equal(mock.graphCalls().length, 1);
  const e = one(events, "reply_send_failed");
  assertGraphTiming(e);
  assert.equal(e.error_category, "GRAPH_REJECTED_400");
  assert.equal(e.status_code, 400);
  const r = db._query("SELECT * FROM replies WHERE mode='LIVE'")[0];
  assert.equal(r.status, "FAILED");
  assert.equal(r.error_message, "GRAPH_REJECTED_400");
});

test("8.22 #2b Graph HTTP 5xx -> reply_send_ambiguous with timing; stays GENERATED", async () => {
  const db = createFakeD1();
  const { mock, events } = await run(db, { graph: () => new Response("oops", { status: 503 }) });
  assert.equal(mock.graphCalls().length, 1);
  const e = one(events, "reply_send_ambiguous");
  assertGraphTiming(e);
  assert.equal(e.error_category, "GRAPH_UNCERTAIN_503");
  const r = db._query("SELECT * FROM replies WHERE mode='LIVE'")[0];
  assert.equal(r.status, "GENERATED");
  assert.equal(r.error_message, "GRAPH_OUTCOME_UNKNOWN:GRAPH_UNCERTAIN_503");
});

test("8.22 #3 Graph timeout -> reply_send_ambiguous GRAPH_TIMEOUT with timing; ambiguous; exactly one call", async () => {
  const db = createFakeD1();
  const { mock, events } = await run(db, { graph: hangUntilAbort });
  assert.equal(mock.graphCalls().length, 1, "no retry");
  const e = one(events, "reply_send_ambiguous");
  assertGraphTiming(e);
  assert.equal(e.error_category, "GRAPH_TIMEOUT");
  assert.equal(e.status_code, null);
  assert.ok(e.graph_elapsed_ms >= 60, `elapsed ${e.graph_elapsed_ms} reflects the ~80 ms abort`);
  const rows = db._query("SELECT * FROM replies WHERE mode='LIVE'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "GENERATED");
  assert.equal(rows[0].error_message, "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT");
  assert.equal(db._state.comments[0].status, "ERROR");
});

test("8.22 #3b effective_timeout_ms is the budget-reduced value when the budget, not GRAPH_TIMEOUT_MS, is the limit", async () => {
  const db = createFakeD1();
  const realNow = Date.now;
  let events;
  try {
    // 27 s budget; Hermes "takes" 22 s -> remaining 5 s -> min(20000, 5000 - 1000) = 4000.
    ({ events } = await run(db, {
      env: { ...LIVE_ENV, GRAPH_TIMEOUT_MS: "20000" },
      graph: () => jsonResponse({ id: "853313081388711_556" }),
      onHermes: () => { const base = realNow(); Date.now = () => base + 22000; },
    }));
  } finally {
    Date.now = realNow;
  }
  const e = one(events, "reply_sent");
  assert.ok(e.effective_timeout_ms < 20000 && e.effective_timeout_ms >= 3990 && e.effective_timeout_ms <= 4000, `effective ${e.effective_timeout_ms}`);
});

test("8.22 #4 budget exhausted -> no Graph call and no Graph-outcome telemetry", async () => {
  const db = createFakeD1();
  const realNow = Date.now;
  let mock, events;
  try {
    ({ mock, events } = await run(db, {
      env: { ...LIVE_ENV, GRAPH_TIMEOUT_MS: "5000" },
      onHermes: () => { const base = realNow(); Date.now = () => base + 26000; },
    }));
  } finally {
    Date.now = realNow;
  }
  assert.equal(mock.graphCalls().length, 0);
  for (const name of ["reply_sent", "reply_send_failed", "reply_send_ambiguous"]) {
    assert.equal(events.filter((e) => e.event === name).length, 0, name);
  }
  assert.ok(!events.some((e) => "graph_elapsed_ms" in e), "no graph_elapsed_ms without a send");
  const blocked = one(events, "live_gate_blocked");
  assert.equal(blocked.error_category, "SEND_BUDGET_EXHAUSTED");
  const r = db._query("SELECT * FROM replies WHERE mode='LIVE'")[0];
  assert.equal(r.status, "SKIPPED");
  assert.equal(r.error_message, "SEND_BUDGET_EXHAUSTED");
});

test("8.22 #5 AI SKIP -> ai_action_skip carries skip_reason; D1 outcome unchanged; no Graph", async () => {
  const db = createFakeD1();
  const { mock, events } = await run(db, { agent: { action: "SKIP", reason: "irrelevant" } });
  assert.equal(mock.graphCalls().length, 0);
  const e = one(events, "ai_action_skip");
  assert.equal(e.skip_reason, "irrelevant");
  const c = db._state.comments[0];
  assert.equal(c.status, "SKIPPED");
  assert.equal(c.ai_action, "SKIP");
  const r = db._query("SELECT * FROM replies")[0];
  assert.equal(r.status, "SKIPPED");
  assert.equal(r.error_message, "AI_ACTION_SKIP");
});

test("8.22 #5b skip_reason is bounded and whitespace-normalised; a missing reason logs null", async () => {
  const long = "  spam\n\n" + "x".repeat(500);
  let { events } = await run(createFakeD1(), { agent: { action: "SKIP", reason: long } });
  const e = one(events, "ai_action_skip");
  assert.ok(e.skip_reason.length <= 61, `len ${e.skip_reason.length}`);
  assert.ok(!/\s{2,}|\n/.test(e.skip_reason));
  ({ events } = await run(createFakeD1(), { agent: { action: "SKIP" } }));
  assert.equal(one(events, "ai_action_skip").skip_reason, null);
});

test("8.22 #6 AI REPLY in DRY_RUN -> unchanged; no Graph, no Graph telemetry, no skip event", async () => {
  const db = createFakeD1();
  const { mock, events } = await run(db, { env: { REPLY_MODE: "DRY_RUN" } });
  assert.equal(mock.graphCalls().length, 0);
  assert.equal(events.filter((e) => e.event === "ai_action_skip").length, 0);
  assert.ok(!events.some((e) => "graph_elapsed_ms" in e));
  const r = db._query("SELECT * FROM replies")[0];
  assert.equal(r.mode, "DRY_RUN");
  assert.equal(r.status, "GENERATED");
});

test("8.22 #7 malformed AI output -> existing rejection path, never AI_ACTION_SKIP", async () => {
  for (const agent of ["not json at all", { action: "MAYBE" }]) {
    const db = createFakeD1();
    const { mock, events } = await run(db, { agent });
    assert.equal(mock.graphCalls().length, 0);
    assert.equal(events.filter((e) => e.event === "ai_action_skip").length, 0, JSON.stringify(agent));
    assert.equal(one(events, "ai_response_rejected").event, "ai_response_rejected");
    const c = db._state.comments[0];
    assert.equal(c.ai_action, null);
    const r = db._query("SELECT * FROM replies")[0];
    assert.notEqual(r.error_message, "AI_ACTION_SKIP");
  }
});

test("8.22 #8 no secret or authorization value appears in any log line", async () => {
  const outputs = [];
  for (const graph of [() => jsonResponse({ id: "853313081388711_557" }), () => jsonResponse({ error: {} }, 403), hangUntilAbort]) {
    outputs.push((await run(createFakeD1(), { graph })).text);
  }
  outputs.push((await run(createFakeD1(), { agent: { action: "SKIP", reason: "irrelevant" } })).text);
  const all = outputs.join("\n");
  for (const secret of [TOKEN, TEST_META_SECRET, TEST_VERIFY_TOKEN, TEST_HERMES_API_KEY]) {
    assert.ok(!all.includes(secret), "secret leaked into logs");
  }
  assert.ok(!/bearer\s/i.test(all), "no authorization header value");
});
