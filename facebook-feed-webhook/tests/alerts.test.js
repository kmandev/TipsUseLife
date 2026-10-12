import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";
import { issueSession } from "../src/admin.js";
import { runAlertCheck, evaluateAlerts, formatAlertMessage, checkPageToken, readAlertState, ALERT_STATE_KEY, TOKEN_CHECK_INTERVAL_MS } from "../src/alerts.js";
import { createFakeD1, createEnv, createCtx, TEST_PAGE_ID } from "./helpers.js";

const BOT = "123456:TEST-BOT-TOKEN-never-logged";
const PAGE_TOKEN = "EAAtest-page-token-never-logged";
const T0 = new Date("2026-10-12T05:00:00Z");
const at = (min) => new Date(T0.getTime() + min * 60000);

const baseHealth = { errors_total: 0, live_outcome_unknown: 1, live_failed_total: 0, stale_received: 0, live_send_in_progress: 0 };

/** fetch stub: Graph /me answers `me`, Telegram answers `tg`. Records every call. */
function stubFetch({ me = { status: 200, body: { id: TEST_PAGE_ID } }, tg = { status: 200, body: { ok: true } } } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = String(url).includes("api.telegram.org") ? tg : me;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  fn.telegram = () => calls.filter((c) => c.url.includes("api.telegram.org"));
  fn.graph = () => calls.filter((c) => c.url.includes("graph.facebook.com"));
  return fn;
}

function envWith(db, over = {}) {
  return createEnv({ DB: db, PAGE_ACCESS_TOKEN: PAGE_TOKEN, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: "42", DASHBOARD_URL: "https://worker.example", ...over });
}

const run = (env, health, fetchImpl, now, extra = {}) => runAlertCheck(env, { now, fetchImpl, healthStats: async () => health, ...extra });

test("U1 first check only records a baseline (a protected ambiguous row never alerts)", async () => {
  const db = createFakeD1();
  const f = stubFetch();
  const r = await run(envWith(db), { ...baseHealth, errors_total: 5 }, f, T0);
  assert.equal(r.first, true);
  assert.equal(r.alerts, 0);
  assert.equal(f.telegram().length, 0, "nothing sent on the baseline run");
  const st = await readAlertState(db);
  assert.equal(st.counters.live_outcome_unknown, 1);
  assert.equal(st.counters.errors_total, 5);
  assert.equal(st.token_status, "OK");
});

