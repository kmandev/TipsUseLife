import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { autoMapHighConfidence, isAutoMappable, AUTO_MAP_MIN_PREFILTER } from "../src/auto-map.js";
import { handleCallback } from "../src/telegram-bot.js";
import { sha256Hex } from "../src/discovery.js";
import { listAudit } from "../src/admin-db.js";
import { createFakeD1, createEnv, TEST_PAGE_ID } from "./helpers.js";

const P = TEST_PAGE_ID;
function seed() {
  const db = createFakeD1({ products: [
    { id: 1, name: "หัวชาร์จเร็ว 20W", affiliate_url: "https://s.shopee.co.th/a" },
    { id: 2, name: "ปิดแล้ว", affiliate_url: "https://s.shopee.co.th/b", active: 0 },
  ] });
  const add = async (n, product, confidence, score, opts = {}) => {
    const post = opts.post ?? `${P}_${n}`;
    const text = "โพสต์ " + n;
    db._sqlite.prepare(`INSERT INTO post_candidates (page_id, post_id, content_type, message, content_hash, discovery_source) VALUES (?, ?, 'POST', ?, 'h', ?)`).run(P, post, text, opts.source ?? "posts");
    db._sqlite.prepare(`INSERT INTO product_suggestions (page_id, subject_key, representative_post_id, product_id, rank, confidence, prefilter_score, source, reason, prompt_version, content_hash, status)
      VALUES (?, ?, ?, ?, 1, ?, ?, 'AI', 'r', 'v', ?, 'PENDING')`).run(P, `p:${post}`, post, product, confidence, score, await sha256Hex(text));
  };
  return { db, add };
}
const tg = () => { const calls = []; const f = async (u, i) => { calls.push({ url: String(u), body: JSON.parse(i.body) }); return new Response('{"ok":true}', { status: 200 }); }; f.calls = calls; return f; };
const env = (db, over = {}) => createEnv({ DB: db, TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "42", ...over });

test("U13 only HIGH + prefilter >= 5 + active product + posts-edge id are auto-mapped", async () => {
  const { db, add } = seed();
  await add(1, 1, "HIGH", 10);              // yes
  await add(2, 1, "MEDIUM", 10);            // no: MEDIUM
  await add(3, 1, "HIGH", 2);               // no: weak prefilter (keyword only)
  await add(4, 2, "HIGH", 10);              // no: product inactive
  await add(5, null, "LOW", 0);             // no: no product
  await add(6, 1, "HIGH", 10, { post: "998877", source: "reels" }); // no: bare reel id
  const f = tg();
  const r = await autoMapHighConfidence(env(db), { fetchImpl: f });
  assert.equal(r.mapped, 1);
  assert.equal(db._state.mappings.length, 1);
  assert.equal(db._state.mappings[0].facebook_post_id, `${P}_1`);
  assert.equal(db._state.mappings[0].active, 1);
  const st = db._query("SELECT id, status FROM product_suggestions ORDER BY id");
  assert.deepEqual(st.map((x) => x.status), ["APPROVED", "PENDING", "PENDING", "PENDING", "PENDING", "PENDING"]);
  assert.equal(f.calls.length, 1, "one Telegram notice per auto-mapping");
  assert.match(f.calls[0].body.text, /ผูกสินค้าอัตโนมัติแล้ว/);
  assert.equal(f.calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, "u:1");
  const a = (await listAudit(db, P)).rows[0];
  assert.equal(a.action, "SUGGESTION_APPROVE"); assert.equal(a.after.via, "auto");
  assert.equal(AUTO_MAP_MIN_PREFILTER, 5);
});

test("U13 respects existing mappings (AM-2.4 guard), the per-run cap and the off switch", async () => {
  const { db, add } = seed();
  for (let i = 1; i <= 7; i += 1) await add(i, 1, "HIGH", 10);
  db._sqlite.prepare("INSERT INTO content_mappings (facebook_page_id, facebook_post_id, product_id, active) VALUES (?, ?, 1, 0)").run(P, `${P}_1`);
  assert.equal((await autoMapHighConfidence(env(db, { AUTO_MAP_HIGH: "0" }), { fetchImpl: tg() })).mapped, 0, "off");
  assert.equal(db._state.mappings.length, 1);
  const r = await autoMapHighConfidence(env(db), { fetchImpl: tg() });
  assert.equal(r.mapped, 4, "5 attempts (cap), #1 blocked by its existing (inactive) mapping");
  assert.equal(r.failed[0].code, "MAPPING_EXISTS");
  assert.equal(db._state.mappings.filter((m) => m.facebook_post_id === `${P}_1`).length, 1, "never overwritten");
  assert.equal(db._state.mappings.find((m) => m.facebook_post_id === `${P}_1`).active, 0, "never re-activated");
});

test("U13 undo from Telegram: two taps deactivate the auto-mapping and audit it", async () => {
  const { db, add } = seed();
  await add(1, 1, "HIGH", 10);
  await autoMapHighConfidence(env(db), { fetchImpl: tg() });
  const ask = await handleCallback(db, P, "u:1");
  assert.match(ask.text, /ยกเลิกการผูก/);
  assert.equal(db._state.mappings[0].active, 1, "first tap changes nothing");
  const done = await handleCallback(db, P, "U:1");
  assert.equal(done.toast, "ยกเลิกการผูกแล้ว");
  assert.equal(db._state.mappings[0].active, 0);
  assert.equal((await handleCallback(db, P, "U:1")).toast, "ปิดการผูกไปแล้ว", "repeat is a no-op");
  const actions = (await listAudit(db, P)).rows.map((r) => r.action);
  assert.deepEqual(actions, ["MAPPING_UPDATE", "SUGGESTION_APPROVE"]);
});

test("U13 isAutoMappable rule and wiring", () => {
  assert.equal(isAutoMappable({ status: "PENDING", confidence: "HIGH", product_id: 1, mappable: true, prefilter_score: 5 }), true);
  assert.equal(isAutoMappable({ status: "PENDING", confidence: "HIGH", product_id: 1, mappable: true, prefilter_score: 4 }), false);
  assert.equal(isAutoMappable({ status: "APPROVED", confidence: "HIGH", product_id: 1, mappable: true, prefilter_score: 10 }), false);
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(raw, /"AUTO_MAP_HIGH": "1"/);
  const daily = readFileSync(new URL("../src/daily-jobs.js", import.meta.url), "utf8");
  assert.match(daily, /autoMapHighConfidence\(env/);
});
