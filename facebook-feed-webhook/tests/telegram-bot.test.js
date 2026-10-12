import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";
import { webhookSecret, handleCallback, notifyPendingSuggestions, suggestionKeyboard, TELEGRAM_WEBHOOK_PATH } from "../src/telegram-bot.js";
import { listAudit } from "../src/admin-db.js";
import { createFakeD1, createEnv, createCtx, TEST_PAGE_ID } from "./helpers.js";

const P = TEST_PAGE_ID;
const OWNER = "4242";
const SECRET = "unit-test-admin-session-secret";

/** Posts-edge candidate + PENDING suggestions, using the real tables. */
function seed() {
  const db = createFakeD1({
    products: [
      { id: 1, name: "หัวชาร์จเร็ว 20W", keywords: "หัวชาร์จ", affiliate_url: "https://s.shopee.co.th/a" },
      { id: 2, name: "สายชาร์จ USB-C", keywords: "สายชาร์จ", affiliate_url: "https://s.shopee.co.th/b" },
      { id: 3, name: "สินค้าปิด", affiliate_url: "https://s.shopee.co.th/c", active: 0 },
    ],
  });
  const cand = db._sqlite.prepare(`INSERT INTO post_candidates (page_id, post_id, content_type, message, permalink, content_hash, discovery_source) VALUES (?, ?, 'POST', ?, ?, 'h', 'posts')`);
  const sug = db._sqlite.prepare(`INSERT INTO product_suggestions (page_id, subject_key, representative_post_id, product_id, rank, confidence, prefilter_score, source, reason, prompt_version, content_hash, status)
    VALUES (?, ?, ?, ?, 1, 'HIGH', 10, 'AI', 'ตรงกับชื่อสินค้า', 'v', ?, 'PENDING')`);
  return { db, cand, sug };
}
async function hashOf(text) {
  const { sha256Hex } = await import("../src/discovery.js");
  return sha256Hex(text);
}

test("U12 approve needs two taps; second tap runs the AM-2.4 approval and audits", async () => {
  const { db, cand, sug } = seed();
  cand.run(P, `${P}_10`, "หัวชาร์จเร็ว 20W ชาร์จไว", "https://www.facebook.com/x/posts/10");
  sug.run(P, `p:${P}_10`, `${P}_10`, 1, await hashOf("หัวชาร์จเร็ว 20W ชาร์จไว"));
  const ask = await handleCallback(db, P, "a:1");
  assert.match(ask.text, /ยืนยันผูก “หัวชาร์จเร็ว 20W”/);
  assert.deepEqual(ask.keyboard.inline_keyboard[0].map((b) => b.callback_data), ["A:1", "v:1"]);
  assert.equal(db._state.mappings.length, 0, "first tap changes nothing");
  const done = await handleCallback(db, P, "A:1");
  assert.equal(done.toast, "ผูกสินค้าแล้ว");
  assert.equal(done.keyboard, null, "buttons removed after the decision");
  assert.equal(db._state.mappings.length, 1);
  assert.equal(db._state.mappings[0].product_id, 1);
  assert.equal(db._state.mappings[0].facebook_post_id, `${P}_10`);
  const again = await handleCallback(db, P, "A:1");
  assert.equal(again.toast, "คำแนะนำนี้ถูกตัดสินไปแล้ว", "a repeat tap never creates a second mapping");
  assert.equal(db._state.mappings.length, 1);
  const audit = (await listAudit(db, P)).rows;
  assert.equal(audit[0].action, "SUGGESTION_APPROVE");
  assert.equal(audit[0].after.via, "telegram");
});

test("U12 choose another product: list -> confirm -> create-only mapping; AI suggestion rejected", async () => {
  const { db, cand, sug } = seed();
  cand.run(P, `${P}_11`, "สายชาร์จ USB-C ยาว 2 เมตร", null);
  sug.run(P, `p:${P}_11`, `${P}_11`, 1, await hashOf("สายชาร์จ USB-C ยาว 2 เมตร"));
  const list = await handleCallback(db, P, "o:1");
  const datas = list.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.equal(datas[0], "p:1:2", "prefilter match first");
  assert.ok(!datas.includes("p:1:3"), "inactive products are never offered");
  const confirm = await handleCallback(db, P, "p:1:2");
  assert.match(confirm.text, /ยืนยันผูก “สายชาร์จ USB-C”/);
  assert.equal(db._state.mappings.length, 0);
  const done = await handleCallback(db, P, "P:1:2");
  assert.equal(done.toast, "ผูกสินค้าแล้ว");
  assert.equal(db._state.mappings[0].product_id, 2);
  assert.match(db._state.mappings[0].note, /จาก Telegram/);
  assert.equal(db._query("SELECT status FROM product_suggestions WHERE id = 1")[0].status, "REJECTED");
  assert.deepEqual((await listAudit(db, P)).rows.map((r) => r.action).sort(), ["MAPPING_CREATE", "SUGGESTION_REJECT"]);
});

test("U12 guards: existing mapping, inactive product, unknown ids and malformed data change nothing", async () => {
  const { db, cand, sug } = seed();
  cand.run(P, `${P}_12`, "x", null);
  sug.run(P, `p:${P}_12`, `${P}_12`, null, await hashOf("x"));
  db._sqlite.prepare("INSERT INTO content_mappings (facebook_page_id, facebook_post_id, product_id, active) VALUES (?, ?, 1, 0)").run(P, `${P}_12`);
  const r = await handleCallback(db, P, "P:1:2");
  assert.equal(r.toast, "โพสต์/Reel นี้ผูกสินค้าไว้แล้ว", "even an inactive mapping blocks (AM-2.5 create-only)");
  assert.equal((await handleCallback(db, P, "P:1:3")).toast, "สินค้าถูกปิดหรือลบแล้ว");
  assert.equal((await handleCallback(db, P, "A:999")).toast, "ไม่พบคำแนะนำนี้");
  for (const bad of ["x", "A:1;DROP", "A:", "Z:1", "A:1:2:3", ""]) assert.equal((await handleCallback(db, P, bad)).toast, "คำสั่งไม่ถูกต้อง", bad);
  assert.equal(db._state.mappings.length, 1);
  assert.equal(db._state.mappings[0].product_id, 1);
  assert.equal(db._query("SELECT status FROM product_suggestions WHERE id = 1")[0].status, "PENDING");
});

