/**
 * Phase 8.2 -- operator recovery (W3) and operational health (W6).
 * Real in-memory SQLite with all migrations; Hermes and Graph are stubs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { recoverComment, getRecoveryState, claimForRecovery, healthStats, listRecoveryAttention, recoveryAction, RECOVERY_REASONS } from "../src/recovery.js";
import { resolveConfig } from "../src/config.js";
import { DASHBOARD_JS } from "../src/dashboard.js";
import { createFakeD1, createEnv, createCtx, installFetchMock, hermesChat, jsonResponse, TEST_PAGE_ID } from "./helpers.js";
import { makeSessionToken, cookieHeader, TEST_SESSION_SECRET, TEST_ADMIN_PASSWORD } from "./admin-helpers.js";

const OK = { action: "REPLY", reply_text: "ขอบคุณที่สนใจครับ", include_affiliate_cta: false };
const CTA = { action: "REPLY", reply_text: "ได้เลยครับ 👇 กดดูสินค้าได้ที่นี่ครับ", include_affiliate_cta: true };
const isGraph = (u) => /graph\.facebook\.com/.test(u);
const LIVE = { REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "unit-test-page-token", GRAPH_TIMEOUT_MS: "80" };
const POST = "853313081388711_900";

let seq = 0;
/** Insert a comment row with an age in seconds (and optional replies). */
function seedComment(db, { status = "ERROR", ageSec = 600, updatedAgeSec = null, post = POST, replies = [] } = {}) {
  seq += 1;
  const fid = `853313081388711_82${String(seq).padStart(4, "0")}`;
  db._sqlite
    .prepare(
      `INSERT INTO comments (facebook_comment_id, facebook_post_id, facebook_parent_id, page_id, author_id, author_name, comment_text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'A', 'สนใจครับ', ?, datetime('now', ?), datetime('now', ?))`
    )
    .run(fid, post, post, TEST_PAGE_ID, `author-82-${seq}`, status, `-${ageSec} seconds`, `-${updatedAgeSec ?? ageSec} seconds`);
  const id = Number(db._query("SELECT id FROM comments WHERE facebook_comment_id = ?", fid)[0].id);
  for (const r of replies) {
    db._sqlite
      .prepare(`INSERT INTO replies (comment_id, response_text, mode, status, error_message, facebook_reply_id) VALUES (?, 'x', ?, ?, ?, ?)`)
      .run(id, r.mode, r.status, r.error_message ?? null, r.facebook_reply_id ?? null);
  }
  return { id, fid };
}
const cfg = (extra = {}) => resolveConfig(createEnv(extra));
const reasonOf = async (db, id) => (await getRecoveryState(db, id, TEST_PAGE_ID)).reason;

/* ============================ eligibility ============================ */

