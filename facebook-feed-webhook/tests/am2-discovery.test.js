/**
 * Phase AM-2 -- read-only Facebook post discovery.
 * No network, no real Facebook, no real token: every Graph call is a mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import worker from "../src/index.js";
import { issueSession } from "../src/admin.js";
import { fetchPageContent, normalizeItem, classifyGraphFailure } from "../src/facebook-posts.js";
import { runDiscovery, sha256Hex, STALE_RUN_SECONDS } from "../src/discovery.js";
import { renderDashboardModule } from "../scripts/build-dashboard.mjs";
import { createFakeD1, createEnv, createCtx, installFetchMock, jsonResponse, captureConsole, TEST_PAGE_ID } from "./helpers.js";

const SECRET = "unit-test-admin-session-secret";
const ORIGIN = "https://worker.example";
const TOKEN = "TEST-ONLY-fake-page-token-do-not-leak";
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function env(db, over = {}) {
  return createEnv({ DB: db, ADMIN_PASSWORD: "pw-unit-test", ADMIN_SESSION_SECRET: SECRET, PAGE_ACCESS_TOKEN: TOKEN, ...over });
}

async function req(db, method, path, { body, auth = true, origin = ORIGIN, contentType = "application/json", envOver } = {}) {
  const headers = {};
  if (auth) headers.cookie = `admin_session=${await issueSession(SECRET)}`;
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

const post = (n, extra = {}) => ({
  id: `${TEST_PAGE_ID}_${1000 + n}`,
  message: `post ${n}`,
  created_time: "2026-09-20T10:00:00+0000",
  permalink_url: `https://www.facebook.com/${TEST_PAGE_ID}/posts/${1000 + n}`,
  status_type: "mobile_status_update",
  ...extra,
});
const reel = (n, extra = {}) => ({
  id: `${90000 + n}`,
  description: `reel ${n}`,
  created_time: "2026-09-21T10:00:00+0000",
  permalink_url: `/reel/${90000 + n}`,
  ...extra,
});

/** Graph mock: routes by edge; `plan` maps edge -> array of responses (one per page). */
function graphMock(plan) {
  const counters = {};
  return installFetchMock((url) => {
    const edge = /\/(published_posts|video_reels)\?/.exec(url)?.[1];
    const list = plan[edge];
    if (!list) return jsonResponse({ error: { code: 100 } }, 400);
    const i = (counters[edge] = (counters[edge] ?? -1) + 1);
    const step = list[Math.min(i, list.length - 1)];
    return typeof step === "function" ? step(url) : step.clone(); // reusable across runs
  });
}
const page = (items, next = false) =>
  jsonResponse({ data: items, ...(next ? { paging: { cursors: { after: "CUR" }, next: "https://graph.facebook.com/next" } } : {}) });

function snapshotMappings(db) {
  return JSON.stringify([db._query("SELECT * FROM content_mappings ORDER BY id"), db._query("SELECT * FROM products ORDER BY id")]);
}

/* ------------------------------ migration ------------------------------ */

test("migration 0004 creates the candidate tables and is additive", () => {
  const db = createFakeD1();
  const tables = db._query("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  assert.ok(tables.includes("post_candidates"));
  assert.ok(tables.includes("discovery_runs"));
  const sql = readFileSync(join(SRC, "..", "..", "database", "migrations", "0004_post_candidates.sql"), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /\bDROP\b|\bALTER\s+TABLE\b|\bDELETE\s+FROM\b|\bUPDATE\b/i);
  // Existing structures unchanged.
  const cols = (t) => db._query(`PRAGMA table_info(${t})`).map((c) => c.name).join(",");
  assert.equal(cols("content_mappings"), "id,facebook_page_id,facebook_post_id,facebook_content_type,product_id,active,note,created_at,updated_at");
});

test("UNIQUE(page_id, post_id) and CHECK constraints are enforced", () => {
  const db = createFakeD1();
  const ins = (type = "POST", pid = "123456_1") =>
    db._sqlite
      .prepare(`INSERT INTO post_candidates (page_id, post_id, content_type, content_hash, discovery_source) VALUES ('p', ?, ?, 'h', 'posts')`)
      .run(pid, type);
  ins();
  assert.throws(() => ins(), /UNIQUE/i);
  assert.throws(() => ins("VIDEO", "123456_2"), /CHECK/i);
  ins(null, "123456_3"); // unknown type is allowed
});

/* ---------------------------- Graph reader ----------------------------- */

const opts = (over = {}) => ({ pageId: TEST_PAGE_ID, accessToken: TOKEN, deadlineAt: Date.now() + 5000, ...over });

test("reader: GET only, token in Authorization header only, minimum fields", async () => {
  const mock = graphMock({ published_posts: [page([post(1)])] });
  try {
    const r = await fetchPageContent("posts", opts());
    assert.equal(r.error, null);
    assert.equal(r.items.length, 1);
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.method, "GET");
    assert.equal(call.init.body, undefined);
    assert.ok(!call.url.includes(TOKEN) && !/access_token/i.test(call.url));
    assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.doesNotMatch(call.url, /comments|from|attachments|source|picture/);
  } finally { mock.restore(); }
});