test("U12 no-match suggestion: no approve button, only choose / skip", () => {
  const kb = suggestionKeyboard({ id: 7, product_id: null, mappable: false, representative_post_id: `${P}_1` });
  assert.deepEqual(kb.inline_keyboard.flat().map((b) => b.callback_data), ["o:7", "r:7"]);
  const bare = suggestionKeyboard({ id: 8, product_id: 1, mappable: false, representative_post_id: "998877" });
  assert.deepEqual(bare.inline_keyboard.flat().map((b) => b.callback_data), ["r:8"], "a bare Reel id is never mappable");
});

function stubFetch() {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); };
  f.calls = calls;
  return f;
}
const env = (db, over = {}) => createEnv({ DB: db, ADMIN_PASSWORD: "pw", ADMIN_SESSION_SECRET: SECRET, TELEGRAM_BOT_TOKEN: "1:BOT", TELEGRAM_CHAT_ID: OWNER, ...over });

async function hook(db, update, secretHeader) {
  const headers = { "content-type": "application/json" };
  if (secretHeader !== null) headers["x-telegram-bot-api-secret-token"] = secretHeader ?? (await webhookSecret(env(db)));
  return worker.fetch(new Request("https://worker.example" + TELEGRAM_WEBHOOK_PATH, { method: "POST", headers, body: JSON.stringify(update) }), env(db), createCtx());
}

test("U12 webhook: wrong/missing secret is 401; a non-owner tap does nothing; the owner's tap acts", async () => {
  const { db, cand, sug } = seed();
  cand.run(P, `${P}_10`, "หัวชาร์จเร็ว 20W", null);
  sug.run(P, `p:${P}_10`, `${P}_10`, 1, await hashOf("หัวชาร์จเร็ว 20W"));
  const realFetch = globalThis.fetch;
  const f = stubFetch();
  globalThis.fetch = f;
  try {
    const tap = (from, data) => ({ update_id: 1, callback_query: { id: "cb", from: { id: from }, data, message: { message_id: 5, chat: { id: from } } } });
    assert.equal((await hook(db, tap(OWNER, "A:1"), null)).status, 401);
    assert.equal((await hook(db, tap(OWNER, "A:1"), "wrong")).status, 401);
    assert.equal(db._state.mappings.length, 0);
    const stranger = await hook(db, tap("999", "A:1"));
    assert.equal(stranger.status, 200);
    assert.equal(db._state.mappings.length, 0, "only TELEGRAM_CHAT_ID may act");
    assert.equal(f.calls.at(-1).body.text, "ไม่มีสิทธิ์");
    const ok = await hook(db, tap(OWNER, "A:1"));
    assert.equal(ok.status, 200);
    assert.equal(db._state.mappings.length, 1);
    assert.ok(f.calls.some((c) => c.url.endsWith("/editMessageText") && c.body.message_id === 5));
    // /pending from the owner sends the list (none pending now)
    await hook(db, { update_id: 2, message: { from: { id: OWNER }, chat: { id: OWNER }, text: "/pending" } });
    assert.equal(f.calls.at(-1).body.text, "ไม่มีคำแนะนำที่รออนุมัติ");
    assert.ok(f.calls.every((c) => c.url.startsWith("https://api.telegram.org/bot1:BOT/")), "only Telegram is called");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("U12 notify: sends each pending suggestion once with buttons; plain text; no secrets", async () => {
  const { db, cand, sug } = seed();
  for (let i = 0; i < 3; i += 1) { cand.run(P, `${P}_2${i}`, "โพสต์ " + i, null); sug.run(P, `p:${P}_2${i}`, `${P}_2${i}`, 1, await hashOf("โพสต์ " + i)); }
  const f = stubFetch();
  const r = await notifyPendingSuggestions(env(db), { fetchImpl: f });
  assert.equal(r.sent, 3);
  assert.ok(f.calls.every((c) => c.body.reply_markup && !c.body.parse_mode));
  assert.ok(f.calls.every((c) => !JSON.stringify(c.body).includes(SECRET)));
  const again = await notifyPendingSuggestions(env(db), { fetchImpl: stubFetch() });
  assert.equal(again.sent, 0, "already sent -> not repeated");
  const forced = await notifyPendingSuggestions(env(db), { onlyNew: false, fetchImpl: stubFetch() });
  assert.equal(forced.sent, 3, "/pending re-sends");
});

test("U12 admin API + dashboard wiring", async () => {
  const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  assert.match(app, /function telegramMapCard\(/);
  assert.match(app, /"\/admin\/api\/telegram\/setup"/);
  const adminSrc = readFileSync(new URL("../src/admin.js", import.meta.url), "utf8");
  const routeAt = adminSrc.indexOf("path === TELEGRAM_WEBHOOK_PATH");
  assert.ok(routeAt > 0 && routeAt < adminSrc.indexOf("isAuthenticated(request, env)", routeAt), "webhook routed before the session check");
  assert.ok((await webhookSecret({ ADMIN_SESSION_SECRET: "s" })).match(/^[0-9a-f]{48}$/));
  assert.equal(await webhookSecret({}), null);
});
