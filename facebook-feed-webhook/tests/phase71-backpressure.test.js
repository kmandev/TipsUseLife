/**
 * Phase 7.1 -- Hermes concurrency backpressure.
 *
 * Hermes' api_server rejects work beyond gateway.api_server.max_concurrent_runs
 * (default 10) with 429 + Retry-After BEFORE any agent run starts. Only that
 * outcome is retried: bounded attempts, jittered backoff, one overall deadline.
 * No network, no Facebook.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  requestAgentReplyWithBackpressure,
  parseRetryAfterMs,
  HermesError,
  BACKPRESSURE_DEFAULTS,
} from "../src/hermes.js";
import { createFakeD1, createEnv, createCtx, commentPayload, signedRequest, installFetchMock, hermesChat, captureConsole } from "./helpers.js";

const OK = { action: "REPLY", reply_text: "ขอบคุณที่สนใจครับ", include_affiliate_cta: false };
const busy = () => new Response(JSON.stringify({ error: { message: "Too many concurrent runs (max 10)" } }), {
  status: 429, headers: { "content-type": "application/json", "retry-after": "1" },
});

/** Virtual clock: sleep() advances time instantly. */
function clock(start = 1_000_000) {
  let t = start;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, advance: (ms) => { t += ms; }, sleeps };
}

function fetchSeq(responses, seen, c) {
  let i = 0;
  return async (url, init) => {
    seen.push(init);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (typeof r === "function") return r(c);
    return r;
  };
}

const REQ = { systemPrompt: "s", userMessage: "u", idempotencyKey: "fbc:853313081388711_1" };
const OPTS = (fetchImpl) => ({ url: "https://hermes.example.invalid/v1/chat/completions", apiKey: "k", timeoutMs: 25000, fetchImpl });

test("P7.1: Retry-After parsing accepts delta-seconds only", () => {
  assert.equal(parseRetryAfterMs("1"), 1000);
  assert.equal(parseRetryAfterMs(" 2 "), 2000);
  for (const v of [null, undefined, "", "abc", "-1", "1.5", "Wed, 21 Oct 2015 07:28:00 GMT", "9999"]) assert.equal(parseRetryAfterMs(v), null, String(v));
});

test("P7.1: 429 twice then success -> 3 attempts, same Idempotency-Key, bounded jittered delays", async () => {
  const c = clock();
  const seen = [];
  const r = await requestAgentReplyWithBackpressure(REQ, OPTS(fetchSeq([busy(), busy(), hermesChat(OK)], seen)), { now: c.now, sleep: c.sleep, random: () => 0.5 });
  assert.equal(r.attempts, 3);
  assert.equal(JSON.parse(r.content).action, "REPLY");
  assert.equal(seen.length, 3);
  assert.ok(seen.every((i) => i.headers["idempotency-key"] === "fbc:853313081388711_1"));
  assert.deepEqual(c.sleeps, [1500, 2500]); // max(RetryAfter=1s, n*1s) + 0.5*1000 jitter
  for (const ms of c.sleeps) assert.ok(ms <= BACKPRESSURE_DEFAULTS.maxDelayMs + BACKPRESSURE_DEFAULTS.jitterMs);
});

test("P7.1: attempts are capped -- persistent 429 fails closed as HERMES_BUSY after maxAttempts", async () => {
  const c = clock();
  const seen = [];
  await assert.rejects(
    requestAgentReplyWithBackpressure(REQ, OPTS(fetchSeq([busy()], seen)), { now: c.now, sleep: c.sleep, random: () => 0 }),
    (e) => e instanceof HermesError && e.category === "HERMES_BUSY" && e.statusCode === 429
  );
  assert.equal(seen.length, BACKPRESSURE_DEFAULTS.maxAttempts);
});

test("P7.1: never retries past the deadline -- total time stays within HERMES_TIMEOUT_MS", async () => {
  const c = clock();
  const seen = [];
  // Each 429 arrives after 7 s (slow upstream); after one backoff less than
  // a full attempt budget would remain, so it must stop.
  const slowBusy = async () => { c.advance(7000); return busy(); };
  await assert.rejects(
    requestAgentReplyWithBackpressure(REQ, OPTS(fetchSeq([slowBusy], seen)), { now: c.now, sleep: c.sleep, random: () => 1 }),
    (e) => e.category === "HERMES_BUSY"
  );
  const elapsed = c.now() - 1_000_000;
  assert.ok(elapsed <= 25000, `elapsed ${elapsed}ms`);
  assert.ok(seen.length < BACKPRESSURE_DEFAULTS.maxAttempts);
});