test("P8.2 eligibility: the full matrix", async () => {
  const db = createFakeD1();
  const cases = [
    [{ status: "ERROR" }, "ELIGIBLE"],
    [{ status: "ERROR", ageSec: 25 * 3600 }, "TOO_OLD"],
    [{ status: "RECEIVED", ageSec: 30 }, "RECENT_RECEIVED"],
    [{ status: "RECEIVED", ageSec: 300 }, "ELIGIBLE"],
    [{ status: "ERROR", replies: [{ mode: "LIVE", status: "SKIPPED", error_message: "SEND_BUDGET_EXHAUSTED" }] }, "ELIGIBLE"],
    [{ status: "ERROR", replies: [{ mode: "LIVE", status: "GENERATED", error_message: "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT" }] }, "PROTECTED_AMBIGUOUS_SEND"],
    [{ status: "RECEIVED", ageSec: 900, replies: [{ mode: "LIVE", status: "GENERATED", error_message: "GRAPH_SEND_IN_PROGRESS" }] }, "PROTECTED_SEND_IN_PROGRESS"],
    [{ status: "ERROR", replies: [{ mode: "LIVE", status: "FAILED", error_message: "GRAPH_REJECTED_400" }] }, "PROTECTED_GRAPH_FAILED"],
    [{ status: "REPLIED", replies: [{ mode: "LIVE", status: "SENT", facebook_reply_id: "r1" }] }, "ALREADY_SENT"],
    [{ status: "ERROR", replies: [{ mode: "DRY_RUN", status: "GENERATED" }] }, "EXISTING_REPLY"],
    [{ status: "ERROR", replies: [{ mode: "DRY_RUN", status: "SKIPPED", error_message: "AI_ACTION_SKIP" }] }, "EXISTING_REPLY"],
    [{ status: "ERROR", replies: [{ mode: "LIVE", status: "SKIPPED", error_message: "PRODUCT_CONTEXT_INVALID" }] }, "UNEXPECTED_REPLY_STATE"],
    [{ status: "ERROR", replies: [{ mode: "LIVE", status: "GENERATED", error_message: "SOMETHING_ELSE" }] }, "UNEXPECTED_REPLY_STATE"],
    [{ status: "ERROR", replies: [
      { mode: "LIVE", status: "SKIPPED", error_message: "SEND_BUDGET_EXHAUSTED" },
      { mode: "LIVE", status: "SKIPPED", error_message: "SEND_BUDGET_EXHAUSTED" }] }, "UNEXPECTED_REPLY_STATE"],
    [{ status: "PROCESSED" }, "NOT_ELIGIBLE_STATUS"],
    [{ status: "SKIPPED" }, "NOT_ELIGIBLE_STATUS"],
    // Protected states stay protected even when old.
    [{ status: "ERROR", ageSec: 48 * 3600, replies: [{ mode: "LIVE", status: "GENERATED", error_message: "GRAPH_OUTCOME_UNKNOWN:GRAPH_UNCERTAIN_503" }] }, "PROTECTED_AMBIGUOUS_SEND"],
  ];
  for (const [spec, expected] of cases) {
    const { id } = seedComment(db, spec);
    assert.equal(await reasonOf(db, id), expected, JSON.stringify(spec));
  }
  assert.equal(recoveryAction("ELIGIBLE"), "RETRY");
  assert.equal(recoveryAction("PROTECTED_AMBIGUOUS_SEND"), "CHECK_FACEBOOK_NO_RETRY");
  assert.equal(recoveryAction("PROTECTED_SEND_IN_PROGRESS"), "CHECK_FACEBOOK_NO_RETRY");
  for (const r of ["TOO_OLD", "ALREADY_SENT", "PROTECTED_GRAPH_FAILED", "EXISTING_REPLY", "UNEXPECTED_REPLY_STATE"]) assert.equal(recoveryAction(r), "NONE");
});

test("P8.2 eligibility: claim, recovery list and health use the SAME rule", async () => {
  const db = createFakeD1();
  const ok = seedComment(db, { status: "ERROR" });
  const old = seedComment(db, { status: "ERROR", ageSec: 30 * 3600 });
  const amb = seedComment(db, { status: "ERROR", replies: [{ mode: "LIVE", status: "GENERATED", error_message: "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT" }] });
  const list = await listRecoveryAttention(db, TEST_PAGE_ID);
  const byId = Object.fromEntries(list.map((r) => [r.id, r.recovery]));
  assert.deepEqual(byId[ok.id], { reason: "ELIGIBLE", eligible: true, action: "RETRY" });
  assert.deepEqual(byId[old.id], { reason: "TOO_OLD", eligible: false, action: "NONE" });
  assert.deepEqual(byId[amb.id], { reason: "PROTECTED_AMBIGUOUS_SEND", eligible: false, action: "CHECK_FACEBOOK_NO_RETRY" });
  const h = await healthStats(db, TEST_PAGE_ID);
  assert.equal(h.recoverable_errors, 1);
  assert.equal(h.errors_total, 3);
  assert.equal(h.live_outcome_unknown, 1);
  assert.equal(await claimForRecovery(db, old.id, TEST_PAGE_ID), false);
  assert.equal(await claimForRecovery(db, amb.id, TEST_PAGE_ID), false);
  assert.equal(await claimForRecovery(db, ok.id, TEST_PAGE_ID), true);
});

/* ============================= claiming ============================= */

test("P8.2 claim: exactly one of two concurrent recoveries wins; the loser never calls Hermes", async () => {
  const db = createFakeD1();
  const { id } = seedComment(db, { status: "ERROR" });
  let hermesCalls = 0;
  const mock = installFetchMock((url) => { if (isGraph(url)) assert.fail("no Graph"); hermesCalls += 1; return hermesChat(OK); });
  let a, b;
  try {
    [a, b] = await Promise.all([recoverComment(id, { db, env: createEnv({ DB: db }), config: cfg() }), recoverComment(id, { db, env: createEnv({ DB: db }), config: cfg() })]);
  } finally {
    mock.restore();
  }
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["ALREADY_CLAIMED", "RECOVERED"]);
  assert.equal(hermesCalls, 1);
  assert.equal(db._query("SELECT COUNT(*) n FROM replies WHERE comment_id = ?", id)[0].n, 1);
});