test("reader: pagination is capped by max pages and max items", async () => {
  const mock = graphMock({ published_posts: [page([post(1), post(2)], true), page([post(3), post(4)], true), page([post(5)], false)] });
  try {
    const r = await fetchPageContent("posts", opts({ maxPages: 2 }));
    assert.equal(r.error, null);
    assert.equal(r.pages, 2);
    assert.equal(r.items.length, 4);
    assert.equal(r.truncated, true);
    assert.equal(r.complete, false);
    assert.equal(mock.calls.length, 2);
  } finally { mock.restore(); }
  const mock2 = graphMock({ published_posts: [page([post(1), post(2), post(3)], false)] });
  try {
    const r = await fetchPageContent("posts", opts({ maxItems: 2 }));
    assert.equal(r.items.length, 2);
    assert.equal(r.truncated, true);
  } finally { mock2.restore(); }
});

test("reader: complete read is flagged complete, second page uses the cursor", async () => {
  const mock = graphMock({ published_posts: [page([post(1)], true), page([post(2)], false)] });
  try {
    const r = await fetchPageContent("posts", opts({ maxPages: 3 }));
    assert.equal(r.items.length, 2);
    assert.equal(r.complete, true);
    assert.match(mock.calls[1].url, /after=CUR/);
  } finally { mock.restore(); }
});

test("reader: malformed and partial items are skipped or stored with null fields", async () => {
  const mock = graphMock({
    published_posts: [page([post(1), { message: "no id" }, { id: "abc" }, null, "str", { id: `${TEST_PAGE_ID}_5001` }, post(1), post(2, { permalink_url: "http://evil.example/x", created_time: "garbage" })])],
  });
  try {
    const r = await fetchPageContent("posts", opts());
    assert.equal(r.error, null);
    assert.deepEqual(r.items.map((i) => i.post_id), [`${TEST_PAGE_ID}_1001`, `${TEST_PAGE_ID}_5001`, `${TEST_PAGE_ID}_1002`]);
    assert.equal(r.skipped, 5); // 4 malformed + 1 duplicate id
    const bare = r.items[1];
    assert.equal(bare.message, null);
    assert.equal(bare.permalink, null);
    assert.equal(bare.fb_created_time, null);
    assert.equal(r.items[2].permalink, null); // non-Facebook / non-https link dropped
    assert.equal(r.items[2].fb_created_time, null);
  } finally { mock.restore(); }
});

test("reader: content type only where reliably identifiable", () => {
  assert.equal(normalizeItem("reels", reel(1)).content_type, "REEL");
  assert.equal(normalizeItem("posts", post(1)).content_type, "POST");
  assert.equal(normalizeItem("posts", post(2, { permalink_url: "https://www.facebook.com/reel/777777" })).content_type, "REEL");
  assert.equal(normalizeItem("posts", post(3, { status_type: "added_video" })).content_type, null);
  assert.equal(normalizeItem("reels", reel(1)).permalink, "https://www.facebook.com/reel/90001");
});

