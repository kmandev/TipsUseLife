/**
 * Phase 8.50 -- L1 hardening + Graph response observability (no behaviour change).
 *   L1: a late non-2xx response's body is released without being awaited, so
 *       a cancel() that never settles can no longer hold the late observation.
 *   Observability: an EARLY response reports headers_ms + Facebook trace ids;
 *       reply_sent carries them. graph_elapsed_ms keeps its meaning.
 * No network: Graph and Hermes are stubs. Short timers, test-controlled releases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { sendFacebookReply, FacebookSendError } from "../src/facebook-reply.js";
import {
  createFakeD1, createEnv, createCtx, commentPayload, signedRequest, installFetchMock, hermesChat, captureConsole,
  TEST_META_SECRET, TEST_VERIFY_TOKEN, TEST_HERMES_API_KEY,
} from "./helpers.js";

let unhandled = 0;
process.on("unhandledRejection", () => {
  unhandled += 1;
});

const TOKEN = "unit-test-page-token-phase850";
const OK = { action: "REPLY", reply_text: "ขอบคุณที่สนใจครับ", include_affiliate_cta: false };
const FB_ID = "853313081388711_850001";
const isGraph = (u) => /graph\.facebook\.com/.test(u);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const okResponse = (body = { id: FB_ID }, status = 200, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function controlledFetch() {
  const calls = [];
  let settle;
  const impl = (url, init) => {
    calls.push({ url, method: init.method });
    return new Promise((resolve, reject) => {
      settle = { resolve, reject };
      init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };
  return { impl, calls, resolve: (r) => settle.resolve(r) };
}
/** A response whose body.cancel() behaves as given; records that cancel was called. */
function cancelResponse(status, cancelImpl) {
  const seen = { cancelled: 0 };
  return {
    seen,
    response: {
      status,
      headers: new Headers({ "x-fb-trace-id": "LateTr4ce" }),
      body: { cancel: () => { seen.cancelled += 1; return cancelImpl(); } },
      text: () => Promise.resolve("{}"),
    },
  };
}
const send = (fx, extra = {}) =>
  sendFacebookReply({ commentId: "1_2", message: "hi" }, { mode: "LIVE", accessToken: TOKEN, timeoutMs: 30, observeUntilMs: 2000, fetchImpl: fx.impl, ...extra });
async function lateErr(p) {
  const e = await p.then(() => assert.fail("expected GRAPH_TIMEOUT"), (x) => x);
  assert.ok(e instanceof FacebookSendError && e.category === "GRAPH_TIMEOUT" && e.late);
  return e;
}
/** Resolve within `ms` or fail (proves "not awaited indefinitely"). */
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => assert.fail(`not settled within ${ms} ms`))]);

/* ------------------------------ L1 ------------------------------ */
test("8.50 L1 late non-2xx whose body.cancel() NEVER settles -> late result still returned promptly; classification unchanged", async () => {
  for (const status of [400, 503]) {
    const fx = controlledFetch();
    const err = await lateErr(send(fx));
    const { response, seen } = cancelResponse(status, () => new Promise(() => {}));
    const t0 = Date.now();
    fx.resolve(response);
    const late = await within(err.late, 300); // hard deadline is 2000 ms: this proves no wait on cancel
    assert.ok(Date.now() - t0 < 300);
    assert.equal(late.kind, "RESPONSE");
    assert.equal(late.statusCode, status);
    assert.equal(late.id, null);
    assert.equal(late.bodyError, null);
    assert.equal(late.traceId, "LateTr4ce");
    assert.equal(seen.cancelled, 1, "body is still released");
    assert.equal(fx.calls.length, 1);
  }
});

test("8.50 L1 cancel() that rejects or throws synchronously -> no unhandled rejection, same result", async () => {
  for (const impl of [() => Promise.reject(new Error("cancel failed")), () => { throw new Error("sync"); }, () => undefined]) {
    const fx = controlledFetch();
    const err = await lateErr(send(fx));
    const { response, seen } = cancelResponse(500, impl);
    fx.resolve(response);
    const late = await within(err.late, 300);
    assert.equal(late.statusCode, 500);
    assert.equal(late.id, null);
    assert.equal(seen.cancelled, 1);
  }
  await sleep(20);
  assert.equal(unhandled, 0);
});

