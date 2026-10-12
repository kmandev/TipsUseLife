import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";
import { runDailyJobs, readDailyState, DAILY_MIN_INTERVAL_MS } from "../src/daily-jobs.js";
import { DAILY_CRON, runScheduled } from "../src/scheduled.js";
import { createFakeD1, createEnv, TEST_PAGE_ID } from "./helpers.js";

const T0 = new Date("2026-10-12T23:17:00Z");
const okDiscover = (inserted = 2, updated = 1) => async () => ({ ok: true, summary: { status: "OK", inserted, updated, error_code: null } });
const okSuggest = (suggested = 1) => async () => ({ ok: true, summary: { status: "OK", suggested, no_match: 0, error_code: null } });
function tg() {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); };
  f.calls = calls;
  return f;
}
const env = (db, over = {}) => createEnv({ DB: db, TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "42", DASHBOARD_URL: "https://worker.example", ...over });

function seedPending(db, n) {
  db._sqlite.prepare("INSERT INTO products (id, name, affiliate_url, active) VALUES (1, 'A', 'https://s.shopee.co.th/a', 1)").run();
  for (let i = 0; i < n; i += 1) {
    db._sqlite.prepare(`INSERT INTO product_suggestions (page_id, subject_key, representative_post_id, product_id, rank, confidence, prefilter_score, source, reason, prompt_version, content_hash, status)
      VALUES (?, ?, ?, 1, 1, 'HIGH', 10, 'AI', 'r', 'v', ?, 'PENDING')`).run(TEST_PAGE_ID, "p:" + i, TEST_PAGE_ID + "_" + i, "h" + i);
  }
}

test("U7 daily run: discovery then suggestions, one Telegram summary pointing at the review page", async () => {
  const db = createFakeD1();
  seedPending(db, 3);
  const order = [];
  const f = tg();
  const r = await runDailyJobs(env(db), { now: T0, fetchImpl: f,
    discover: async (a) => { order.push("discover"); assert.equal(a.config.pageId, TEST_PAGE_ID); return okDiscover()(); },
    suggest: async () => { order.push("suggest"); return okSuggest()(); } });
  assert.deepEqual(order, ["discover", "suggest"]);
  assert.equal(r.pending, 3);
  assert.equal(f.calls.length, 1);
  const text = f.calls[0].body.text;
  assert.match(text, /ค้นพบโพสต์\/Reel ใหม่ 2 รายการ · ข้อความถูกแก้ไข 1/);
  assert.match(text, /AI แนะนำสินค้าใหม่ 1 รายการ/);
  assert.match(text, /รอคุณตรวจและอนุมัติ 3 รายการ \(ระบบไม่ผูกสินค้าเอง\)/);
  assert.match(text, /https:\/\/worker\.example\/admin\/#suggestions/);
  const st = await readDailyState(db);
  assert.equal(st.discovery.inserted, 2);
  assert.equal(st.notified, true);
});

test("U7 nothing new -> no message; a second fire within 20 h is a no-op; force runs again", async () => {
  const db = createFakeD1();
  const f = tg();
  let runs = 0;
  const opts = { fetchImpl: f, discover: async () => { runs += 1; return okDiscover(0, 0)(); }, suggest: okSuggest(0) };
  await runDailyJobs(env(db), { now: T0, ...opts });
  assert.equal(f.calls.length, 0, "quiet day -> silence");
  const again = await runDailyJobs(env(db), { now: new Date(T0.getTime() + 60000), ...opts });
  assert.equal(again.skipped, "RECENT_RUN");
  assert.equal(runs, 1);
  await runDailyJobs(env(db), { now: new Date(T0.getTime() + 120000), force: true, ...opts });
  assert.equal(runs, 2);
  assert.ok(DAILY_MIN_INTERVAL_MS >= 20 * 3600e3);
});

test("U7 switches: AUTO_DISCOVERY / AUTO_SUGGESTIONS = 0 skip that step", async () => {
  const db = createFakeD1();
  let d = 0; let s = 0;
  await runDailyJobs(env(db, { AUTO_DISCOVERY: "0", AUTO_SUGGESTIONS: "0" }), { now: T0, fetchImpl: tg(), discover: async () => { d += 1; return okDiscover()(); }, suggest: async () => { s += 1; return okSuggest()(); } });
  assert.equal(d + s, 0);
  const st = await readDailyState(db);
  assert.equal(st.discovery, null); assert.equal(st.suggestions, null);
});

test("U7 failures are reported, never thrown; a busy step is skipped quietly", async () => {
  const db = createFakeD1();
  const f = tg();
  const r = await runDailyJobs(env(db), { now: T0, fetchImpl: f, discover: async () => { throw new Error("boom"); }, suggest: async () => ({ ok: false, code: "ALREADY_RUNNING" }) });
  assert.equal(r.ok, true);
  assert.equal(r.discovery.status, "FAILED");
  assert.equal(r.suggestions.status, "NOT_RUN");
  assert.match(f.calls[0].body.text, /การค้นหาโพสต์: FAILED \(UNHANDLED_EXCEPTION\)/);
  assert.doesNotMatch(f.calls[0].body.text, /boom/, "exception text never forwarded");
});

test("U7 cron dispatch: the daily cron runs the daily job, the 5-minute cron the alert check", async () => {
  const db = createFakeD1();
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return new Response(JSON.stringify({ id: TEST_PAGE_ID, data: [] }), { status: 200, headers: { "content-type": "application/json" } }); };
  try {
    await runScheduled({ cron: "*/5 * * * *", scheduledTime: T0.getTime() }, env(db, { PAGE_ACCESS_TOKEN: "t" }));
    assert.ok(await db._query("SELECT 1 FROM settings WHERE key = 'alert_state_v1'").length === 1);
    assert.equal(await readDailyState(db), null, "alert cron does not run the daily job");
    const waits = [];
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: T0.getTime() }, env(db, { PAGE_ACCESS_TOKEN: "t", AUTO_SUGGESTIONS: "0" }), { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.ok(await readDailyState(db), "daily cron ran the daily job");
    assert.ok(urls.every((u) => u.startsWith("https://graph.facebook.com/") || u.startsWith("https://api.telegram.org/")));
  } finally {
    globalThis.fetch = realFetch;
  }
  const writes = db._statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));
  assert.ok(writes.every((s) => !/content_mappings|replies|comments/i.test(s.split("\n")[0] + s)), "never writes mappings, replies or comments");
});

test("U7 wiring: wrangler cron + switches, dashboard card, docs", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(raw.includes(`"${DAILY_CRON}"`));
  assert.match(raw, /"AUTO_DISCOVERY": "1"/);
  assert.match(raw, /"AUTO_SUGGESTIONS": "1"/);
  const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  assert.match(app, /function dailyCard\(/);
  const runAt = app.indexOf('"/admin/api/daily/run"');
  const confirmAt = app.lastIndexOf("window.confirm(", runAt);
  assert.ok(confirmAt > app.indexOf("function dailyCard(") && confirmAt < runAt, "manual run asks first");
});
