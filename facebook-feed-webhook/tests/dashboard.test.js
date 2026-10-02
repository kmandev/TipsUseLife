import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";
import { issueSession } from "../src/admin.js";
import { renderDashboardModule } from "../scripts/build-dashboard.mjs";
import { createFakeD1, createEnv, createCtx } from "./helpers.js";

const SECRET = "unit-test-admin-session-secret";
const ORIGIN = "https://worker.example";

function env(db, over = {}) {
  return createEnv({ DB: db, ADMIN_PASSWORD: "pw-unit-test", ADMIN_SESSION_SECRET: SECRET, ...over });
}

async function cookie() {
  return `admin_session=${await issueSession(SECRET)}`;
}

async function req(db, method, path, { body, auth = true, origin = ORIGIN, contentType = "application/json", envOver } = {}) {
  const headers = {};
  if (auth) headers.cookie = await cookie();
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = contentType;
  const response = await worker.fetch(
    new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env(db, envOver),
    createCtx()
  );
  let json = null;
  try { json = await response.clone().json(); } catch { json = null; }
  return { status: response.status, json, response };
}

const GOOD = { name: "ที่ชาร์จเร็ว", affiliate_url: "https://s.shopee.co.th/abc", platform: "shopee", keywords: "ชาร์จ, หัวชาร์จ", description: "ชาร์จเร็ว 20W", active: true };

test("dashboard shell and assets are served with a strict CSP and no data", async () => {
  const db = createFakeD1();
  const html = await req(db, "GET", "/admin", { auth: false });
  assert.equal(html.status, 200);
  assert.match(html.response.headers.get("content-type"), /text\/html/);
  const csp = html.response.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline'[^;]*script|script-src[^;]*unsafe/);
  assert.equal((await req(db, "GET", "/admin/app.js", { auth: false })).status, 200);
  assert.equal((await req(db, "GET", "/admin/app.css", { auth: false })).status, 200);
});

test("the generated src/dashboard.js is in sync with dashboard/*", () => {
  const onDisk = readFileSync(new URL("../src/dashboard.js", import.meta.url), "utf8");
  assert.equal(onDisk, renderDashboardModule(), "run: npm run build:dashboard");
});

test("the dashboard client never renders data through innerHTML", () => {
  const js = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js));
});

