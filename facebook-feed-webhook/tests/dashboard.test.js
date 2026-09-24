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

test("content mappings: create/replace, change product, toggle, delete; deleted product disables mappings", async () => {
  const db = createFakeD1();
  const a = (await req(db, "POST", "/admin/api/products", { body: GOOD })).json.data.id;
  const b = (await req(db, "POST", "/admin/api/products", { body: { ...GOOD, name: "หูฟัง", affiliate_url: "https://s.shopee.co.th/xyz" } })).json.data.id;

  const post = "853313081388711_900";
  const m = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: post, facebook_content_type: "REEL", product_id: a } });
  assert.equal(m.status, 201);
  const again = await req(db, "POST", "/admin/api/content", { body: { facebook_post_id: post, product_id: b } });
  assert.equal(again.json.data.id, m.json.data.id, "one mapping per post (upsert)");
  assert.equal(db._state.mappings.length, 1);
  assert.equal(db._state.mappings[0].product_id, b);

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
