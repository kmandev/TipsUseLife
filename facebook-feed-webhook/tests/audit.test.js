import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";
import { issueSession } from "../src/admin.js";
import { recordAudit, listAudit, auditSnapshot } from "../src/admin-db.js";
import { createFakeD1, createEnv, createCtx, TEST_PAGE_ID } from "./helpers.js";

const P = TEST_PAGE_ID;
const SECRET = "unit-test-admin-session-secret";
const ORIGIN = "https://worker.example";
async function req(db, method, path, body) {
  const headers = { cookie: `admin_session=${await issueSession(SECRET)}`, origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    createEnv({ DB: db, ADMIN_PASSWORD: "pw", ADMIN_SESSION_SECRET: SECRET }), createCtx());
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
const GOOD = { name: "หัวชาร์จ", affiliate_url: "https://s.shopee.co.th/abc", platform: "shopee", keywords: "ชาร์จ", description: "d", active: true };

test("U8 migration 0007 is additive: one new table + index, nothing altered or dropped", () => {
  const sql = readFileSync(new URL("../../database/migrations/0007_admin_audit.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS admin_audit/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_admin_audit_page/);
  assert.doesNotMatch(sql, /\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
});

test("U8 every admin change writes one audit row with before -> after", async () => {
  const db = createFakeD1();
  const p = await req(db, "POST", "/admin/api/products", GOOD);
  const pid = p.json.data.id;
  await req(db, "PATCH", `/admin/api/products/${pid}`, { ...GOOD, name: "หัวชาร์จ 30W" });
  await req(db, "PATCH", `/admin/api/products/${pid}`, { active: false });
  await req(db, "PATCH", `/admin/api/products/${pid}`, { active: true });
  const m = await req(db, "POST", "/admin/api/content", { facebook_post_id: `${P}_1`, facebook_content_type: "POST", product_id: pid, active: true });
  const mid = m.json.data.id;
  await req(db, "PATCH", `/admin/api/content/${mid}`, { note: "ทดสอบ" });
  await req(db, "DELETE", `/admin/api/content/${mid}`);
  await req(db, "DELETE", `/admin/api/products/${pid}`);
  const rows = (await listAudit(db, P, { limit: 50 })).rows.reverse();
  assert.deepEqual(rows.map((r) => r.action), ["PRODUCT_CREATE", "PRODUCT_UPDATE", "PRODUCT_TOGGLE", "PRODUCT_TOGGLE", "MAPPING_CREATE", "MAPPING_UPDATE", "MAPPING_DELETE", "PRODUCT_DELETE"]);
  assert.equal(rows[0].before, null);
  assert.equal(rows[0].after.name, "หัวชาร์จ");
  assert.deepEqual([rows[1].before.name, rows[1].after.name], ["หัวชาร์จ", "หัวชาร์จ 30W"]);
  assert.deepEqual([rows[2].before.active, rows[2].after.active], [1, 0]);
  assert.equal(rows[4].after.product_id, pid);
  assert.deepEqual([rows[5].before.note, rows[5].after.note], [null, "ทดสอบ"]);
  assert.equal(rows[6].after, null);
  assert.ok(rows[7].after.deleted_at);
  assert.ok(rows.every((r) => r.target_id !== null));
});

test("U8 failed / rejected requests write nothing; listing is page-scoped and paged", async () => {
  const db = createFakeD1();
  await req(db, "POST", "/admin/api/products", { ...GOOD, affiliate_url: "javascript:alert(1)" }); // 400
  await req(db, "POST", "/admin/api/content", { facebook_post_id: "123", product_id: 9 }); // 400
  assert.equal((await listAudit(db, P)).rows.length, 0);
  for (let i = 0; i < 3; i += 1) await recordAudit(db, { pageId: P, action: "PRODUCT_CREATE", targetType: "PRODUCT", targetId: i + 1, after: { name: "x" + i } });
  await recordAudit(db, { pageId: "other", action: "PRODUCT_CREATE", targetType: "PRODUCT", targetId: 9, after: { name: "other" } });
  const a = await req(db, "GET", "/admin/api/audit?limit=2");
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.data.map((r) => r.target_id), [3, 2]);
  assert.equal(a.json.has_more, true);
  const b = await req(db, "GET", "/admin/api/audit?limit=2&cursor=" + a.json.next_cursor);
  assert.deepEqual(b.json.data.map((r) => r.target_id), [1]);
  assert.equal((await req(db, "GET", "/admin/api/audit?type=BAD")).status, 400);
  assert.equal((await req(db, "GET", "/admin/api/audit?type=PRODUCT")).json.data.length, 3, "own page only");
  assert.equal((await req(db, "GET", "/admin/api/audit?type=MAPPING")).json.data.length, 0);
});

test("U8 snapshots keep only whitelisted fields (no description, keywords, tokens or comment text)", () => {
  const snap = auditSnapshot("PRODUCT", { name: "a", description: "secret-ish", keywords: "k", affiliate_url: "https://s.shopee.co.th/x", active: 1, token: "t" });
  assert.deepEqual(snap, { name: "a", affiliate_url: "https://s.shopee.co.th/x", active: 1 });
  assert.equal(auditSnapshot("COMMENT", { comment_text: "hello" }), null);
});

test("U8 audit failure never breaks the admin action (e.g. before migration 0007)", async () => {
  const db = createFakeD1();
  db._sqlite.exec("DROP TABLE admin_audit");
  const p = await req(db, "POST", "/admin/api/products", GOOD);
  assert.equal(p.status, 201, "the product is still created");
  assert.equal(db._state.products.length, 1);
  const l = await req(db, "GET", "/admin/api/audit");
  assert.equal(l.status, 200);
  assert.equal(l.json.available, false);
  assert.deepEqual(l.json.data, []);
});

test("U8 dashboard: history tab with diff view; text only", () => {
  const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  assert.match(app, /\["audit", "ประวัติ"\]/);
  assert.match(app, /"\/admin\/api\/audit\?" \+ qs/);
  assert.match(app, /function auditChanges\(/);
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});