test("every /admin/api route requires a session", async () => {
  const db = createFakeD1();
  for (const [m, p] of [["GET", "/admin/api/overview"], ["GET", "/admin/api/products"], ["POST", "/admin/api/products"], ["GET", "/admin/api/content"], ["GET", "/admin/api/settings"]]) {
    const r = await req(db, m, p, { auth: false, body: m === "POST" ? GOOD : undefined });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test("state-changing requests without a same-origin Origin are rejected (CSRF)", async () => {
  const db = createFakeD1();
  assert.equal((await req(db, "POST", "/admin/api/products", { body: GOOD, origin: null })).status, 403);
  assert.equal((await req(db, "POST", "/admin/api/products", { body: GOOD, origin: "https://evil.example" })).status, 403);
  assert.equal((await req(db, "POST", "/admin/api/products", { body: GOOD, contentType: "text/plain" })).status, 403);
  assert.equal(db._state.products.length, 0);
});

test("products: create, list, search, edit, toggle, soft delete", async () => {
  const db = createFakeD1();
  const created = await req(db, "POST", "/admin/api/products", { body: GOOD });
  assert.equal(created.status, 201);
  const id = created.json.data.id;
  assert.equal(created.json.data.affiliate_url, GOOD.affiliate_url);
  assert.equal(db._state.products[0].shopee_url, GOOD.affiliate_url, "legacy column kept in sync");

  assert.equal((await req(db, "GET", "/admin/api/products?search=" + encodeURIComponent("ชาร์จ"))).json.data.length, 1);
  assert.equal((await req(db, "GET", "/admin/api/products?search=nothing")).json.data.length, 0);

  const edited = await req(db, "PATCH", `/admin/api/products/${id}`, { body: { ...GOOD, name: "ที่ชาร์จ 30W" } });
  assert.equal(edited.json.data.name, "ที่ชาร์จ 30W");

  const off = await req(db, "PATCH", `/admin/api/products/${id}`, { body: { active: false } });
  assert.equal(off.json.data.active, 0);
  assert.equal((await req(db, "GET", "/admin/api/products?active=1")).json.data.length, 0);

  assert.equal((await req(db, "DELETE", `/admin/api/products/${id}`)).status, 200);
  assert.equal((await req(db, "GET", "/admin/api/products")).json.data.length, 0, "soft-deleted is hidden");
  assert.ok(db._state.products[0].deleted_at, "row kept, marked deleted");
  assert.equal((await req(db, "PATCH", `/admin/api/products/${id}`, { body: { active: true } })).status, 404);
});

test("products: invalid input is rejected before D1", async () => {
  const db = createFakeD1();
  const cases = [
    [{ ...GOOD, name: "" }, "name"],
    [{ ...GOOD, affiliate_url: "http://s.shopee.co.th/x" }, "affiliate_url"],
    [{ ...GOOD, affiliate_url: "https://evil.example/x" }, "affiliate_url"],
    [{ ...GOOD, platform: "ebay" }, "platform"],
    [{ ...GOOD, image_url: "javascript:alert(1)" }, "image_url"],
    [{ ...GOOD, active: "maybe" }, "active"],
  ];
  for (const [body, field] of cases) {
    const r = await req(db, "POST", "/admin/api/products", { body });
    assert.equal(r.status, 400, field);
    assert.equal(r.response.headers.get("x-invalid-field"), field);
  }
  assert.equal(db._state.products.length, 0);
});

// AM-2.5: POST no longer replaces an existing mapping (it answers 409 MAPPING_EXISTS and
// leaves the row untouched); a deliberate product change goes through PATCH.
test("content mappings: create, no silent replace, change product, toggle, delete; deleted product disables mappings", async () => {
  const db = createFakeD1();
  const a = (await req(db, "POST", "/admin/api/products", { body: GOOD })).json.data.id;
  const b = (await req(db, "POST", "/admin/api/products", { body: { ...GOOD, name: "หูฟัง", affiliate_url: "https://s.shopee.co.th/xyz" } })).json.data.id;

  const post = "853313081388711_900";
  const m = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: post, facebook_content_type: "REEL", product_id: a } });
  assert.equal(m.status, 201);
  const again = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: post, product_id: b } });
  assert.equal(again.status, 409, "one mapping per post: create never replaces");
  assert.equal(again.json.error.code, "MAPPING_EXISTS");
  assert.deepEqual(again.json.existing_mapping_ids, [m.json.data.id]);
  assert.equal(db._state.mappings.length, 1);
  assert.equal(db._state.mappings[0].product_id, a, "the existing mapping is unchanged");
  assert.equal((await req(db, "PATCH", `/admin/api/content/${m.json.data.id}`, { body: { product_id: b } })).json.data.product_id, b, "a deliberate change uses PATCH");

  const mid = m.json.data.id;
  assert.equal((await req(db, "PATCH", `/admin/api/content/${mid}`, { body: { product_id: a } })).json.data.product_id, a);
  assert.equal((await req(db, "PATCH", `/admin/api/content/${mid}`, { body: { active: false } })).json.data.active, 0);
  await req(db, "PATCH", `/admin/api/content/${mid}`, { body: { active: true } });

  await req(db, "DELETE", `/admin/api/products/${a}`);
  assert.equal(db._state.mappings[0].active, 0, "soft-deleting a product switches its mappings off");

  const listed = (await req(db, "GET", "/admin/api/content")).json.data;
  assert.equal(listed.mappings.length, 1);
  assert.ok(listed.mappings[0].product_deleted_at);

  assert.equal((await req(db, "DELETE", `/admin/api/content/${mid}`)).status, 200);
  assert.equal(db._state.mappings.length, 0);
});