test("8.50 L1 pipeline: late 503 with a never-settling cancel -> graph_late_response logged, row stays AMBIGUOUS, one POST", async () => {
  const db = createFakeD1();
  let release;
  const graph = (url, init) =>
    new Promise((resolve, reject) => {
      release = resolve;
      init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  const run = await start(db, graph, { GRAPH_LATE_OBSERVE_MS: "3000" });
  await waitFor(() => db._query("SELECT error_message FROM replies WHERE mode='LIVE'")[0]?.error_message === "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT");
  const { response } = cancelResponse(503, () => new Promise(() => {}));
  const t0 = Date.now();
  release(response);
  const { events } = await run.finish();
  assert.ok(Date.now() - t0 < 1000, "pipeline did not wait for cancel or for the 3 s deadline");
  assert.equal(posts(run.mock), 1);
  const late = events.filter((e) => e.event === "graph_late_response");
  assert.equal(late.length, 1);
  assert.equal(late[0].error_category, "GRAPH_LATE_HTTP_503");
  assert.equal(late[0].outcome, "KEPT_AMBIGUOUS");
  const r = db._query("SELECT * FROM replies WHERE mode='LIVE'");
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "GENERATED");
  assert.equal(r[0].facebook_reply_id, null);
  assert.equal(db._state.comments[0].status, "ERROR");
});

/* ------------------------- Observability (unit) ------------------------- */
test("8.50 O1 early 2xx -> onResponseHeaders gets headersMs, status, trace + request id; return value unchanged", async () => {
  const fx = controlledFetch();
  const metas = [];
  const p = send(fx, { onResponseHeaders: (m) => metas.push(m) });
  await sleep(15);
  fx.resolve(okResponse({ id: FB_ID }, 200, { "x-fb-trace-id": "AbC123xyz", "x-fb-request-id": "Req_9.9" }));
  assert.deepEqual(await p, { id: FB_ID }, "return shape is exactly as before");
  assert.equal(metas.length, 1);
  assert.equal(metas[0].statusCode, 200);
  assert.equal(metas[0].traceId, "AbC123xyz");
  assert.equal(metas[0].requestId, "Req_9.9");
  assert.ok(Number.isInteger(metas[0].headersMs) && metas[0].headersMs >= 10);
  assert.equal(fx.calls.length, 1);
});

test("8.50 O2 absent, over-long or unsafe trace headers -> null (never fabricated, never raw)", async () => {
  const cases = [
    [{}, null, null],
    [{ "x-fb-trace-id": "x".repeat(81), "x-fb-request-id": "a b" }, null, null],
    [{ "x-fb-trace-id": "tok\"en", "x-fb-request-id": "ok_1" }, null, "ok_1"],
  ];
  for (const [headers, trace, reqId] of cases) {
    const fx = controlledFetch();
    let meta;
    const p = send(fx, { onResponseHeaders: (m) => (meta = m) });
    fx.resolve(okResponse({ id: FB_ID }, 200, headers));
    await p;
    assert.equal(meta.traceId, trace, JSON.stringify(headers));
    assert.equal(meta.requestId, reqId, JSON.stringify(headers));
  }
});

test("8.50 O3 a throwing callback cannot change the outcome; early 4xx still rejected as before", async () => {
  const fx = controlledFetch();
  const p = send(fx, { onResponseHeaders: () => { throw new Error("observer bug"); } });
  fx.resolve(okResponse());
  assert.deepEqual(await p, { id: FB_ID });
  const fx2 = controlledFetch();
  const p2 = send(fx2, { onResponseHeaders: () => { throw new Error("observer bug"); } });
  fx2.resolve(okResponse({ error: {} }, 400));
  const e = await p2.then(() => assert.fail(), (x) => x);
  assert.equal(e.category, "GRAPH_REJECTED_400");
  assert.equal(e.ambiguous, false);
});

test("8.50 O4 no callback for a LATE response (late telemetry stays on graph_late_response) and none without option", async () => {
  const fx = controlledFetch();
  let called = 0;
  const err = await lateErr(send(fx, { onResponseHeaders: () => (called += 1) }));
  fx.resolve(okResponse());
  const late = await err.late;
  assert.equal(late.id, FB_ID);
  assert.equal(called, 0);
  for (const observeUntilMs of [0, 2000]) {
    const fx3 = controlledFetch();
    const p = send(fx3, { observeUntilMs });
    fx3.resolve(okResponse());
    assert.deepEqual(await p, { id: FB_ID });
  }
});

/* ----------------------- Observability (pipeline) ----------------------- */
const LIVE = { REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: TOKEN, GRAPH_TIMEOUT_MS: "200", GRAPH_LATE_OBSERVE_MS: "600" };
async function start(db, graph, envExtra = {}) {
  const ctx = createCtx();
  const logs = captureConsole();
  const mock = installFetchMock(async (url, init) => (isGraph(url) ? graph(url, init) : hermesChat(OK)));
  await worker.fetch(await signedRequest(commentPayload()), createEnv({ DB: db, ...LIVE, ...envExtra }), ctx);
  return {
    mock,
    async finish() {
      try {
        await ctx.settle();
      } finally {
        mock.restore();
        logs.restore();
      }
      return {
        events: logs.lines.flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        }),
        text: logs.text(),
      };
    },
  };
}
const posts = (mock) => mock.calls.filter((c) => isGraph(c.url) && c.method === "POST").length;
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(3);
  }
  assert.fail("condition not reached");
}