test("P8.2 claim: a claimed-but-running comment reports ALREADY_CLAIMED to a second request", async () => {
  const db = createFakeD1();
  const { id } = seedComment(db, { status: "ERROR" });
  assert.equal(await claimForRecovery(db, id, TEST_PAGE_ID), true);
  assert.equal(await reasonOf(db, id), "ALREADY_CLAIMED");
  const mock = installFetchMock(() => assert.fail("no network"));
  try {
    const r = await recoverComment(id, { db, env: createEnv({ DB: db }), config: cfg() });
    assert.equal(r.status, "ALREADY_CLAIMED");
  } finally {
    mock.restore();
  }
});

/* ========================== resume + safety ========================== */

test("P8.2 resume: runs from the persisted row -- one Hermes call, same fbc:<comment_id> key, one reply", async () => {
  const db = createFakeD1();
  const { id, fid } = seedComment(db, { status: "ERROR" });
  const seen = [];
  const mock = installFetchMock((url, init) => { seen.push(init); return hermesChat(OK); });
  let r;
  try {
    r = await recoverComment(id, { db, env: createEnv({ DB: db }), config: cfg() });
  } finally {
    mock.restore();
  }
  assert.equal(r.status, "RECOVERED");
  assert.equal(r.outcome, "drafted");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["idempotency-key"], `fbc:${fid}`);
  const msg = JSON.parse(JSON.parse(seen[0].body).messages[1].content);
  assert.equal(msg.comment_text, "สนใจครับ");
  assert.ok(!JSON.stringify(msg).includes("http"), "no URL reaches the AI");
  assert.equal(db._query("SELECT COUNT(*) n FROM comments WHERE facebook_comment_id = ?", fid)[0].n, 1, "no second comment row");
  const reps = db._query("SELECT * FROM replies WHERE comment_id = ?", id);
  assert.equal(reps.length, 1);
  assert.equal(reps[0].mode, "DRY_RUN");
  assert.equal(await reasonOf(db, id), "EXISTING_REPLY", "not recoverable a second time");
});

test("P8.2 resume: mapping-only product resolution and one trusted link; unmapped gets none", async () => {
  const URL_A = "https://s.shopee.co.th/p82a";
  const db = createFakeD1({
    products: [{ id: 1, name: "หัวชาร์จ", keywords: "หัวชาร์จ", affiliate_url: URL_A }],
    mappings: [{ facebook_post_id: POST, product_id: 1 }],
  });
  const mapped = seedComment(db, { status: "ERROR", post: POST });
  const unmapped = seedComment(db, { status: "ERROR", post: "853313081388711_901" });
  const mock = installFetchMock(() => hermesChat(CTA));
  try {
    await recoverComment(mapped.id, { db, env: createEnv({ DB: db }), config: cfg() });
    await recoverComment(unmapped.id, { db, env: createEnv({ DB: db }), config: cfg() });
    // A second retry of the mapped comment is refused -> no duplicate link.
    const again = await recoverComment(mapped.id, { db, env: createEnv({ DB: db }), config: cfg() });
    assert.equal(again.status, "NOT_ELIGIBLE");
  } finally {
    mock.restore();
  }
  const m = db._query("SELECT * FROM replies WHERE comment_id = ?", mapped.id);
  assert.equal(m.length, 1);
  assert.equal(m[0].affiliate_url, URL_A);
  assert.equal(db._query("SELECT matched_product_id, product_source FROM comments WHERE id = ?", mapped.id)[0].product_source, "MAPPING");
  const u = db._query("SELECT * FROM replies WHERE comment_id = ?", unmapped.id);
  assert.equal(u[0]?.affiliate_url ?? null, null);
  assert.equal(db._query("SELECT product_source FROM comments WHERE id = ?", unmapped.id)[0].product_source, "NONE");
});

test("P8.2 safety: protected LIVE rows never reach Hermes or Graph", async () => {
  const db = createFakeD1();
  const protectedRows = [
    { mode: "LIVE", status: "GENERATED", error_message: "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT" },
    { mode: "LIVE", status: "GENERATED", error_message: "GRAPH_SEND_IN_PROGRESS" },
    { mode: "LIVE", status: "FAILED", error_message: "GRAPH_REJECTED_403" },
    { mode: "LIVE", status: "SENT", facebook_reply_id: "853313081388711_r" },
  ];
  const mock = installFetchMock(() => assert.fail("no network for protected rows"));
  try {
    for (const rep of protectedRows) {
      const { id } = seedComment(db, { status: "ERROR", replies: [rep] });
      const r = await recoverComment(id, { db, env: createEnv({ DB: db, ...LIVE }), config: cfg(LIVE) });
      assert.equal(r.status, "NOT_ELIGIBLE", JSON.stringify(rep));
    }
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 0);
});