test("content mappings: input validation and unknown product", async () => {
  const db = createFakeD1();
  assert.equal((await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: "abc", product_id: 1 } })).status, 400);
  assert.equal((await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: "853313081388711_900", product_id: 99 } })).status, 400);
  assert.equal((await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: "853313081388711_900", product_id: 1, facebook_content_type: "STORY" } })).status, 400);
});

test("unmapped posts are listed from observed comments", async () => {
  const db = createFakeD1();
  db._sqlite.exec(`INSERT INTO comments (facebook_comment_id, facebook_post_id, page_id, comment_text) VALUES ('c1','853313081388711_900','853313081388711','hi'), ('c2','853313081388711_900','853313081388711','yo')`);
  const data = (await req(db, "GET", "/admin/api/content")).json.data;
  assert.equal(data.unmapped.length, 1);
  assert.equal(data.unmapped[0].facebook_post_id, "853313081388711_900");
  assert.equal(data.unmapped[0].comment_count, 2);
});

test("overview counts and settings expose no secret values", async () => {
  const db = createFakeD1();
  const ov = await req(db, "GET", "/admin/api/overview");
  assert.equal(ov.status, 200);
  assert.equal(ov.json.mode, "DRY_RUN");
  for (const k of ["comments_received", "ai_replies", "ai_skipped", "replies_generated", "replies_sent", "dry_run_replies", "products_active", "mappings_active"]) {
    assert.equal(typeof ov.json.data[k], "number", k);
  }

  const st = await req(db, "GET", "/admin/api/settings", { envOver: { PAGE_ACCESS_TOKEN: "super-secret-page-token" } });
  const raw = JSON.stringify(st.json);
  assert.ok(!raw.includes("super-secret-page-token"));
  assert.ok(!raw.includes("unit-test-hermes-api-key"));
  assert.ok(!raw.includes("pw-unit-test"));
  assert.equal(st.json.data.secrets_present.PAGE_ACCESS_TOKEN, true);
  assert.equal(st.json.data.reply_mode, "DRY_RUN");
});

test("REPLY_MODE cannot be changed through the dashboard API", async () => {
  const db = createFakeD1();
  for (const [m, p] of [["POST", "/admin/api/settings"], ["PATCH", "/admin/api/settings"]]) {
    const r = await req(db, m, p, { body: { reply_mode: "LIVE" } });
    assert.equal(r.status, 405);
  }
});

test("session endpoint and logout", async () => {
  const db = createFakeD1();
  assert.equal((await req(db, "GET", "/admin/session", { auth: false })).json.authenticated, false);
  assert.equal((await req(db, "GET", "/admin/session")).json.authenticated, true);
  const out = await req(db, "POST", "/admin/logout");
  assert.match(out.response.headers.get("set-cookie"), /Max-Age=0/);
});

/* ===================== AM-2.5 manual mapping safety ===================== */

const AM25_PAGE = "853313081388711";
const AM25_PRODUCTS = [
  { id: 1, name: "สินค้า A", affiliate_url: "https://s.shopee.co.th/a1" },
  { id: 2, name: "สินค้า B", affiliate_url: "https://s.shopee.co.th/b2" },
  { id: 3, name: "ปิดอยู่", affiliate_url: "https://s.shopee.co.th/c3", active: 0 },
  { id: 4, name: "ลบแล้ว", affiliate_url: "https://s.shopee.co.th/d4", deleted_at: "2026-09-01 00:00:00" },
];
/** One canonical Reel known under its posts-edge id and its bare reels-edge id. */
function am25Db(mappings = []) {
  const db = createFakeD1({ products: AM25_PRODUCTS, mappings });
  const ins = (postId, src) =>
    db._sqlite
      .prepare(`INSERT INTO post_candidates (page_id, post_id, content_type, message, permalink, content_hash, discovery_source, canonical_reel_id) VALUES (?, ?, 'REEL', 'x', 'https://www.facebook.com/reel/7777777/', 'h', ?, '7777777')`)
      .run(AM25_PAGE, postId, src);
  ins("7777777", "reels");
  ins(`${AM25_PAGE}_5550001`, "posts");
  return db;
}
const am25Maps = (db) => JSON.stringify(db._query("SELECT * FROM content_mappings ORDER BY id"));

