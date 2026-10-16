import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";
import { issueSession } from "../src/admin.js";
import { autoMapHighConfidence } from "../src/auto-map.js";
import { sha256Hex } from "../src/discovery.js";
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
async function seed(n) {
  const db = createFakeD1({ products: [{ id: 1, name: "หัวชาร์จเร็ว 20W", affiliate_url: "https://s.shopee.co.th/a" }] });
  for (let i = 1; i <= n; i += 1) {
    const text = "โพสต์ " + i;
    db._sqlite.prepare(`INSERT INTO post_candidates (page_id, post_id, content_type, message, content_hash, discovery_source) VALUES (?, ?, 'POST', ?, 'h', 'posts')`).run(P, `${P}_${i}`, text);
    db._sqlite.prepare(`INSERT INTO product_suggestions (page_id, subject_key, representative_post_id, product_id, rank, confidence, prefilter_score, source, reason, prompt_version, content_hash, status)
      VALUES (?, ?, ?, 1, 1, 'HIGH', 10, 'AI', 'r', 'v', ?, 'PENDING')`).run(P, `p:${P}_${i}`, `${P}_${i}`, await sha256Hex(text));
  }
  return db;
}

test("U14 the list says who/how each suggestion was decided", async () => {
  const db = await seed(3);
  await req(db, "POST", "/admin/api/suggestions/1/approve", {});           // dashboard
  await req(db, "POST", "/admin/api/suggestions/2/reject", {});            // dashboard
  await autoMapHighConfidence(createEnv({ DB: db }), { fetchImpl: async () => new Response("{}") }); // #3 auto
  const list = (await req(db, "GET", "/admin/api/suggestions?limit=10")).json.data;
  const by = Object.fromEntries(list.map((s) => [s.id, s.decision]));
  assert.deepEqual([by[1].decision, by[1].via], ["APPROVED", "dashboard"]);
  assert.deepEqual([by[2].decision, by[2].via], ["REJECTED", "dashboard"]);
  assert.deepEqual([by[3].decision, by[3].via], ["APPROVED", "auto"]);
  assert.equal(by[3].confirmed_at, null);
});

test("U14 confirm an automatic approval; undo switches its mapping off (idempotent); guards", async () => {
  const db = await seed(1);
  await autoMapHighConfidence(createEnv({ DB: db }), { fetchImpl: async () => new Response("{}") });
  assert.equal(db._state.mappings[0].active, 1);
  const c = await req(db, "POST", "/admin/api/suggestions/1/confirm", {});
  assert.equal(c.status, 200);
  assert.equal(db._state.mappings[0].active, 1, "confirm changes nothing but the record");
  let d = (await req(db, "GET", "/admin/api/suggestions")).json.data[0].decision;
  assert.ok(d.confirmed_at);
  const u = await req(db, "POST", "/admin/api/suggestions/1/undo", {});
  assert.equal(u.status, 200);
  assert.equal(db._state.mappings[0].active, 0);
  assert.equal(db._state.mappings.length, 1, "deactivated, never deleted");
  assert.equal((await req(db, "POST", "/admin/api/suggestions/1/undo", {})).json.data.idempotent, true);
  d = (await req(db, "GET", "/admin/api/suggestions")).json.data[0].decision;
  assert.ok(d.undone_at);
  assert.equal((await req(db, "GET", "/admin/api/suggestions/1/undo")).status, 405);
  assert.equal((await req(db, "POST", "/admin/api/suggestions/99/confirm", {})).status, 404);
  const db2 = await seed(1);
  assert.equal((await req(db2, "POST", "/admin/api/suggestions/1/undo", {})).status, 409, "PENDING cannot be undone");
});

test("U14 dashboard: settings sub-tabs, 4 themes + mode, approve button, decision line; text only", () => {
  const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.match(app, /const SETTINGS_TABS = \[\["general", "ทั่วไป"\], \["theme", "ธีม"\]/);
  assert.match(app, /const THEMES = \[\["indigo"[\s\S]*?\["ocean"[\s\S]*?\["sunset"[\s\S]*?\["grape"/);
  assert.match(app, /localStorage\.getItem\(key\)/);
  assert.match(app, /try \{ window\.localStorage\.setItem\(key, value\); \} catch/, "storage failures never break the page");
  assert.match(app, /"✅ อนุมัติ \(ผูกสินค้านี้\)"/);
  assert.match(app, /function decisionLine\(s\)/);
  assert.match(app, /"\/confirm"/);
  assert.match(app, /"\/undo"/);
  const css = readFileSync(new URL("../dashboard/app.css", import.meta.url), "utf8");
  for (const t of ["ocean", "sunset", "grape"]) assert.match(css, new RegExp(`:root\\[data-theme="${t}"\\]`));
  assert.match(css, /:root\[data-mode="dark"\]/);
  assert.match(css, /:root:not\(\[data-mode="light"\]\)/);
});