test("P8.2 safety: the 24 h window keeps historical ERROR rows out and untouched", async () => {
  const db = createFakeD1();
  const hist = [];
  for (let i = 0; i < 22; i++) hist.push(seedComment(db, { status: "ERROR", ageSec: (30 + i) * 3600 }).id);
  const before = JSON.stringify(db._query("SELECT * FROM comments ORDER BY id"));
  const mock = installFetchMock(() => assert.fail("no network"));
  try {
    for (const id of hist) assert.equal((await recoverComment(id, { db, env: createEnv({ DB: db }), config: cfg() })).reason, "TOO_OLD");
  } finally {
    mock.restore();
  }
  assert.equal(JSON.stringify(db._query("SELECT * FROM comments ORDER BY id")), before, "no historical row changed");
  const h = await healthStats(db, TEST_PAGE_ID);
  assert.equal(h.errors_total, 22, "still visible in counts");
  assert.equal(h.recoverable_errors, 0);
});

/* ============================ B1 preserved ============================ */

async function recoverLive(db, graph, spec = {}) {
  const { id } = seedComment(db, { status: "ERROR", ...spec });
  const mock = installFetchMock((url, init) => (isGraph(url) ? graph(url, init, db) : hermesChat(OK)));
  try {
    const r = await recoverComment(id, { db, env: createEnv({ DB: db, ...LIVE }), config: cfg(LIVE) });
    return { id, r, mock };
  } finally {
    mock.restore();
  }
}
const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => { const e = new Error("a"); e.name = "AbortError"; rej(e); }));

test("P8.2/B1: recovery in LIVE -- marker before Graph, 2xx SENT, 4xx FAILED, ambiguous GENERATED, no retry", async () => {
  // marker before request + 2xx
  let db = createFakeD1();
  let atCall = null;
  let { id, mock } = await recoverLive(db, (u, i, d) => { atCall = d._query("SELECT status, error_message FROM replies")[0]; return jsonResponse({ id: "853313081388711_r82" }); });
  assert.deepEqual({ ...atCall }, { status: "GENERATED", error_message: "GRAPH_SEND_IN_PROGRESS" });
  assert.equal(mock.graphCalls().length, 1);
  assert.equal(db._query("SELECT status FROM replies WHERE comment_id=?", id)[0].status, "SENT");
  // non-JSON 2xx still SENT
  db = createFakeD1();
  ({ id } = await recoverLive(db, () => new Response("x", { status: 200 })));
  assert.equal(db._query("SELECT status, error_message FROM replies WHERE comment_id=?", id)[0].status, "SENT");
  // 4xx
  db = createFakeD1();
  ({ id, mock } = await recoverLive(db, () => jsonResponse({}, 400)));
  assert.equal(mock.graphCalls().length, 1);
  assert.equal(db._query("SELECT status, error_message FROM replies WHERE comment_id=?", id)[0].error_message, "GRAPH_REJECTED_400");
  // timeout / 5xx / network -> ambiguous, one call, and then protected from further recovery
  for (const g of [hang, () => new Response("", { status: 502 }), () => { throw new TypeError("net"); }]) {
    db = createFakeD1();
    ({ id, mock } = await recoverLive(db, g));
    assert.equal(mock.graphCalls().length, 1);
    const row = db._query("SELECT status, error_message FROM replies WHERE comment_id=?", id)[0];
    assert.equal(row.status, "GENERATED");
    assert.match(row.error_message, /^GRAPH_OUTCOME_UNKNOWN:/);
    assert.equal(await reasonOf(db, id), "PROTECTED_AMBIGUOUS_SEND");
  }
});

test("P8.2/B1: a SEND_BUDGET_EXHAUSTED comment recovers once and keeps its SKIPPED row as history", async () => {
  const db = createFakeD1();
  const { id, r, mock } = await recoverLive(db, () => jsonResponse({ id: "853313081388711_rb" }), {
    replies: [{ mode: "LIVE", status: "SKIPPED", error_message: "SEND_BUDGET_EXHAUSTED" }],
  });
  assert.equal(r.status, "RECOVERED");
  assert.equal(mock.graphCalls().length, 1);
  const rows = db._query("SELECT status, error_message FROM replies WHERE comment_id=? ORDER BY id", id);
  assert.deepEqual(rows.map((x) => x.status), ["SKIPPED", "SENT"]);
  assert.equal(await reasonOf(db, id), "ALREADY_SENT");
});

