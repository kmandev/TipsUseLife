/**
 * Phase AM-2.4 -- explicit HUMAN approval of a product suggestion -> one
 * content mapping. No network: any fetch is recorded and must not happen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import worker from "../src/index.js";
import { issueSession } from "../src/admin.js";
import { sha256Hex } from "../src/discovery.js";
import { approveSuggestion, approvalNote, listSuggestions } from "../src/suggestions.js";
import { getMappedProduct } from "../src/db.js";
import { renderDashboardModule } from "../scripts/build-dashboard.mjs";
import { createFakeD1, createEnv, createCtx, installFetchMock, TEST_PAGE_ID } from "./helpers.js";

const P = TEST_PAGE_ID;
const SECRET = "unit-test-admin-session-secret";
const ORIGIN = "https://worker.example";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPTION = "เครื่องตัดแต่งพุ่มไม้ไร้สาย ตัดพุ่มง่าย #เครื่องตัดพุ่มไม้";
const PRODUCTS = [
  { id: 10, name: "เครื่องตัดแต่งพุ่มไม้ไร้สาย", keywords: "เครื่องตัดพุ่มไม้", affiliate_url: "https://s.shopee.co.th/aff10" },
  { id: 8, name: "เลื่อยโซ่ไฟฟ้าไร้สาย", keywords: "เลื่อยโซ่", affiliate_url: "https://s.shopee.co.th/aff8" },
  { id: 11, name: "ปิดอยู่", keywords: "x", affiliate_url: "https://s.shopee.co.th/aff11", active: 0 },
  { id: 12, name: "ลบแล้ว", keywords: "y", affiliate_url: "https://s.shopee.co.th/aff12", deleted_at: "2026-09-01 00:00:00" },
];

/** One logical Reel: posts-edge `<page>_<n>` + reels-edge bare id (optional), same canonical id. */
function seedReel(db, { n = 1643230854478678, bare = "1418143500204950", message = CAPTION, posts = true, reels = true, type = "REEL" } = {}) {
  const link = `https://www.facebook.com/reel/${bare}/`;
  const ins = (postId, src) =>
    db._sqlite
      .prepare(`INSERT INTO post_candidates (page_id, post_id, content_type, message, permalink, content_hash, discovery_source, canonical_reel_id) VALUES (?, ?, ?, ?, ?, 'h', ?, ?)`)
      .run(P, postId, type, message, link, src, bare);
  if (reels) ins(bare, "reels");
  if (posts) ins(`${P}_${n}`, "posts");
}
async function seedSuggestion(db, { bare = "1418143500204950", rep = `${P}_1643230854478678`, product = 10, status = "PENDING", message = CAPTION, hash } = {}) {
  const h = hash ?? (await sha256Hex(message));
  const info = db._sqlite
    .prepare(
      `INSERT INTO product_suggestions (page_id, subject_key, representative_post_id, product_id, rank, confidence, prefilter_score, source, reason, prompt_version, content_hash, status)
       VALUES (?, ?, ?, ?, 1, 'HIGH', 12, 'AI', 'ตรงกับชื่อสินค้า', 'am23-2026-10-02.1', ?, ?)`
    )
    .run(P, `r:${bare}`, rep, product, h, status);
  return Number(info.lastInsertRowid);
}
const db0 = (mappings = []) => createFakeD1({ products: PRODUCTS, mappings });
const env = (db) => createEnv({ DB: db, ADMIN_PASSWORD: "pw-unit-test", ADMIN_SESSION_SECRET: SECRET, PAGE_ACCESS_TOKEN: "TEST-ONLY-fake" });
async function req(db, method, path, { body, auth = true, origin = ORIGIN, contentType = "application/json", cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  else if (auth) headers.cookie = `admin_session=${await issueSession(SECRET)}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = contentType;
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env(db), createCtx());
  let json = null;
  try { json = await response.clone().json(); } catch { json = null; }
  return { status: response.status, json };
}
const approve = (db, id, body = {}) => req(db, "POST", `/admin/api/suggestions/${id}/approve`, { body });
const mappings = (db) => db._query("SELECT facebook_post_id, facebook_content_type, product_id, active, note FROM content_mappings ORDER BY id");
const statuses = (db) => db._query("SELECT id, status, decided_at IS NOT NULL AS decided FROM product_suggestions ORDER BY id");
const others = (db) => JSON.stringify(["products", "comments", "replies", "post_candidates"].map((t) => db._query(`SELECT * FROM ${t} ORDER BY 1`)));
function noNetwork() {
  return installFetchMock(() => { throw new Error("no network allowed during approval"); });
}

/* --------------------------------- success -------------------------------- */

test("approve: creates exactly one mapping on the <page>_<n> representative and marks the suggestion APPROVED", async () => {
  const db = db0();
  seedReel(db);
  const id = await seedSuggestion(db);
  const before = others(db);
  const net = noNetwork();
  try {
    const r = await approve(db, id);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, suggestion_id: id, idempotent: false, mapping: { page_id: P, post_id: `${P}_1643230854478678`, product_id: 10, content_type: "REEL" } });
    assert.deepEqual(mappings(db), [{ facebook_post_id: `${P}_1643230854478678`, facebook_content_type: "REEL", product_id: 10, active: 1, note: approvalNote(id) }]);
    assert.deepEqual(statuses(db), [{ id, status: "APPROVED", decided: 1 }]);
    assert.equal(others(db), before, "products, comments, replies, post_candidates untouched");
    assert.equal(net.calls.length, 0, "no Facebook, no Hermes, no network");
    // The reply pipeline's own lookup now resolves the product (no reply-path change needed).
    const mapped = await getMappedProduct(db, P, `${P}_1643230854478678`);
    assert.equal(Number(mapped.product.id), 10);
    assert.equal(await getMappedProduct(db, P, "1418143500204950"), null, "the bare reel id is never mapped");
  } finally { net.restore(); }
});

test("approve: other PENDING suggestions of the same subject become SUPERSEDED; other subjects untouched", async () => {
  const db = db0();
  seedReel(db);
  seedReel(db, { n: 5555555, bare: "2222222", message: "อีกโพสต์ เลื่อยโซ่" });
  const a = await seedSuggestion(db);
  const b = await seedSuggestion(db, { product: 8 }); // same subject, other product
  const c = await seedSuggestion(db, { bare: "2222222", rep: `${P}_5555555`, product: 8, message: "อีกโพสต์ เลื่อยโซ่" });
  const r = await approve(db, a);
  assert.equal(r.status, 200);
  assert.deepEqual(statuses(db).map((s) => s.status), ["APPROVED", "SUPERSEDED", "PENDING"]);
  assert.equal(statuses(db).find((s) => s.id === c).status, "PENDING");
  assert.equal(mappings(db).length, 1);
  assert.equal(statuses(db).find((s) => s.id === b).decided, 0, "superseded, not decided by a human");
});

/* ------------------------------- idempotency ------------------------------ */

test("approve: double click / browser retry never creates a second mapping", async () => {
  const db = db0();
  seedReel(db);
  const id = await seedSuggestion(db);
  const [first, second] = await Promise.all([approve(db, id), approve(db, id)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 200]);
  const third = await approve(db, id);
  assert.equal(third.status, 200);
  assert.equal(third.json.idempotent, true);
  assert.deepEqual(third.json.mapping, { page_id: P, post_id: `${P}_1643230854478678`, product_id: 10, content_type: "REEL" });
  assert.equal(mappings(db).length, 1);
  assert.equal(statuses(db)[0].status, "APPROVED");
});

test("approve: a mid-write failure leaves nothing applied (batch is all-or-nothing)", async () => {
  const db = createFakeD1({ products: PRODUCTS, failOn: /SET status = 'APPROVED'/ });
  seedReel(db);
  const id = await seedSuggestion(db);
  const r = await approve(db, id);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "MAPPING_WRITE_FAILED");
  assert.equal(mappings(db).length, 0, "no mapping without the APPROVED transition");
  assert.equal(statuses(db)[0].status, "PENDING", "never APPROVED without a mapping");
});

/* ---------------------------------- guards -------------------------------- */

test("approve: rejected states write nothing", async () => {
  const cases = [
    ["NOT_PENDING (REJECTED)", async (db) => seedSuggestion(db, { status: "REJECTED" }), 409, "NOT_PENDING"],
    ["NOT_PENDING (SUPERSEDED)", async (db) => seedSuggestion(db, { status: "SUPERSEDED" }), 409, "NOT_PENDING"],
    ["NULL product (no match)", async (db) => seedSuggestion(db, { product: null }), 409, "NO_PRODUCT"],
    ["inactive product", async (db) => seedSuggestion(db, { product: 11 }), 409, "PRODUCT_UNAVAILABLE"],
    ["deleted product", async (db) => seedSuggestion(db, { product: 12 }), 409, "PRODUCT_UNAVAILABLE"],
    ["stale text", async (db) => seedSuggestion(db, { hash: await sha256Hex("ข้อความเดิมก่อนแก้ไข") }), 409, "SUGGESTION_STALE"],
    ["unknown subject", async (db) => seedSuggestion(db, { bare: "9999999" }), 409, "SUBJECT_NOT_FOUND"],
  ];
  for (const [name, make, status, code] of cases) {
    const db = db0();
    seedReel(db);
    const id = await make(db);
    const before = JSON.stringify([mappings(db), statuses(db)]);
    const r = await approve(db, id);
    assert.equal(r.status, status, name);
    assert.equal(r.json.error.code, code, name);
    assert.equal(JSON.stringify([mappings(db), statuses(db)]), before, `${name}: nothing written`);
  }
});

test("approve: unknown product id (not in catalog) is rejected", async () => {
  const db = db0();
  seedReel(db);
  db._sqlite.exec("PRAGMA foreign_keys = OFF;");
  const id = await seedSuggestion(db, { product: 777 });
  db._sqlite.exec("PRAGMA foreign_keys = ON;");
  const r = await approve(db, id);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "PRODUCT_UNAVAILABLE");
  assert.equal(mappings(db).length, 0);
});

test("approve: a Reel known only by its bare reels-edge id is never mapped", async () => {
  const db = db0();
  seedReel(db, { posts: false });
  const id = await seedSuggestion(db, { rep: "1418143500204950" });
  const r = await approve(db, id);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "NO_SAFE_REPRESENTATIVE");
  assert.equal(mappings(db).length, 0);
  assert.equal(statuses(db)[0].status, "PENDING");
  assert.equal((await listSuggestions(db, P))[0].mappable, false, "the UI does not offer it either");
});

test("approve: unknown content type is not guessed", async () => {
  const db = db0();
  seedReel(db, { type: null, reels: false });
  db._sqlite.prepare(`UPDATE post_candidates SET content_type = NULL`).run();
  const id = await seedSuggestion(db);
  const r = await approve(db, id);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "CONTENT_TYPE_UNKNOWN");
});

test("approve: any existing mapping (active or inactive) on the subject is a conflict, never overwritten", async () => {
  for (const [postId, active] of [[`${P}_1643230854478678`, 1], [`${P}_1643230854478678`, 0], ["1418143500204950", 1]]) {
    const db = db0([{ facebook_post_id: postId, product_id: 8, active, facebook_content_type: "REEL" }]);
    seedReel(db);
    const id = await seedSuggestion(db);
    const before = JSON.stringify(mappings(db));
    const r = await approve(db, id);
    assert.equal(r.status, 409, `${postId}/${active}`);
    assert.equal(r.json.error.code, "MAPPING_EXISTS");
    assert.equal(JSON.stringify(mappings(db)), before, "existing mapping untouched");
    assert.equal(statuses(db)[0].status, "PENDING");
  }
});

test("approve: the browser cannot substitute product, post or page", async () => {
  const db = db0();
  seedReel(db);
  seedReel(db, { n: 5555555, bare: "2222222", message: "อีกโพสต์" });
  const id = await seedSuggestion(db);
  const r = await approve(db, id, { product_id: 8, facebook_post_id: `${P}_5555555`, post_id: `${P}_5555555`, page_id: "999999", representative_post_id: "2222222", status: "APPROVED" });
  assert.equal(r.status, 200);
  assert.deepEqual(mappings(db).map((m) => [m.facebook_post_id, m.product_id]), [[`${P}_1643230854478678`, 10]]);
  assert.equal(db._query("SELECT COUNT(*) AS n FROM content_mappings WHERE facebook_page_id <> ?", P)[0].n, 0);
});

test("approve: a suggestion of another page is not found", async () => {
  const db = db0();
  seedReel(db);
  db._sqlite
    .prepare(`INSERT INTO product_suggestions (page_id, subject_key, representative_post_id, product_id, confidence, source, prompt_version, content_hash) VALUES ('999999', 'r:1418143500204950', ?, 10, 'HIGH', 'AI', 'v', ?)`)
    .run(`${P}_1643230854478678`, await sha256Hex(CAPTION));
  const r = await approve(db, 1);
  assert.equal(r.status, 404);
  assert.equal(mappings(db).length, 0);
});

/* --------------------------------- security ------------------------------- */

test("approve route: auth, invalid session, CSRF, method and id validation", async () => {
  const db2 = db0();
  seedReel(db2);
  const id2 = await seedSuggestion(db2);
  const path = `/admin/api/suggestions/${id2}/approve`;
  assert.equal((await req(db2, "POST", path, { body: {}, auth: false })).status, 401);
  assert.equal((await req(db2, "POST", path, { body: {}, cookie: "admin_session=forged.value" })).status, 401);
  assert.equal((await req(db2, "POST", path, { body: {}, origin: null })).status, 403);
  assert.equal((await req(db2, "POST", path, { body: {}, origin: "https://evil.example" })).status, 403);
  assert.equal((await req(db2, "POST", path, { body: {}, contentType: "text/plain" })).status, 403);
  assert.equal((await req(db2, "GET", path)).status, 405);
  assert.equal((await req(db2, "POST", "/admin/api/suggestions/abc/approve", { body: {} })).status, 400);
  assert.equal((await req(db2, "POST", "/admin/api/suggestions/999/approve", { body: {} })).status, 404);
  assert.equal(mappings(db2).length, 0, "no rejected request wrote anything");
  assert.equal(statuses(db2)[0].status, "PENDING");
});

test("dashboard: approval sits behind an explicit confirmation; no-match and unusable rows get no button; text is safe", () => {
  assert.equal(readFileSync(join(ROOT, "src", "dashboard.js"), "utf8"), renderDashboardModule(), "run: npm run build:dashboard");
  const app = readFileSync(join(ROOT, "dashboard", "app.js"), "utf8");
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  const view = app.slice(app.indexOf("async function viewSuggestions"), app.indexOf("/* ----------------------------- activity"));
  const approveAt = view.indexOf('"/approve"');
  const confirmAt = view.indexOf("window.confirm(");
  assert.ok(confirmAt > 0 && approveAt > confirmAt, "the approve call comes after the confirmation");
  assert.match(view, /if \(!window\.confirm\(.*\)\) return;/, "cancel returns before any request");
  assert.match(view, /s\.mappable \?/, "the button exists only for mappable suggestions");
  assert.match(view, /"ไม่มีสินค้าที่ตรง"/);
  assert.match(view, /text: s\.reason/);
  assert.match(view, /text: preview\(s\.message\)/);
  assert.doesNotMatch(view, /\/admin\/api\/content/, "the view never writes a mapping directly");
});

/* -------------------------------- isolation ------------------------------- */

test("isolation: approval code makes no network call and the reply path is unchanged", () => {
  const src = readFileSync(join(ROOT, "src", "suggestions.js"), "utf8");
  const fn = src.slice(src.indexOf("export async function approveSuggestion"), src.indexOf("export async function listSuggestionRuns"));
  assert.doesNotMatch(fn, /fetch|requestAgentReply|graph\.facebook/);
  assert.doesNotMatch(fn, /(INSERT INTO|UPDATE|DELETE FROM)\s+(products|comments|replies|post_candidates)\b/i);
  for (const f of ["pipeline.js", "db.js", "affiliate.js", "facebook-reply.js", "recovery.js", "ai.js", "hermes.js", "agent-prompt.js", "facebook.js", "config.js", "index.js"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, "src", f), "utf8"), /approveSuggestion|product_suggestions/, f);
  }
});