test("AM-2.5 POST: bare reel ids, foreign-page ids and malformed ids are rejected", async () => {
  const db = am25Db();
  for (const id of ["7777777", "1418143500204950", "999999_123", "abc_123", `${AM25_PAGE}_`, `${AM25_PAGE}`]) {
    const r = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: id, product_id: 1 } });
    assert.equal(r.status, 400, id);
    assert.equal(r.response.headers.get("x-invalid-field"), "facebook_post_id");
  }
  assert.equal(db._state.mappings.length, 0);
});

test("AM-2.5 POST: missing, inactive and deleted products are rejected", async () => {
  const db = am25Db();
  for (const productId of [99, 3, 4]) {
    const r = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: `${AM25_PAGE}_5550001`, product_id: productId } });
    assert.equal(r.status, 400, String(productId));
    assert.equal(r.json.error.code, "PRODUCT_UNAVAILABLE");
  }
  assert.equal(db._state.mappings.length, 0);
});

test("AM-2.5 POST: an exact-post duplicate is 409 and never overwrites (active or inactive)", async () => {
  for (const active of [1, 0]) {
    const db = am25Db([{ facebook_post_id: `${AM25_PAGE}_5550001`, product_id: 1, active, facebook_content_type: "REEL" }]);
    const before = am25Maps(db);
    const r = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: `${AM25_PAGE}_5550001`, product_id: 2, facebook_content_type: "POST", note: "x" } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, "MAPPING_EXISTS");
    assert.match(r.json.error.message, /edit the existing mapping/);
    assert.equal(am25Maps(db), before, "existing mapping unchanged");
  }
});

test("AM-2.5 POST: another physical row of an already-mapped canonical Reel is 409", async () => {
  // A legacy bare-id mapping on the reels-edge row blocks mapping the posts-edge row.
  const db = am25Db([{ facebook_post_id: "7777777", product_id: 1, active: 1, facebook_content_type: "REEL" }]);
  const before = am25Maps(db);
  const r = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: `${AM25_PAGE}_5550001`, product_id: 2 } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "MAPPING_EXISTS");
  assert.match(r.json.error.message, /same Reel/);
  assert.equal(am25Maps(db), before);
});

test("AM-2.5 POST: a post discovery has not seen yet can still be mapped (exact-post rules only)", async () => {
  const db = am25Db();
  const r = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: `${AM25_PAGE}_1603079361827161`, facebook_content_type: "REEL", product_id: 1 } });
  assert.equal(r.status, 201);
  assert.equal(db._state.mappings.length, 1);
});

test("AM-2.5 PATCH: unavailable product changes and unsafe reactivation are blocked; deactivation always works", async () => {
  const db = am25Db([{ facebook_post_id: `${AM25_PAGE}_5550001`, product_id: 1, active: 1, facebook_content_type: "REEL" }]);
  const id = db._state.mappings[0].id;
  const before = am25Maps(db);
  for (const productId of [3, 4, 99]) {
    const r = await req(db, "PATCH", `/admin/api/content/${id}`, { body: { product_id: productId } });
    assert.equal(r.status, 400, String(productId));
    assert.equal(r.json.error.code, "PRODUCT_UNAVAILABLE");
  }
  assert.equal(am25Maps(db), before, "no partial update");

  // The product later becomes inactive: deactivation still works, reactivation does not.
  db._sqlite.prepare(`UPDATE products SET active = 0 WHERE id = 1`).run();
  const off = await req(db, "PATCH", `/admin/api/content/${id}`, { body: { active: false } });
  assert.equal(off.status, 200);
  assert.equal(off.json.data.active, 0);
  const note = await req(db, "PATCH", `/admin/api/content/${id}`, { body: { note: "แก้บันทึก" } });
  assert.equal(note.status, 200, "a note edit on an inactive mapping is not blocked");
  const on = await req(db, "PATCH", `/admin/api/content/${id}`, { body: { active: true } });
  assert.equal(on.status, 400);
  assert.equal(on.json.error.code, "PRODUCT_UNAVAILABLE");
  assert.equal(db._state.mappings[0].active, 0);
  // Product available again -> reactivation allowed.
  db._sqlite.prepare(`UPDATE products SET active = 1 WHERE id = 1`).run();
  assert.equal((await req(db, "PATCH", `/admin/api/content/${id}`, { body: { active: true } })).status, 200);
});