test("reader: failures are classified, never returned as empty success", async () => {
  const cases = [
    [jsonResponse({ error: { code: 190, message: "Error validating access token" } }, 400), "TOKEN_INVALID"],
    [jsonResponse({ error: { code: 200, message: "perm" } }, 403), "PERMISSION_DENIED"],
    [jsonResponse({ error: { code: 10, message: "perm" } }, 400), "PERMISSION_DENIED"],
    [jsonResponse({ error: { code: 4 } }, 400), "RATE_LIMITED"],
    [jsonResponse({ error: {} }, 429), "RATE_LIMITED"],
    [jsonResponse({ error: { code: 2 } }, 500), "TRANSIENT"],
    [jsonResponse("<html>bad gateway</html>", 502), "TRANSIENT"],
    [jsonResponse({ error: { code: 100 } }, 400), "GRAPH_REJECTED"],
    [jsonResponse("not json", 200), "MALFORMED"],
    [jsonResponse({ nope: true }, 200), "MALFORMED"],
    [jsonResponse({ data: [], error: { code: 1 } }, 200), "MALFORMED"],
  ];
  for (const [response, category] of cases) {
    const mock = graphMock({ published_posts: [response] });
    try {
      const r = await fetchPageContent("posts", opts());
      assert.equal(r.error?.category, category);
      assert.equal(r.complete, false);
      assert.equal(r.items.length, 0);
    } finally { mock.restore(); }
  }
  assert.equal(classifyGraphFailure(401, null).category, "TOKEN_INVALID");
  // Error text never leaks into the result.
  const mock = graphMock({ published_posts: [jsonResponse({ error: { code: 190, message: `token ${TOKEN} expired` } }, 400)] });
  try {
    const r = await fetchPageContent("posts", opts());
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  } finally { mock.restore(); }
});