test("U1 a NEW incident sends exactly one Telegram message; no change sends nothing", async () => {
  const db = createFakeD1();
  const env = envWith(db);
  await run(env, baseHealth, stubFetch(), T0);
  const f = stubFetch();
  const r = await run(env, { ...baseHealth, errors_total: 2, live_outcome_unknown: 2 }, f, at(5));
  assert.equal(r.alerts, 2);
  assert.equal(r.sent, true);
  assert.equal(f.telegram().length, 1);
  const body = JSON.parse(f.telegram()[0].init.body);
  assert.equal(body.chat_id, "42");
  assert.match(body.text, /คอมเมนต์สถานะ ERROR ใหม่ 2 รายการ/);
  assert.match(body.text, /ผลการส่ง LIVE ไม่แน่นอนเพิ่ม 1 รายการ/);
  assert.match(body.text, /https:\/\/worker\.example\/admin\/#overview/);
  assert.ok(!body.text.includes(BOT) && !body.text.includes(PAGE_TOKEN), "no secret in the message");
  assert.equal(f.telegram()[0].init.method, "POST");

  const again = stubFetch();
  const r2 = await run(env, { ...baseHealth, errors_total: 2, live_outcome_unknown: 2 }, again, at(10));
  assert.equal(r2.alerts, 0);
  assert.equal(again.telegram().length, 0, "same numbers -> silence");
  assert.equal(again.graph().length, 0, "token is checked at most hourly");
});

test("U1 a counter that went down and up again re-alerts (baseline follows the current value)", async () => {
  const db = createFakeD1();
  const env = envWith(db);
  await run(env, { ...baseHealth, errors_total: 3 }, stubFetch(), T0);
  await run(env, { ...baseHealth, errors_total: 1 }, stubFetch(), at(5)); // recovered by operator
  const f = stubFetch();
  const r = await run(env, { ...baseHealth, errors_total: 2 }, f, at(10));
  assert.equal(r.alerts, 1);
  assert.equal(f.telegram().length, 1);
});

test("U1 Telegram not configured: nothing is sent, the baseline still moves (no flood later)", async () => {
  const db = createFakeD1();
  const env = envWith(db, { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined });
  await run(env, baseHealth, stubFetch(), T0);
  const f = stubFetch();
  const r = await run(env, { ...baseHealth, errors_total: 4 }, f, at(5));
  assert.equal(r.sent, false);
  assert.equal(r.send_error, "NOT_CONFIGURED");
  assert.equal(f.telegram().length, 0);
  assert.equal((await readAlertState(db)).counters.errors_total, 4);
});

test("U1 a failed Telegram send keeps the old baseline, so the next check alerts again (no retry inside a run)", async () => {
  const db = createFakeD1();
  const env = envWith(db);
  await run(env, baseHealth, stubFetch(), T0);
  const bad = stubFetch({ tg: { status: 500, body: {} } });
  const r = await run(env, { ...baseHealth, errors_total: 1 }, bad, at(5));
  assert.equal(r.sent, false);
  assert.equal(bad.telegram().length, 1, "exactly one attempt");
  const st = await readAlertState(db);
  assert.equal(st.counters.errors_total, 0, "baseline not advanced");
  assert.equal(st.last_error, "TELEGRAM_HTTP_500");
  const ok = stubFetch();
  const r2 = await run(env, { ...baseHealth, errors_total: 1 }, ok, at(10));
  assert.equal(r2.sent, true);
  assert.equal(ok.telegram().length, 1);
});

test("U1 token: invalid alerts once, repeats stay silent, recovery is announced once", async () => {
  const db = createFakeD1();
  const env = envWith(db);
  await run(env, baseHealth, stubFetch(), T0);
  const invalid = stubFetch({ me: { status: 400, body: { error: { code: 190, message: "Error validating access token: secret details" } } } });
  const r = await run(env, baseHealth, invalid, at(61));
  assert.equal(r.token_status, "INVALID");
  assert.equal(invalid.graph().length, 1);
  assert.equal(invalid.graph()[0].init.method, "GET", "the token check is a GET");
  assert.match(JSON.parse(invalid.telegram()[0].init.body).text, /หมดอายุหรือถูกยกเลิก/);
  assert.doesNotMatch(JSON.parse(invalid.telegram()[0].init.body).text, /secret details/, "Graph error text is never forwarded");

  const still = stubFetch({ me: { status: 400, body: { error: { code: 190 } } } });
  await run(env, baseHealth, still, at(122));
  assert.equal(still.telegram().length, 0, "still invalid -> silence");

  const fixed = stubFetch();
  const r3 = await run(env, baseHealth, fixed, at(183));
  assert.equal(r3.token_status, "OK");
  assert.match(JSON.parse(fixed.telegram()[0].init.body).text, /กลับมาปกติ[\s\S]*token ใช้งานได้ตามปกติแล้ว/);
});

test("U1 token: transient Graph failures keep the previous verdict; missing token / wrong page are reported", async () => {
  const db = createFakeD1();
  const env = envWith(db);
  await run(env, baseHealth, stubFetch(), T0);
  const flaky = stubFetch({ me: { status: 503, body: {} } });
  const r = await run(env, baseHealth, flaky, at(61));
  assert.equal(r.token_status, "OK");
  assert.equal(flaky.telegram().length, 0);

  const cfg = { graphApiVersion: "v21.0", pageId: TEST_PAGE_ID };
  assert.equal((await checkPageToken({}, cfg, stubFetch())).status, "MISSING");
  assert.equal((await checkPageToken({ PAGE_ACCESS_TOKEN: "x" }, cfg, stubFetch({ me: { status: 200, body: { id: "999" } } }))).status, "PAGE_MISMATCH");
  assert.equal((await checkPageToken({ PAGE_ACCESS_TOKEN: "x" }, cfg, stubFetch({ me: new Error("down") }))).status, "UNKNOWN");
  const f = stubFetch();
  await checkPageToken({ PAGE_ACCESS_TOKEN: "x" }, cfg, f);
  assert.equal(f.calls[0].url, "https://graph.facebook.com/v21.0/me?fields=id", "token goes in the header, not the URL");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer x");
});

test("U1 LIVE 'sending' must persist on two consecutive checks before it alerts", () => {
  const nowIso = T0.toISOString();
  const first = evaluateAlerts(null, baseHealth, null, nowIso).next;
  const one = evaluateAlerts(first, { ...baseHealth, live_send_in_progress: 1 }, null, nowIso);
  assert.equal(one.lines.length, 0, "a send in flight is normal");
  const two = evaluateAlerts(one.next, { ...baseHealth, live_send_in_progress: 1 }, null, nowIso);
  assert.equal(two.lines.length, 1);
  assert.match(two.lines[0], /ค้างสถานะ "กำลังส่ง"/);
  const three = evaluateAlerts(two.next, { ...baseHealth, live_send_in_progress: 1 }, null, nowIso);
  assert.equal(three.lines.length, 0, "no repeat while still stuck");
  const done = evaluateAlerts(three.next, baseHealth, null, nowIso);
  assert.equal(done.recovered.length, 1);
  assert.match(formatAlertMessage(done, null), /กลับมาปกติ/);
});

test("U1 the cron handler only schedules the alert check (no reply / retry / D1 change outside settings)", async () => {
  const db = createFakeD1();
  const waits = [];
  const realFetch = globalThis.fetch;
  const f = stubFetch();
  globalThis.fetch = f;
  try {
    await worker.scheduled({ scheduledTime: T0.getTime(), cron: "*/5 * * * *" }, envWith(db), { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(waits.length, 1);
  assert.ok(f.calls.every((c) => c.url.includes("graph.facebook.com/v21.0/me") || c.url.includes("api.telegram.org")), "only the token GET and Telegram");
  assert.ok(f.graph().every((c) => c.init.method === "GET"));
  const writes = db._statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));
  assert.ok(writes.length >= 1 && writes.every((s) => /INSERT INTO settings/.test(s)), "the only write is the alert state in settings");
  assert.ok(db._query("SELECT value FROM settings WHERE key = ?", ALERT_STATE_KEY).length === 1);
});

test("U1 wrangler.jsonc: one 5-minute cron, dashboard URL var, no secret values", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(raw, /"crons": \["\*\/5 \* \* \* \*"\]/);
  assert.match(raw, /"DASHBOARD_URL": "https:\/\/facebook-feed-webhook\.farkram\.workers\.dev"/);
  assert.match(raw, /"REPLY_MODE": "LIVE"/, "LIVE unchanged");
  assert.doesNotMatch(raw, /TELEGRAM_BOT_TOKEN"\s*:/, "bot token is a secret, never a var");
  assert.ok(TOKEN_CHECK_INTERVAL_MS >= 60 * 60 * 1000);
});

/* ------------------------------ admin API ------------------------------ */

const SECRET = "unit-test-admin-session-secret";
const ORIGIN = "https://worker.example";
async function req(env, method, path, body) {
  const headers = { cookie: `admin_session=${await issueSession(SECRET)}`, origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, createCtx());
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

test("U1 admin: status is secret-free; test needs config; check runs the same read-only check", async () => {
  const db = createFakeD1();
  const base = { ADMIN_PASSWORD: "pw", ADMIN_SESSION_SECRET: SECRET };
  const off = envWith(db, { ...base, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined });
  const s = await req(off, "GET", "/admin/api/alerts");
  assert.equal(s.status, 200);
  assert.equal(s.json.data.telegram_configured, false);
  assert.equal((await req(off, "POST", "/admin/api/alerts/test", {})).status, 503);

  const realFetch = globalThis.fetch;
  const f = stubFetch();
  globalThis.fetch = f;
  try {
    const on = envWith(db, base);
    const t = await req(on, "POST", "/admin/api/alerts/test", {});
    assert.equal(t.status, 200);
    assert.equal(f.telegram().length, 1);
    const c = await req(on, "POST", "/admin/api/alerts/check", {});
    assert.equal(c.status, 200);
    assert.equal(c.json.data.ok, true);
    const st = await req(on, "GET", "/admin/api/alerts");
    assert.equal(st.json.data.state.token_status, "OK");
    assert.ok(!JSON.stringify(st.json).includes(BOT) && !JSON.stringify(st.json).includes(PAGE_TOKEN));
    const settings = await req(on, "GET", "/admin/api/settings");
    assert.equal(settings.json.data.secrets_present.TELEGRAM_BOT_TOKEN, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal((await req(envWith(db, base), "GET", "/admin/api/alerts/test")).status, 405);
});

test("U1 dashboard: settings shows the alert card with test/check buttons; text only", () => {
  const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  assert.match(app, /function alertsCard\(/);
  assert.match(app, /"\/admin\/api\/alerts\/check"/);
  assert.match(app, /"\/admin\/api\/alerts\/test"/);
  assert.match(app, /alertsCard\(alerts\.data \|\| \{\}, \(\) => viewSettings\(main\)\)/);
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});