test("P7.1: each attempt only gets the REMAINING budget as its timeout", async () => {
  const c = clock();
  const timeouts = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { timeouts.push(ms); return origSetTimeout(fn, 0 * ms + 2 ** 30, ...a); };
  try {
    const seq = fetchSeq([async () => { c.advance(3000); return busy(); }, hermesChat(OK)], []);
    await requestAgentReplyWithBackpressure(REQ, OPTS(seq), { now: c.now, sleep: c.sleep, random: () => 0 });
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
  assert.equal(timeouts[0], 25000);
  assert.equal(timeouts[1], 25000 - 3000 - 1000);
});

test("P7.1: timeouts, network errors, 5xx, 401 and bad bodies are NOT retried", async () => {
  const cases = [
    [async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, "HERMES_TIMEOUT"],
    [async () => { throw new TypeError("fetch failed"); }, "HERMES_NETWORK_ERROR"],
    [new Response("x", { status: 502 }), "HERMES_HTTP_ERROR"],
    [new Response("x", { status: 503 }), "HERMES_HTTP_ERROR"],
    [new Response("x", { status: 401 }), "HERMES_UNAUTHORIZED"],
    [new Response("not json", { status: 200 }), "HERMES_RESPONSE_NOT_JSON"],
  ];
  for (const [resp, category] of cases) {
    const c = clock();
    const seen = [];
    await assert.rejects(
      requestAgentReplyWithBackpressure(REQ, OPTS(fetchSeq([resp, hermesChat(OK)], seen)), { now: c.now, sleep: c.sleep }),
      (e) => e.category === category,
      category
    );
    assert.equal(seen.length, 1, `${category} must not be retried`);
    assert.equal(c.sleeps.length, 0);
  }
});

test("P7.1 pipeline: a 429 burst slot is retried and the comment is answered once (DRY_RUN, no Graph)", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const logs = captureConsole();
  const mock = installFetchMock((url, init, n) => {
    if (/graph\.facebook\.com/.test(url)) assert.fail("no Graph call in DRY_RUN");
    return n === 1 ? busy() : hermesChat(OK);
  });
  try {
    await worker.fetch(await signedRequest(commentPayload({ value: { comment_id: "853313081388711_7101", message: "สนใจครับ" } })), createEnv({ DB: db }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
    logs.restore();
  }
  assert.equal(mock.graphCalls().length, 0);
  assert.equal(mock.calls.length, 2, "one 429 + one successful attempt");
  assert.equal(db._state.comments.length, 1);
  assert.equal(db._state.replies.length, 1);
  assert.equal(db._state.replies[0].status, "GENERATED");
  assert.equal(db._state.replies[0].mode, "DRY_RUN");
  assert.ok(logs.text().includes("hermes_busy_backoff"));
});

test("P7.1 pipeline: a Hermes timeout is still not retried and fails closed (ERROR, no reply)", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const mock = installFetchMock(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
  try {
    await worker.fetch(await signedRequest(commentPayload({ value: { comment_id: "853313081388711_7102", message: "สนใจครับ" } })), createEnv({ DB: db }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 1);
  assert.equal(db._state.comments[0].status, "ERROR");
  assert.equal(db._state.replies.length, 0);
});

test("P7.1 pipeline: duplicate delivery of the same comment still calls Hermes once and stores one reply", async () => {
  const db = createFakeD1();
  const mock = installFetchMock(() => hermesChat(OK));
  try {
    const payload = commentPayload({ value: { comment_id: "853313081388711_7103", message: "สนใจครับ" } });
    const ctxs = [createCtx(), createCtx(), createCtx()];
    await Promise.all(ctxs.map(async (ctx) => worker.fetch(await signedRequest(payload), createEnv({ DB: db }), ctx)));
    await Promise.all(ctxs.map((c) => c.settle()));
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 1);
  assert.equal(db._state.comments.length, 1);
  assert.equal(db._state.replies.length, 1);
});

test("P7.1 LIVE: backoff never causes a second Graph send for one comment", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const mock = installFetchMock((url, init, n) => {
    if (/graph\.facebook\.com/.test(url)) return new Response(JSON.stringify({ id: "853313081388711_r1" }), { status: 200, headers: { "content-type": "application/json" } });
    return n === 1 ? busy() : hermesChat(OK);
  });
  try {
    await worker.fetch(await signedRequest(commentPayload({ value: { comment_id: "853313081388711_7104", message: "สนใจครับ" } })), createEnv({ DB: db, REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "t" }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
  }
  assert.equal(mock.graphCalls().length, 1, "exactly one Graph send");
  assert.equal(db._state.replies.filter((r) => r.status === "SENT").length, 1);
});