test("P8.2/B1: recovery keeps the Hermes budget inside the 27 s pipeline budget", async () => {
  const { hermesBudgetMs } = await import("../src/pipeline.js");
  const c = cfg();
  assert.equal(c.hermesTimeoutMs, 20000);
  assert.equal(c.graphTimeoutMs, 5000);
  assert.equal(hermesBudgetMs(c, 0, 0), 20000);
  assert.equal(hermesBudgetMs(c, 0, 10000), 11000);
});

/* ============================== admin API ============================== */

const W = "https://worker.example";
async function cookie() {
  const now = Math.floor(Date.now() / 1000);
  return cookieHeader(await makeSessionToken(TEST_SESSION_SECRET, { iat: now, exp: now + 3600 }));
}
function adminEnv(db, extra = {}) {
  return createEnv({ DB: db, ADMIN_PASSWORD: TEST_ADMIN_PASSWORD, ADMIN_SESSION_SECRET: TEST_SESSION_SECRET, ...extra });
}
async function call(db, method, path, { auth = true, origin = W, body = "{}", type = "application/json", env = {} } = {}) {
  const headers = {};
  if (auth) headers.cookie = await cookie();
  if (origin) headers.origin = origin;
  if (type) headers["content-type"] = type;
  const req = new Request(W + path, { method, headers, body: method === "GET" ? undefined : body });
  const res = await worker.fetch(req, adminEnv(db, env), createCtx());
  return { res, text: await res.text() };
}

test("P8.2 API: auth, CSRF, method and id validation; no mutation on rejection", async () => {
  const db = createFakeD1();
  const { id } = seedComment(db, { status: "ERROR" });
  const mock = installFetchMock(() => assert.fail("no network"));
  try {
    assert.equal((await call(db, "POST", `/admin/api/comments/${id}/retry`, { auth: false })).res.status, 401);
    assert.equal((await call(db, "GET", "/admin/api/health", { auth: false })).res.status, 401);
    assert.equal((await call(db, "GET", "/admin/api/recovery", { auth: false })).res.status, 401);
    assert.equal((await call(db, "POST", `/admin/api/comments/${id}/retry`, { origin: "https://evil.example" })).res.status, 403);
    assert.equal((await call(db, "POST", `/admin/api/comments/${id}/retry`, { origin: null })).res.status, 403);
    assert.equal((await call(db, "POST", `/admin/api/comments/${id}/retry`, { type: "text/plain" })).res.status, 403);
    assert.equal((await call(db, "GET", `/admin/api/comments/${id}/retry`)).res.status, 405);
    for (const bad of ["abc", "0", "-1", "1.5", "9999999999999"]) {
      assert.equal((await call(db, "POST", `/admin/api/comments/${bad}/retry`)).res.status, 400, bad);
    }
    assert.equal((await call(db, "POST", `/admin/api/comments/${id}/retry/x`)).res.status, 404);
    assert.equal((await call(db, "POST", `/admin/api/comments/999999/retry`)).res.status, 404);
  } finally {
    mock.restore();
  }
  assert.equal(db._query("SELECT status FROM comments WHERE id=?", id)[0].status, "ERROR", "untouched");
});

test("P8.2 API: retry responses are deterministic and carry no secrets or stack traces", async () => {
  const db = createFakeD1();
  const ok = seedComment(db, { status: "ERROR" });
  const amb = seedComment(db, { status: "ERROR", replies: [{ mode: "LIVE", status: "GENERATED", error_message: "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT" }] });
  const old = seedComment(db, { status: "ERROR", ageSec: 90000 });
  const recent = seedComment(db, { status: "RECEIVED", ageSec: 10 });
  const done = seedComment(db, { status: "PROCESSED", replies: [{ mode: "DRY_RUN", status: "GENERATED" }] });
  const mock = installFetchMock(() => hermesChat(OK));
  const out = {};
  try {
    for (const [k, c] of Object.entries({ ok, amb, old, recent, done })) {
      const { res, text } = await call(db, "POST", `/admin/api/comments/${c.id}/retry`);
      out[k] = { status: res.status, body: JSON.parse(text).data, text };
    }
  } finally {
    mock.restore();
  }
  assert.deepEqual([out.ok.status, out.ok.body.status, out.ok.body.outcome], [200, "RECOVERED", "drafted"]);
  assert.deepEqual([out.amb.status, out.amb.body.reason], [409, "PROTECTED_AMBIGUOUS_SEND"]);
  assert.deepEqual([out.old.status, out.old.body.reason], [409, "TOO_OLD"]);
  assert.deepEqual([out.recent.status, out.recent.body.reason], [409, "RECENT_RECEIVED"]);
  assert.deepEqual([out.done.status, out.done.body.reason], [409, "EXISTING_REPLY"]);
  for (const { text } of Object.values(out)) {
    for (const s of ["unit-test", "secret", "token", "stack", "Error:", "https://"]) assert.ok(!text.includes(s), `${s} leaked: ${text}`);
  }
});