test("8.50 P1 reply_sent carries headers_ms, status_code, fb_trace_id, fb_request_id; graph_elapsed_ms keeps its meaning", async () => {
  const db = createFakeD1();
  // headers after ~20 ms, body after a further ~60 ms
  const graph = async () => {
    await sleep(20);
    return {
      status: 200,
      headers: new Headers({ "x-fb-trace-id": "Tr4ce_1", "x-fb-request-id": "Rq-2" }),
      text: () => sleep(60).then(() => JSON.stringify({ id: FB_ID })),
    };
  };
  const run = await start(db, graph);
  const { events } = await run.finish();
  assert.equal(posts(run.mock), 1);
  const sent = events.filter((e) => e.event === "reply_sent");
  assert.equal(sent.length, 1);
  const e = sent[0];
  assert.equal(e.status_code, 200);
  assert.equal(e.fb_trace_id, "Tr4ce_1");
  assert.equal(e.fb_request_id, "Rq-2");
  assert.ok(Number.isInteger(e.headers_ms) && e.headers_ms >= 15, `headers_ms ${e.headers_ms}`);
  assert.ok(e.graph_elapsed_ms >= e.headers_ms + 50, "graph_elapsed_ms still covers the body read");
  assert.equal(e.effective_timeout_ms, 200);
  const r = db._query("SELECT * FROM replies WHERE mode='LIVE'");
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "SENT");
  assert.equal(r[0].facebook_reply_id, FB_ID);
  assert.equal(r[0].error_message, null);
  assert.equal(db._state.comments[0].status, "REPLIED");
});

test("8.50 P2 reply_sent with no Facebook headers -> null fields, success unchanged", async () => {
  const db = createFakeD1();
  const run = await start(db, () => okResponse());
  const { events } = await run.finish();
  const e = events.find((x) => x.event === "reply_sent");
  assert.equal(e.fb_trace_id, null);
  assert.equal(e.fb_request_id, null);
  assert.equal(e.status_code, 200);
  assert.ok(Number.isInteger(e.headers_ms));
  assert.equal(db._query("SELECT status FROM replies WHERE mode='LIVE'")[0].status, "SENT");
});

test("8.50 P3 late path unchanged: no reply_sent, LATE_RESPONSE provenance, late event still has its trace id", async () => {
  const db = createFakeD1();
  let release;
  const graph = (url, init) =>
    new Promise((resolve, reject) => {
      release = resolve;
      init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  const run = await start(db, graph);
  await waitFor(() => db._query("SELECT error_message FROM replies WHERE mode='LIVE'")[0]?.error_message === "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT");
  release(okResponse({ id: FB_ID }, 200, { "x-fb-trace-id": "Late1" }));
  const { events } = await run.finish();
  assert.equal(posts(run.mock), 1);
  assert.equal(events.filter((e) => e.event === "reply_sent").length, 0);
  const late = events.find((e) => e.event === "graph_late_response");
  assert.equal(late.cas_applied, true);
  assert.equal(late.fb_trace_id, "Late1");
  assert.match(db._query("SELECT error_message FROM replies WHERE mode='LIVE'")[0].error_message, /^LATE_RESPONSE:/);
});

test("8.50 P4 DRY_RUN -> no POST, no Graph telemetry", async () => {
  const db = createFakeD1();
  const run = await start(db, () => assert.fail("Graph must not be called"), { REPLY_MODE: "DRY_RUN" });
  const { events } = await run.finish();
  assert.equal(posts(run.mock), 0);
  assert.ok(!events.some((e) => "headers_ms" in e || "fb_trace_id" in e));
});

test("8.50 P5 no token, authorization, secret or reply/comment text in any log line", async () => {
  const texts = [];
  const db = createFakeD1();
  const run = await start(db, () => okResponse({ id: FB_ID }, 200, { "x-fb-trace-id": "T1", authorization: `Bearer ${TOKEN}`, "set-cookie": "s=1" }));
  texts.push((await run.finish()).text);
  const all = texts.join("\n");
  for (const secret of [TOKEN, TEST_META_SECRET, TEST_VERIFY_TOKEN, TEST_HERMES_API_KEY]) assert.ok(!all.includes(secret));
  assert.ok(!/bearer\s/i.test(all));
  assert.ok(!all.includes("s=1"));
  assert.ok(!all.includes(OK.reply_text));
});

test("8.50 U-final no unhandled promise rejection in this file", async () => {
  await sleep(50);
  assert.equal(unhandled, 0);
});