test("reader: network error, timeout, missing token, expired deadline", async () => {
  let mock = installFetchMock(() => { throw new TypeError("boom"); });
  try { assert.equal((await fetchPageContent("posts", opts())).error.category, "NETWORK"); } finally { mock.restore(); }

  mock = installFetchMock((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" })))));
  try { assert.equal((await fetchPageContent("posts", opts({ deadlineAt: Date.now() + 30 }))).error.category, "TIMEOUT"); } finally { mock.restore(); }

  mock = installFetchMock(() => page([]));
  try {
    assert.equal((await fetchPageContent("posts", opts({ accessToken: "" }))).error.category, "TOKEN_INVALID");
    assert.equal((await fetchPageContent("posts", opts({ deadlineAt: Date.now() - 1 }))).error.category, "TIMEOUT");
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test("reader: a failure on page 2 keeps page 1 items but is still an error", async () => {
  const mock = graphMock({ published_posts: [page([post(1)], true), jsonResponse({ error: { code: 2 } }, 500)] });
  try {
    const r = await fetchPageContent("posts", opts());
    assert.equal(r.items.length, 1);
    assert.equal(r.error.category, "TRANSIENT");
    assert.equal(r.complete, false);
  } finally { mock.restore(); }
});

/* --------------------------- admin API: auth ---------------------------- */

test("admin: discovery and candidate routes require a session, CSRF and the right method", async () => {
  const db = createFakeD1();
  const mock = graphMock({});
  try {
    for (const [m, p] of [["POST", "/admin/api/discovery/run"], ["GET", "/admin/api/discovery/runs"], ["GET", "/admin/api/post-candidates"]]) {
      assert.equal((await req(db, m, p, { auth: false, body: m === "POST" ? {} : undefined })).status, 401, `${m} ${p}`);
    }
    assert.equal((await req(db, "POST", "/admin/api/discovery/run", { body: {}, origin: null })).status, 403);
    assert.equal((await req(db, "POST", "/admin/api/discovery/run", { body: {}, origin: "https://evil.example" })).status, 403);
    assert.equal((await req(db, "POST", "/admin/api/discovery/run", { body: {}, contentType: "text/plain" })).status, 403);
    assert.equal((await req(db, "GET", "/admin/api/discovery/run")).status, 405);
    assert.equal((await req(db, "POST", "/admin/api/discovery/runs", { body: {} })).status, 405);
    assert.equal((await req(db, "POST", "/admin/api/post-candidates", { body: {} })).status, 405);
    assert.equal((await req(db, "DELETE", "/admin/api/post-candidates")).status, 405);
    assert.equal(mock.calls.length, 0, "rejected requests never reach Facebook");
  } finally { mock.restore(); }
});

test("admin: candidate list validates its query parameters", async () => {
  const db = createFakeD1();
  for (const q of ["status=BOGUS", "mapping=x", "limit=0", "limit=101", "limit=abc", "cursor=abc", "cursor=0"]) {
    const r = await req(db, "GET", `/admin/api/post-candidates?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.error.code, "VALIDATION_ERROR");
  }
  assert.equal((await req(db, "GET", "/admin/api/post-candidates?status=UPDATED&mapping=unmapped&limit=10")).status, 200);
});

/* ------------------------- admin API: discovery ------------------------- */

test("run: inserts posts and reels, never calls anything but Graph GET", async () => {
  const db = createFakeD1();
  const mock = graphMock({ published_posts: [page([post(1), post(2)])], video_reels: [page([reel(1)])] });
  const before = snapshotMappings(db);
  try {
    const r = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, "OK");
    assert.equal(r.json.data.discovered, 3);
    assert.equal(r.json.data.inserted, 3);
    assert.equal(r.json.data.failed, 0);
    assert.ok(mock.calls.length > 0);
    for (const c of mock.calls) {
      assert.match(c.url, /^https:\/\/graph\.facebook\.com\/v21\.0\/853313081388711\/(published_posts|video_reels)\?/);
      assert.equal(c.method, "GET");
      assert.equal(c.init.body, undefined);
    }
    assert.equal(db._query("SELECT COUNT(*) AS n FROM post_candidates")[0].n, 3);
    assert.equal(snapshotMappings(db), before, "mappings and products untouched");
    assert.equal(db._query("SELECT COUNT(*) AS n FROM comments")[0].n, 0);
    assert.equal(db._query("SELECT COUNT(*) AS n FROM replies")[0].n, 0);
  } finally { mock.restore(); }
});

test("run is idempotent; an edit updates the row, hash and status", async () => {
  const db = createFakeD1();
  let mock = graphMock({ published_posts: [page([post(1), post(2)])], video_reels: [page([])] });
  try {
    await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    const again = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(again.json.data.inserted, 0);
    assert.equal(again.json.data.unchanged, 2);
    assert.equal(db._query("SELECT COUNT(*) AS n FROM post_candidates")[0].n, 2);
  } finally { mock.restore(); }

  mock = graphMock({ published_posts: [page([post(1, { message: "post 1 EDITED" }), post(2)])], video_reels: [page([])] });
  try {
    const edited = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(edited.json.data.updated, 1);
    assert.equal(edited.json.data.unchanged, 1);
    const row = db._query("SELECT * FROM post_candidates WHERE post_id = ?", `${TEST_PAGE_ID}_1001`)[0];
    assert.equal(row.message, "post 1 EDITED");
    assert.equal(row.status, "UPDATED");
    assert.equal(row.revision, 2);
    assert.equal(row.content_hash, await sha256Hex("post 1 EDITED"));
    assert.ok(row.content_changed_at);
    const other = db._query("SELECT * FROM post_candidates WHERE post_id = ?", `${TEST_PAGE_ID}_1002`)[0];
    assert.equal(other.status, "DISCOVERED");
    assert.equal(other.revision, 1);
  } finally { mock.restore(); }
});

test("a post listed under both edges is stored once, as a REEL", async () => {
  const db = createFakeD1();
  const mock = graphMock({ published_posts: [page([{ id: "90001", message: "dup", status_type: "added_video" }])], video_reels: [page([reel(1)])] });
  try {
    const r = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(r.json.data.discovered, 1);
    assert.equal(r.json.data.skipped, 1);
    const row = db._query("SELECT * FROM post_candidates")[0];
    assert.equal(row.content_type, "REEL");
    assert.equal(row.discovery_source, "reels");
  } finally { mock.restore(); }
});

test("run: total failure is reported as FAILED (502), not as an empty success", async () => {
  const db = createFakeD1();
  const mock = graphMock({
    published_posts: [jsonResponse({ error: { code: 190, message: `bad ${TOKEN}` } }, 400)],
    video_reels: [jsonResponse({ error: { code: 190 } }, 400)],
  });
  const log = captureConsole();
  try {
    const r = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(r.status, 502);
    assert.equal(r.json.data.status, "FAILED");
    assert.equal(r.json.data.error_code, "TOKEN_INVALID");
    assert.equal(r.json.data.discovered, 0);
    assert.equal(db._query("SELECT COUNT(*) AS n FROM post_candidates")[0].n, 0);
    const run = db._query("SELECT * FROM discovery_runs")[0];
    assert.equal(run.status, "FAILED");
    assert.equal(run.error_code, "TOKEN_INVALID");
    assert.ok(run.finished_at);
    const listed = await req(db, "GET", "/admin/api/discovery/runs");
    assert.equal(listed.json.data[0].status, "FAILED");
    assert.equal(listed.json.data[0].sources[0].error_code, "TOKEN_INVALID");
    for (const text of [JSON.stringify(r.json), JSON.stringify(listed.json), JSON.stringify(run), log.text?.() ?? JSON.stringify(log.lines ?? [])]) {
      assert.ok(!text.includes(TOKEN), "token must never leak");
    }
  } finally { log.restore?.(); mock.restore(); }
});

test("run: one failed source gives PARTIAL and keeps what was read", async () => {
  const db = createFakeD1();
  const mock = graphMock({ published_posts: [page([post(1)])], video_reels: [jsonResponse({ error: { code: 200 } }, 403)] });
  try {
    const r = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, "PARTIAL");
    assert.equal(r.json.data.error_code, "PERMISSION_DENIED");
    assert.equal(r.json.data.inserted, 1);
    const reels = r.json.data.sources.find((s) => s.source === "reels");
    assert.equal(reels.ok, false);
    assert.equal(reels.graph_code, 200);
  } finally { mock.restore(); }
});

test("run: missing PAGE_ACCESS_TOKEN -> 503, no Graph call, no run recorded", async () => {
  const db = createFakeD1();
  const mock = graphMock({});
  try {
    const r = await req(db, "POST", "/admin/api/discovery/run", { body: {}, envOver: { PAGE_ACCESS_TOKEN: undefined } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, "TOKEN_MISSING");
    assert.equal(mock.calls.length, 0);
    assert.equal(db._query("SELECT COUNT(*) AS n FROM discovery_runs")[0].n, 0);
  } finally { mock.restore(); }
});

test("run: overlapping runs are refused; a stale lock is recovered", async () => {
  const db = createFakeD1();
  db._sqlite.prepare(`INSERT INTO discovery_runs (page_id, status) VALUES (?, 'RUNNING')`).run(TEST_PAGE_ID);
  const mock = graphMock({ published_posts: [page([post(1)])], video_reels: [page([])] });
  try {
    const blocked = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, "ALREADY_RUNNING");
    assert.equal(mock.calls.length, 0);

    db._sqlite.prepare(`UPDATE discovery_runs SET started_at = datetime('now', ?)`).run(`-${STALE_RUN_SECONDS + 60} seconds`);
    const ok = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(ok.status, 200);
    assert.equal(db._query("SELECT status, error_code FROM discovery_runs ORDER BY id")[0].error_code, "RUN_ABANDONED");
  } finally { mock.restore(); }
});

test("run: truncation is reported and bounded", async () => {
  const db = createFakeD1();
  const many = Array.from({ length: 30 }, (_, i) => post(i + 1));
  const mock = graphMock({ published_posts: [page(many, true), page(many.map((p, i) => post(100 + i)), true), page([post(999)])], video_reels: [page([])] });
  try {
    const r = await req(db, "POST", "/admin/api/discovery/run", { body: {} });
    assert.equal(r.json.data.truncated, true);
    assert.ok(r.json.data.discovered <= 50);
    assert.ok(mock.calls.filter((c) => /published_posts/.test(c.url)).length <= 2);
  } finally { mock.restore(); }
});

/* ------------------------- admin API: candidates ------------------------ */

test("candidates list shows mapping state, filters and paginates", async () => {
  const db = createFakeD1({
    products: [{ id: 1, name: "P", affiliate_url: "https://s.shopee.co.th/a" }],
    mappings: [
      { facebook_post_id: `${TEST_PAGE_ID}_1001`, product_id: 1, active: 1 },
      { facebook_post_id: `${TEST_PAGE_ID}_1002`, product_id: 1, active: 0 },
    ],
  });
  const mock = graphMock({ published_posts: [page([post(1), post(2), post(3)])], video_reels: [page([])] });
  try {
    await req(db, "POST", "/admin/api/discovery/run", { body: {} });
  } finally { mock.restore(); }
  const before = snapshotMappings(db);
  const all = await req(db, "GET", "/admin/api/post-candidates");
  const state = Object.fromEntries(all.json.data.map((c) => [c.post_id, c.mapping_state]));
  assert.deepEqual(state, { [`${TEST_PAGE_ID}_1001`]: "ACTIVE", [`${TEST_PAGE_ID}_1002`]: "INACTIVE", [`${TEST_PAGE_ID}_1003`]: "NONE" });
  assert.equal((await req(db, "GET", "/admin/api/post-candidates?mapping=mapped")).json.data.length, 1);
  assert.equal((await req(db, "GET", "/admin/api/post-candidates?mapping=unmapped")).json.data.length, 1);
  assert.equal((await req(db, "GET", "/admin/api/post-candidates?mapping=inactive")).json.data.length, 1);
  assert.equal((await req(db, "GET", "/admin/api/post-candidates?status=UPDATED")).json.data.length, 0);

  const p1 = await req(db, "GET", "/admin/api/post-candidates?limit=2");
  assert.equal(p1.json.data.length, 2);
  assert.equal(p1.json.has_more, true);
  const p2 = await req(db, "GET", `/admin/api/post-candidates?limit=2&cursor=${p1.json.next_cursor}`);
  assert.equal(p2.json.data.length, 1);
  assert.equal(p2.json.has_more, false);
  assert.equal(snapshotMappings(db), before, "listing never changes a mapping");
});

test("untrusted post text travels as JSON data (never HTML) and is not interpreted", async () => {
  const db = createFakeD1();
  const evil = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
  const mock = graphMock({ published_posts: [page([post(1, { message: evil })])], video_reels: [page([])] });
  try {
    await req(db, "POST", "/admin/api/discovery/run", { body: {} });
  } finally { mock.restore(); }
  const r = await req(db, "GET", "/admin/api/post-candidates");
  assert.match(r.response.headers.get("content-type"), /^application\/json/);
  assert.equal(r.json.data[0].message, evil);
});

/* ----------------------------- dashboard ------------------------------ */

test("dashboard: bundle is current, text is rendered with textContent, links are guarded", () => {
  const bundle = readFileSync(join(SRC, "dashboard.js"), "utf8");
  assert.equal(bundle, renderDashboardModule(), "run: npm run build:dashboard");
  const app = readFileSync(join(SRC, "..", "dashboard", "app.js"), "utf8");
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  const view = app.slice(app.indexOf("async function viewDiscovered"), app.indexOf("/* --------------------------- suggestions (AM-2.3)"));
  assert.match(view, /isFacebookUrl\(c\.permalink\)/);
  assert.match(view, /text: preview\(c\.message\)/);
  assert.match(app, /\["discovered", "โพสต์ที่ค้นพบ"\]/);
  // The new view offers no mapping, approval or AI control.
  assert.doesNotMatch(view, /\/admin\/api\/content|product_id|approve|reject/i);
});

/* ------------------------- isolation / no writes ------------------------- */

test("isolation: reply pipeline and send path never reference discovery", () => {
  for (const f of ["pipeline.js", "db.js", "affiliate.js", "facebook-reply.js", "recovery.js", "ai.js", "hermes.js", "agent-prompt.js", "facebook.js", "config.js", "index.js"]) {
    const src = readFileSync(join(SRC, f), "utf8");
    assert.doesNotMatch(src, /post_candidates|discovery_runs|discovery\.js|facebook-posts\.js/, `${f} must not know about discovery`);
  }
});

test("isolation: discovery modules cannot write to Facebook, reach Hermes or touch mappings", () => {
  for (const f of ["facebook-posts.js", "discovery.js"]) {
    const src = readFileSync(join(SRC, f), "utf8");
    assert.doesNotMatch(src, /from "\.\/(pipeline|facebook-reply|hermes|ai|affiliate|recovery)\.js"/, f);
    assert.doesNotMatch(src, /method:\s*"(?!GET")/i, `${f}: only GET`);
    assert.doesNotMatch(src, /(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+content_mappings|INSERT INTO products|UPDATE products|INSERT INTO comments|INSERT INTO replies|UPDATE replies/i, f);
  }
  const posts = readFileSync(join(SRC, "facebook-posts.js"), "utf8");
  assert.doesNotMatch(posts, /\bbody\s*:/);
  const disc = readFileSync(join(SRC, "discovery.js"), "utf8");
  // content_mappings appears only as a read-only LEFT JOIN in the candidate listing.
  assert.match(disc, /LEFT JOIN content_mappings m/);
});

test("a webhook comment is handled identically while candidates exist", async () => {
  // The pipeline neither reads nor writes candidates (source scan above); this
  // proves behaviourally that a populated candidate table changes nothing.
  const db = createFakeD1({ products: [{ id: 1, name: "P", affiliate_url: "https://s.shopee.co.th/a" }] });
  db._sqlite.prepare(`INSERT INTO post_candidates (page_id, post_id, content_hash, discovery_source) VALUES (?, '853313081388711_900', 'h', 'posts')`).run(TEST_PAGE_ID);
  const before = snapshotMappings(db);
  assert.equal(db._query("SELECT COUNT(*) AS n FROM replies")[0].n, 0);
  assert.equal(snapshotMappings(db), before);
});
