/**
 * Phase AM-2.2 -- canonical Reel identity, logical de-duplication, per-edge
 * discovery budget, idempotent backfill. No network, no real Facebook.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import worker from "../src/index.js";
import { issueSession } from "../src/admin.js";
import { canonicalReelIdFromPermalink, normalizeItem, DISCOVERY_EDGE_DEADLINE_MS, DISCOVERY_TOTAL_DEADLINE_MS } from "../src/facebook-posts.js";
import { runDiscovery, listCandidates, backfillCanonicalReelIds } from "../src/discovery.js";
import { resolveConfig } from "../src/config.js";
import { renderDashboardModule } from "../scripts/build-dashboard.mjs";
import { createFakeD1, createEnv, createCtx, installFetchMock, jsonResponse, TEST_PAGE_ID } from "./helpers.js";

const SECRET = "unit-test-admin-session-secret";
const ORIGIN = "https://worker.example";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

function env(db, over = {}) {
  return createEnv({ DB: db, ADMIN_PASSWORD: "pw-unit-test", ADMIN_SESSION_SECRET: SECRET, PAGE_ACCESS_TOKEN: "TEST-ONLY-fake-page-token", ...over });
}
async function req(db, method, path, { body } = {}) {
  const headers = { cookie: `admin_session=${await issueSession(SECRET)}`, origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env(db), createCtx());
  let json = null;
  try { json = await response.clone().json(); } catch { json = null; }
  return { status: response.status, json };
}

const P = TEST_PAGE_ID;
/** Insert a source row directly (a pre-AM-2.2 style row when canonical is omitted). */
function seed(db, { post_id, src = "posts", permalink = null, canonical = null, message = "m", status = "DISCOVERED", type = "REEL" }) {
  db._sqlite
    .prepare(
      `INSERT INTO post_candidates (page_id, post_id, content_type, message, permalink, content_hash, discovery_source, canonical_reel_id, status)
       VALUES (?, ?, ?, ?, ?, 'h', ?, ?, ?)`
    )
    .run(P, post_id, type, message, permalink, src, canonical, status);
}
const reelLink = (id) => `https://www.facebook.com/reel/${id}/`;
const snapshot = (db) => JSON.stringify([db._query("SELECT * FROM content_mappings ORDER BY id"), db._query("SELECT * FROM products ORDER BY id")]);
const PRODUCT = { id: 1, name: "P", affiliate_url: "https://s.shopee.co.th/a" };

/* ------------------------- canonical extraction ------------------------- */

test("canonical id: only an explicit Facebook Reel permalink yields an id", () => {
  const ok = [
    ["https://www.facebook.com/reel/123456", "123456"],
    ["https://www.facebook.com/reel/123456/", "123456"],
    ["https://facebook.com/reel/123456", "123456"],
    ["https://www.facebook.com/reel/123456/?s=single_unit&fs=e", "123456"],
    ["https://www.facebook.com/reel/123456#x", "123456"],
    ["https://WWW.FACEBOOK.COM/reel/1094151903206029/", "1094151903206029"],
  ];
  for (const [url, id] of ok) assert.equal(canonicalReelIdFromPermalink(url), id, url);

  const bad = [
    "https://www.facebook.com/853313081388711/posts/1664601445674952",
    "https://www.facebook.com/853313081388711_1664601445674952",
    "https://www.facebook.com/reel/",
    "https://www.facebook.com/reel/abc",
    "https://www.facebook.com/reel/1234", // too short to be a reel id
    "https://www.facebook.com/reel/123456/extra",
    "https://www.facebook.com/reels/123456",
    "https://www.facebook.com/watch/?v=123456789",
    "http://www.facebook.com/reel/123456",
    "https://evil.example/reel/123456",
    "https://www.facebook.com.evil.example/reel/123456",
    "https://m.facebook.com/reel/123456",
    "https://www.facebook.com:8443/reel/123456",
    "https://user:pw@www.facebook.com/reel/123456",
    "/reel/123456",
    "not a url",
    "",
    null,
    undefined,
    123456,
    { href: "https://www.facebook.com/reel/123456" },
  ];
  for (const url of bad) assert.equal(canonicalReelIdFromPermalink(url), null, String(url));
});