test("P8.2 API: health and recovery list expose counts/ids only -- no text, URLs or secrets", async () => {
  const db = createFakeD1({ products: [{ id: 1, name: "x", affiliate_url: "https://s.shopee.co.th/p82z" }] });
  seedComment(db, { status: "ERROR" });
  seedComment(db, { status: "ERROR", replies: [{ mode: "LIVE", status: "FAILED", error_message: "GRAPH_REJECTED_403" }] });
  const h = await call(db, "GET", "/admin/api/health");
  const l = await call(db, "GET", "/admin/api/recovery");
  assert.equal(h.res.status, 200);
  assert.equal(l.res.status, 200);
  const hd = JSON.parse(h.text).data;
  for (const k of ["errors_1h", "errors_24h", "recoverable_errors", "recoverable_stale_received", "stale_received", "live_generated", "live_outcome_unknown", "live_send_in_progress", "live_failed_4xx", "live_sent", "dry_run_generated", "comments_total", "replies_total", "stale_received_oldest", "live_ambiguous_oldest", "live_failed_oldest"]) {
    assert.ok(k in hd, k);
  }
  assert.equal(hd.live_failed_4xx, 1);
  for (const t of [h.text, l.text]) {
    for (const s of ["https://", "unit-test", "สนใจครับ", "author-82", "secret", "token"]) assert.ok(!t.includes(s), `${s} leaked`);
  }
  // Viewing is read-only.
  assert.equal(db._query("SELECT COUNT(*) n FROM comments WHERE status='ERROR'")[0].n, 2);
});

test("P8.2 overview: LIVE and DRY_RUN GENERATED counts are separated", async () => {
  const db = createFakeD1();
  seedComment(db, { status: "PROCESSED", replies: [{ mode: "DRY_RUN", status: "GENERATED" }] });
  seedComment(db, { status: "ERROR", replies: [{ mode: "LIVE", status: "GENERATED", error_message: "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT" }] });
  const d = JSON.parse((await call(db, "GET", "/admin/api/overview")).text).data;
  assert.equal(d.replies_generated_dry_run, 1);
  assert.equal(d.replies_generated_live, 1);
});

/* ============================== dashboard ============================== */

test("P8.2 dashboard: Retry only for action RETRY; ambiguous rows show the warning and no button", () => {
  assert.ok(DASHBOARD_JS.includes('action === "RETRY"'), "Retry button is gated on action RETRY");
  assert.ok(DASHBOARD_JS.includes('action === "CHECK_FACEBOOK_NO_RETRY"'));
  assert.ok(DASHBOARD_JS.includes("ตรวจสอบโพสต์บน Facebook ก่อน — ห้าม Retry"));
  assert.ok(DASHBOARD_JS.includes("/admin/api/health"));
  assert.ok(DASHBOARD_JS.includes("/admin/api/recovery"));
  // The only mutation is the explicit Retry click (POST); nothing on load.
  const retryCalls = DASHBOARD_JS.match(/\/retry"/g) || [];
  assert.equal(retryCalls.length, 1);
  assert.ok(/onclick: async \(e\) => \{\s*e\.target\.disabled = true;[\s\S]{0,200}\/retry"/.test(DASHBOARD_JS), "retry only inside the click handler");
  assert.ok(DASHBOARD_JS.includes("replies_generated_dry_run") && DASHBOARD_JS.includes("replies_generated_live"));
});

test("P8.2: no scheduled/automatic recovery exists", async () => {
  const idx = await import("../src/index.js");
  assert.equal(typeof idx.default.scheduled, "undefined");
});