test("AM-2.5 PATCH: reactivating or editing a mapping while a sibling row of the same Reel is active is 409", async () => {
  const db = am25Db([
    { facebook_post_id: "7777777", product_id: 1, active: 1, facebook_content_type: "REEL" }, // legacy sibling
    { facebook_post_id: `${AM25_PAGE}_5550001`, product_id: 2, active: 0, facebook_content_type: "REEL" },
  ]);
  const target = db._state.mappings.find((m) => m.facebook_post_id === `${AM25_PAGE}_5550001`).id;
  const before = am25Maps(db);
  const r = await req(db, "PATCH", `/admin/api/content/${target}`, { body: { active: true } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "MAPPING_EXISTS");
  const r2 = await req(db, "PATCH", `/admin/api/content/${target}`, { body: { active: true, product_id: 1, facebook_content_type: "POST" } });
  assert.equal(r2.status, 409);
  assert.equal(am25Maps(db), before, "nothing changed");
  // Deactivating the legacy sibling is always allowed, after which the target may be activated.
  const sib = db._state.mappings.find((m) => m.facebook_post_id === "7777777").id;
  assert.equal((await req(db, "PATCH", `/admin/api/content/${sib}`, { body: { active: false } })).status, 200);
  assert.equal((await req(db, "PATCH", `/admin/api/content/${target}`, { body: { active: true } })).status, 200);
});

test("AM-2.5 PATCH: the page/post key stays immutable", async () => {
  const db = am25Db([{ facebook_post_id: `${AM25_PAGE}_5550001`, product_id: 1, active: 1, facebook_content_type: "REEL" }]);
  const id = db._state.mappings[0].id;
  const r = await req(db, "PATCH", `/admin/api/content/${id}`, { body: { facebook_post_id: `${AM25_PAGE}_42`, facebook_page_id: "1", product_id: 2 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.facebook_post_id, `${AM25_PAGE}_5550001`);
  assert.equal(r.json.data.facebook_page_id, AM25_PAGE);
});

test("AM-2.5 dashboard: product change asks first; cancel restores and sends nothing; errors reload", () => {
  const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  const start = app.indexOf("const sel = h(\"select\", { onchange: async (e) => {");
  assert.ok(start > 0);
  const handler = app.slice(start, app.indexOf("}, productOptions(m.product_id));", start));
  const confirmAt = handler.indexOf("window.confirm(");
  const patchAt = handler.indexOf('method: "PATCH"');
  assert.ok(confirmAt > 0 && patchAt > confirmAt, "PATCH only after confirmation");
  assert.match(handler, /if \(!ok\) \{ e\.target\.value = String\(m\.product_id\); return; \}/, "cancel restores the persisted value before any request");
  assert.equal((handler.match(/api\(/g) || []).length, 1, "confirm sends exactly one request");
  assert.match(handler, /จาก: [\s\S]*เป็น: /, "shows current and proposed product");
  assert.match(handler, /catch \(ex\) \{ toast\(ex\.message, "err"\); \}\s*refresh\(\);/, "success or error reloads the persisted state");
  // The active switch reverts on error and reflects the server response.
  assert.match(app, /toast\("อัปเดตแล้ว"\); refresh\(\); \} catch \(ex\) \{ toast\(ex\.message, "err"\); e\.target\.checked = !e\.target\.checked; \}/);
});