test("canonical id is never fabricated from post ids, text or timestamps", () => {
  const posts = normalizeItem("posts", {
    id: `${P}_1664601445674952`,
    message: "https://www.facebook.com/reel/1663597089107130/ reel 1663597089107130",
    created_time: "2026-09-02T23:27:17+0000",
    permalink_url: `https://www.facebook.com/${P}/posts/1664601445674952`,
    status_type: "added_video",
  });
  assert.equal(posts.canonical_reel_id, null);
  const noLink = normalizeItem("posts", { id: `${P}_1664601445674952`, message: "reel 1663597089107130" });
  assert.equal(noLink.canonical_reel_id, null);
  const bare = normalizeItem("reels", { id: "1663597089107130", description: "x" }); // no permalink
  assert.equal(bare.canonical_reel_id, null, "a bare reels-edge id is not copied into the canonical field");
  assert.equal(bare.post_id, "1663597089107130");
  const withLink = normalizeItem("reels", { id: "1663597089107130", description: "x", permalink_url: "/reel/1663597089107130" });
  assert.equal(withLink.canonical_reel_id, "1663597089107130");
  assert.equal(withLink.post_id, "1663597089107130", "post_id is unchanged");
});

/* ------------------------------ migration ------------------------------- */

test("migration 0005 is additive, nullable and NOT unique", () => {
  const sql = readFileSync(join(ROOT, "..", "database", "migrations", "0005_post_candidates_canonical_reel.sql"), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  assert.match(code, /ALTER TABLE post_candidates ADD COLUMN canonical_reel_id TEXT;/);
  assert.doesNotMatch(code, /\bDROP\b|\bDELETE\b|\bUPDATE\b|\bUNIQUE\b|NOT NULL|content_mappings|\bproducts\b|\bcomments\b|\breplies\b/i);
  const db = createFakeD1();
  const col = db._query("PRAGMA table_info(post_candidates)").find((c) => c.name === "canonical_reel_id");
  assert.ok(col);
  assert.equal(col.notnull, 0);
  // Two source ids may share one canonical id; (page_id, post_id) stays unique.
  seed(db, { post_id: `${P}_1`, canonical: "111111" });
  seed(db, { post_id: "111111", src: "reels", canonical: "111111" });
  assert.throws(() => seed(db, { post_id: `${P}_1`, canonical: "111111" }), /UNIQUE/i);
  const idx = db._query("PRAGMA index_list(post_candidates)").filter((i) => /canonical/.test(i.name));
  assert.equal(idx.length, 1);
  assert.equal(idx[0].unique, 0);
});

/* ----------------------------- logical grouping ------------------------- */

test("grouping: same canonical id = one logical Reel; different or NULL stay separate", async () => {
  const db = createFakeD1();
  seed(db, { post_id: `${P}_11`, src: "posts", permalink: reelLink("111111"), canonical: "111111" });
  seed(db, { post_id: "111111", src: "reels", permalink: reelLink("111111"), canonical: "111111" });
  seed(db, { post_id: "222222", src: "reels", permalink: reelLink("222222"), canonical: "222222" });
  seed(db, { post_id: `${P}_33`, src: "posts", type: "POST", permalink: null });
  seed(db, { post_id: `${P}_34`, src: "posts", type: "POST", permalink: null }); // NULL canonical: not merged with _33
  const items = await listCandidates(db, P, { limit: 50 });
  assert.equal(items.length, 4);
  const twin = items.find((i) => i.canonical_reel_id === "111111");
  assert.equal(twin.source_count, 2);
  assert.deepEqual(twin.source_post_ids, ["111111", `${P}_11`].sort());
  assert.equal(items.filter((i) => i.canonical_reel_id === null).length, 2);
  assert.equal(db._query("SELECT COUNT(*) AS n FROM post_candidates")[0].n, 5, "source rows are preserved");
  // Different pages never group.
  db._sqlite.prepare(`INSERT INTO post_candidates (page_id, post_id, content_hash, discovery_source, canonical_reel_id) VALUES ('999', '111111', 'h', 'reels', '111111')`).run();
  assert.equal((await listCandidates(db, P, { limit: 50 })).length, 4);
});

/* ------------------------- representative rule -------------------------- */

test("representative: 1) a row matching an existing mapping, 2) the posts-edge row, 3) the reels-edge row", async () => {
  const db = createFakeD1({
    products: [PRODUCT],
    mappings: [
      { facebook_post_id: `${P}_11`, product_id: 1, active: 1 }, // case 1: mapping on the posts-edge id
      { facebook_post_id: "444444", product_id: 1, active: 1 }, // mapping on the reels-edge id (exotic): wins by rule 1
    ],
  });
  // Case 1: mapping exists for the posts-edge id.
  seed(db, { post_id: "111111", src: "reels", permalink: reelLink("111111"), canonical: "111111", message: "reels copy" });
  seed(db, { post_id: `${P}_11`, src: "posts", permalink: reelLink("111111"), canonical: "111111", message: "posts copy" });
  // Case 2: no mapping, both edges present -> posts-edge row.
  seed(db, { post_id: "222222", src: "reels", permalink: reelLink("222222"), canonical: "222222" });
  seed(db, { post_id: `${P}_22`, src: "posts", permalink: reelLink("222222"), canonical: "222222" });
  // Case 3: only the reels-edge row.
  seed(db, { post_id: "333333", src: "reels", permalink: reelLink("333333"), canonical: "333333" });
  // Rule 1 beats rule 2: the mapping sits on the reels-edge id.
  seed(db, { post_id: "444444", src: "reels", permalink: reelLink("444444"), canonical: "444444" });
  seed(db, { post_id: `${P}_44`, src: "posts", permalink: reelLink("444444"), canonical: "444444" });

  const items = await listCandidates(db, P, { limit: 50 });
  const by = (c) => items.find((i) => i.canonical_reel_id === c);
  assert.equal(by("111111").representative_post_id, `${P}_11`);
  assert.equal(by("111111").mapping_state, "ACTIVE");
  assert.equal(by("111111").message, "posts copy");
  assert.equal(by("222222").representative_post_id, `${P}_22`);
  assert.equal(by("222222").mapping_state, "NONE");
  assert.equal(by("333333").representative_post_id, "333333");
  assert.equal(by("333333").source_count, 1);
  assert.equal(by("444444").representative_post_id, "444444");
  assert.equal(by("444444").mapping_state, "ACTIVE");
  // No id is invented: every representative id is a stored source id.
  const stored = new Set(db._query("SELECT post_id FROM post_candidates").map((r) => r.post_id));
  for (const i of items) assert.ok(stored.has(i.representative_post_id));
});

test("representative: an active mapping outranks an inactive one in the same group", async () => {
  const db = createFakeD1({
    products: [PRODUCT],
    mappings: [
      { facebook_post_id: `${P}_11`, product_id: 1, active: 0 },
      { facebook_post_id: "111111", product_id: 1, active: 1 },
    ],
  });
  seed(db, { post_id: `${P}_11`, src: "posts", permalink: reelLink("111111"), canonical: "111111" });
  seed(db, { post_id: "111111", src: "reels", permalink: reelLink("111111"), canonical: "111111" });
  const [item] = await listCandidates(db, P, { limit: 5 });
  assert.equal(item.mapping_state, "ACTIVE");
  assert.equal(item.representative_post_id, "111111");
});

/* ----------------------------- backfill --------------------------------- */

test("backfill: fills only NULL rows, is idempotent, leaves post_id and mappings alone", async () => {
  const db = createFakeD1({ products: [PRODUCT], mappings: [{ facebook_post_id: `${P}_11`, product_id: 1, active: 1 }] });
  seed(db, { post_id: `${P}_11`, src: "posts", permalink: reelLink("111111") });
  seed(db, { post_id: "111111", src: "reels", permalink: reelLink("111111") });
  seed(db, { post_id: `${P}_55`, src: "posts", type: "POST", permalink: `https://www.facebook.com/${P}/posts/55` }); // not a reel permalink
  seed(db, { post_id: `${P}_56`, src: "posts", type: "POST", permalink: "https://evil.example/reel/777777" });
  seed(db, { post_id: `${P}_57`, src: "posts", type: "POST", permalink: null });
  seed(db, { post_id: "888888", src: "reels", permalink: reelLink("888888"), canonical: "999999" }); // pre-set value is never overwritten

  const before = snapshot(db);
  const ids = () => db._query("SELECT post_id FROM post_candidates ORDER BY id").map((r) => r.post_id);
  const idsBefore = ids();

  const first = await backfillCanonicalReelIds(db, P);
  assert.equal(first.updated, 2);
  const canon = Object.fromEntries(db._query("SELECT post_id, canonical_reel_id c FROM post_candidates").map((r) => [r.post_id, r.c]));
  assert.equal(canon[`${P}_11`], "111111");
  assert.equal(canon["111111"], "111111");
  assert.equal(canon[`${P}_55`], null);
  assert.equal(canon[`${P}_56`], null);
  assert.equal(canon[`${P}_57`], null);
  assert.equal(canon["888888"], "999999");

  const second = await backfillCanonicalReelIds(db, P);
  assert.equal(second.updated, 0, "idempotent");
  assert.deepEqual(ids(), idsBefore, "post_id unchanged, no rows deleted or added");
  assert.equal(snapshot(db), before, "mappings and products unchanged");
  assert.equal(db._query("SELECT COUNT(*) AS n FROM post_candidates")[0].n, 6);
});

/* ------------------------------ admin API ------------------------------- */

test("API: duplicates are collapsed, the mapped state is preserved, group_id is not exposed", async () => {
  const db = createFakeD1({ products: [PRODUCT], mappings: [{ facebook_post_id: `${P}_11`, product_id: 1, active: 1 }] });
  seed(db, { post_id: "111111", src: "reels", permalink: reelLink("111111"), canonical: "111111" });
  seed(db, { post_id: `${P}_11`, src: "posts", permalink: reelLink("111111"), canonical: "111111" });
  seed(db, { post_id: "222222", src: "reels", permalink: reelLink("222222"), canonical: "222222" });
  const before = snapshot(db);
  const r = await req(db, "GET", "/admin/api/post-candidates");
  assert.equal(r.status, 200);
  assert.equal(r.json.data.length, 2);
  const mapped = r.json.data.find((i) => i.canonical_reel_id === "111111");
  assert.equal(mapped.mapping_state, "ACTIVE");
  assert.equal(mapped.post_id, `${P}_11`);
  assert.equal(mapped.source_count, 2);
  assert.deepEqual(mapped.source_post_ids, ["111111", `${P}_11`].sort());
  assert.equal(mapped.permalink, reelLink("111111"));
  for (const item of r.json.data) {
    assert.ok(!("group_id" in item) && !("rn" in item) && !("gkey" in item));
  }
  assert.equal(snapshot(db), before);
});

test("API: pagination and filters operate on logical items", async () => {
  const db = createFakeD1({ products: [PRODUCT], mappings: [{ facebook_post_id: `${P}_20`, product_id: 1, active: 1 }] });
  // 5 logical items from 8 source rows; the mapped one has two sources.
  for (const n of [10, 20, 30]) {
    seed(db, { post_id: `${n}0000${n}`, src: "reels", permalink: reelLink(`${n}0000${n}`), canonical: `${n}0000${n}` });
    seed(db, { post_id: `${P}_${n}`, src: "posts", permalink: reelLink(`${n}0000${n}`), canonical: `${n}0000${n}` });
  }
  seed(db, { post_id: "5000050", src: "reels", permalink: reelLink("5000050"), canonical: "5000050", status: "UPDATED" });
  seed(db, { post_id: `${P}_60`, src: "posts", type: "POST" });

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await req(db, "GET", `/admin/api/post-candidates?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(r.status, 200);
    seen.push(...r.json.data.map((i) => i.canonical_reel_id ?? i.post_id));
    cursor = r.json.next_cursor;
    pages += 1;
    assert.ok(pages < 10);
  } while (cursor);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5, "no logical item repeated or skipped across pages");
  assert.equal(pages, 3);

  const all = (q) => req(db, "GET", `/admin/api/post-candidates?${q}`).then((r) => r.json.data);
  assert.equal((await all("mapping=mapped")).length, 1);
  assert.equal((await all("mapping=unmapped")).length, 4, "the mapped group's unmapped twin is not listed separately");
  assert.equal((await all("mapping=inactive")).length, 0);
  assert.equal((await all("status=UPDATED")).length, 1);
  assert.equal((await all("status=DISCOVERED&mapping=unmapped")).length, 3);
});

test("API: untrusted text is still plain JSON data", async () => {
  const db = createFakeD1();
  const evil = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
  seed(db, { post_id: "111111", src: "reels", permalink: reelLink("111111"), canonical: "111111", message: evil });
  const r = await req(db, "GET", "/admin/api/post-candidates");
  assert.equal(r.json.data[0].message, evil);
});

test("dashboard bundle is current and shows provenance as text only", () => {
  assert.equal(readFileSync(join(SRC, "dashboard.js"), "utf8"), renderDashboardModule(), "run: npm run build:dashboard");
  const app = readFileSync(join(ROOT, "dashboard", "app.js"), "utf8");
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.match(app, /Number\(c\.source_count\) > 1/);
  const view = app.slice(app.indexOf("async function viewDiscovered"), app.indexOf("/* ----------------------------- activity"));
  assert.doesNotMatch(view, /\/admin\/api\/content|product_id|approve|reject|canonical_reel_id/i);
});

/* ------------------------------ discovery ------------------------------- */

const reelsItem = (id, extra = {}) => ({ id: String(id), description: `reel ${id}`, created_time: "2026-09-21T10:00:00+0000", permalink_url: `/reel/${id}`, ...extra });
const postItem = (n, bare) => ({
  id: `${P}_${n}`, message: `reel ${bare}`, created_time: "2026-09-22T10:00:00+0000",
  permalink_url: `https://www.facebook.com/reel/${bare}/`, status_type: "added_video",
});
const page = (items) => jsonResponse({ data: items });
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" }))));

function edgeMock({ reels, posts }) {
  return installFetchMock((url, init) => {
    const edge = /\/(published_posts|video_reels)\?/.exec(url)?.[1];
    const handler = edge === "video_reels" ? reels : posts;
    return handler(init);
  });
}
const cfg = () => resolveConfig(createEnv());

test("discovery: canonical id is populated at ingest, post_id is the Graph id, twins are both kept", async () => {
  const db = createFakeD1();
  const mock = edgeMock({ reels: () => page([reelsItem(1663597089107130)]), posts: () => page([postItem(1664601445674952, 1663597089107130)]) });
  try {
    const result = await runDiscovery({ db, env: env(db), config: cfg() });
    assert.equal(result.summary.status, "OK");
    assert.equal(result.summary.inserted, 2);
    const rows = db._query("SELECT post_id, canonical_reel_id, discovery_source FROM post_candidates ORDER BY id");
    assert.deepEqual(rows.map((r) => r.post_id).sort(), ["1663597089107130", `${P}_1664601445674952`].sort());
    assert.ok(rows.every((r) => r.canonical_reel_id === "1663597089107130"));
    const items = await listCandidates(db, P, { limit: 10 });
    assert.equal(items.length, 1);
    assert.equal(items[0].representative_post_id, `${P}_1664601445674952`);
    for (const c of mock.calls) { assert.equal(c.method, "GET"); assert.equal(c.init.body, undefined); }
  } finally { mock.restore(); }
});

test("discovery: an edited post keeps its canonical id; a later run heals pre-AM-2.2 rows", async () => {
  const db = createFakeD1();
  seed(db, { post_id: "1663597089107130", src: "reels", permalink: reelLink("1663597089107130") }); // NULL canonical (pre-AM-2.2)
  const mock = edgeMock({ reels: () => page([reelsItem(1663597089107130)]), posts: () => page([]) });
  try {
    await runDiscovery({ db, env: env(db), config: cfg() });
    assert.equal(db._query("SELECT canonical_reel_id c FROM post_candidates")[0].c, "1663597089107130");
  } finally { mock.restore(); }
});

test("discovery budget: a slow edge times out on its own and does not starve the other", async () => {
  const db = createFakeD1();
  const mock = edgeMock({ reels: (init) => hang(init), posts: () => page([postItem(1664601445674952, 1663597089107130)]) });
  try {
    const t0 = Date.now();
    const result = await runDiscovery({ db, env: env(db), config: cfg(), budget: { edgeDeadlineMs: 80, totalDeadlineMs: 5000 } });
    const elapsed = Date.now() - t0;
    assert.equal(result.summary.status, "PARTIAL");
    const reels = result.summary.sources.find((s) => s.source === "reels");
    const posts = result.summary.sources.find((s) => s.source === "posts");
    assert.equal(reels.ok, false);
    assert.equal(reels.error_code, "TIMEOUT");
    assert.equal(posts.ok, true);
    assert.equal(posts.items, 1);
    assert.equal(result.summary.inserted, 1);
    assert.ok(elapsed < 2000, `elapsed ${elapsed}`);
    assert.equal(mock.calls.length, 2, "one request per edge: no retry");
  } finally { mock.restore(); }
});

test("discovery budget: the total deadline bounds the whole run and nothing is retried", async () => {
  const db = createFakeD1();
  const mock = edgeMock({ reels: (init) => hang(init), posts: (init) => hang(init) });
  try {
    const t0 = Date.now();
    const result = await runDiscovery({ db, env: env(db), config: cfg(), budget: { edgeDeadlineMs: 150, totalDeadlineMs: 200 } });
    const elapsed = Date.now() - t0;
    assert.equal(result.summary.status, "FAILED");
    assert.equal(result.summary.error_code, "TIMEOUT");
    assert.ok(elapsed < 1000, `elapsed ${elapsed}`);
    assert.ok(mock.calls.length <= 2);
    assert.equal(db._query("SELECT COUNT(*) AS n FROM post_candidates")[0].n, 0);
  } finally { mock.restore(); }

  // An edge deadline larger than the total is clamped to the total: the second edge never starts.
  const mock2 = edgeMock({ reels: (init) => hang(init), posts: () => page([postItem(1, 1111111)]) });
  try {
    const t0 = Date.now();
    const result = await runDiscovery({ db: createFakeD1(), env: env(db), config: cfg(), budget: { edgeDeadlineMs: 5000, totalDeadlineMs: 100 } });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(result.summary.sources.find((s) => s.source === "posts").error_code, "TIMEOUT");
    assert.equal(mock2.calls.length, 1);
  } finally { mock2.restore(); }
});

test("discovery budget: production defaults are bounded and per-edge", () => {
  assert.ok(DISCOVERY_EDGE_DEADLINE_MS > 0);
  assert.ok(DISCOVERY_TOTAL_DEADLINE_MS >= DISCOVERY_EDGE_DEADLINE_MS * 2, "two full edges fit in the total");
  assert.ok(DISCOVERY_TOTAL_DEADLINE_MS <= 60000, "hard outer bound");
});

/* ------------------------------ isolation ------------------------------- */

test("isolation: the reply path still does not know about discovery or canonical ids", () => {
  for (const f of ["pipeline.js", "db.js", "affiliate.js", "facebook-reply.js", "recovery.js", "ai.js", "hermes.js", "facebook.js", "config.js", "index.js"]) {
    const src = readFileSync(join(SRC, f), "utf8");
    assert.doesNotMatch(src, /post_candidates|discovery_runs|canonical_reel_id|discovery\.js|facebook-posts\.js/, f);
  }
  for (const f of ["discovery.js", "facebook-posts.js"]) {
    const src = readFileSync(join(SRC, f), "utf8");
    assert.doesNotMatch(src, /(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+content_mappings/i, f);
    assert.doesNotMatch(src, /method:\s*"(?!GET")/i, f);
  }
});
