import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";
import { issueSession } from "../src/admin.js";
import { dailyStats, searchComments, commentDetail, postPerformance, productPerformance, localDay } from "../src/admin-db.js";
import { createFakeD1, createEnv, createCtx, TEST_PAGE_ID } from "./helpers.js";

const P = TEST_PAGE_ID;
const NOW = new Date("2026-10-12T10:00:00Z"); // 17:00 in Bangkok

function seed() {
  const db = createFakeD1({
    products: [{ id: 1, name: "หัวชาร์จ", affiliate_url: "https://s.shopee.co.th/a" }, { id: 2, name: "สายชาร์จ", affiliate_url: "https://s.shopee.co.th/b" }],
    mappings: [{ facebook_post_id: `${P}_1`, product_id: 1 }],
  });
  const c = db._sqlite.prepare(`INSERT INTO comments (facebook_comment_id, facebook_post_id, page_id, author_id, author_name, comment_text, status, ai_action, matched_product_id, facebook_post_permalink, created_at)
    VALUES (?, ?, ?, 'AUTHOR-SECRET-ID', ?, ?, ?, ?, ?, ?, ?)`);
  const r = db._sqlite.prepare(`INSERT INTO replies (comment_id, response_text, mode, status, affiliate_url, facebook_reply_id, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  // id 1: today local (2026-10-12 08:00 Bangkok = 01:00Z), sent with link
  c.run("1_101", `${P}_1`, P, "สมชาย", "ขอพิกัดครับ", "REPLIED", "REPLY", 1, "https://www.facebook.com/x/posts/1", "2026-10-12 01:00:00");
  r.run(1, "ร่าง", "DRY_RUN", "GENERATED", "https://s.shopee.co.th/a", null, null, "2026-10-12 01:00:01");
  r.run(1, "ส่งแล้ว", "LIVE", "SENT", "https://s.shopee.co.th/a", "1_9001", null, "2026-10-12 01:00:05");
  // id 2: 2026-10-11 23:30Z = 2026-10-12 06:30 Bangkok -> also "today" locally
  c.run("1_102", `${P}_1`, P, "Nok", "ราคา 100% ไหม", "ERROR", "REPLY", 1, null, "2026-10-11 23:30:00");
  r.run(2, "x", "LIVE", "GENERATED", null, null, "GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT", "2026-10-11 23:30:05");
  // id 3: 2026-10-11 16:00Z = 23:00 Bangkok on the 11th
  c.run("2_201", `${P}_2`, P, "มะลิ", "สนใจค่ะ", "SKIPPED", "SKIP", null, null, "2026-10-11 16:00:00");
  // other page -- must never appear
  c.run("9_901", "999_9", "999", "Other", "ขอพิกัดครับ", "REPLIED", "REPLY", 1, null, "2026-10-12 01:00:00");
  return db;
}

test("U3 dailyStats: zero-filled local (UTC+7) days, oldest first, page-scoped", async () => {
  const db = seed();
  assert.equal(localDay(NOW), "2026-10-12");
  const rows = await dailyStats(db, P, 7, NOW);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].day, "2026-10-06");
  assert.equal(rows[6].day, "2026-10-12");
  assert.deepEqual(rows[6], { day: "2026-10-12", comments: 2, ai_replies: 2, errors: 1, sent: 1, sent_with_link: 1 });
  assert.deepEqual(rows[5], { day: "2026-10-11", comments: 1, ai_replies: 0, errors: 0, sent: 0, sent_with_link: 0 });
  assert.ok(rows.slice(0, 5).every((r) => r.comments === 0 && r.sent === 0));
});

test("U4 searchComments: text/author/id, LIKE wildcards are literal, status, dates, post, cursor; no author_id", async () => {
  const db = seed();
  const s = (o) => searchComments(db, { pageId: P, limit: 50, ...o });
  assert.deepEqual((await s({ q: "พิกัด" })).map((r) => r.id), [1], "other page excluded");
  assert.deepEqual((await s({ q: "Nok" })).map((r) => r.id), [2]);
  assert.deepEqual((await s({ q: "2_201" })).map((r) => r.id), [3]);
  assert.deepEqual((await s({ q: "100%" })).map((r) => r.id), [2], "% is literal");
  assert.deepEqual((await s({ q: "%" })).map((r) => r.id), [2]);
  assert.deepEqual((await s({ q: "_" })).map((r) => r.id), [], "_ is literal: no comment text contains it (ids are matched exactly, not by LIKE)");
  assert.deepEqual((await s({ status: "ERROR" })).map((r) => r.id), [2]);
  assert.deepEqual((await s({ from: "2026-10-12" })).map((r) => r.id), [2, 1], "local day from");
  assert.deepEqual((await s({ to: "2026-10-11" })).map((r) => r.id), [3], "local day to (inclusive)");
  assert.deepEqual((await s({ postId: `${P}_1` })).map((r) => r.id), [2, 1]);
  assert.deepEqual((await s({ beforeId: 2 })).map((r) => r.id), [1]);
  const one = (await s({ q: "พิกัด" }))[0];
  assert.equal(one.reply.status, "SENT", "latest reply");
  assert.equal(one.matched_product.name, "หัวชาร์จ");
  assert.ok(!JSON.stringify(await s({})).includes("AUTHOR-SECRET-ID"));
});

test("U6 commentDetail: full reply history in order, mapping, page-scoped, no author_id", async () => {
  const db = seed();
  const d = await commentDetail(db, P, 1);
  assert.equal(d.replies.length, 2);
  assert.deepEqual(d.replies.map((r) => r.mode + ":" + r.status), ["DRY_RUN:GENERATED", "LIVE:SENT"]);
  assert.equal(d.replies[1].facebook_reply_id, "1_9001");
  assert.equal(d.mapping.product_name, "หัวชาร์จ");
  assert.equal(d.mapping.product_usable, true);
  assert.equal(d.facebook_post_permalink, "https://www.facebook.com/x/posts/1");
  assert.ok(!JSON.stringify(d).includes("AUTHOR-SECRET-ID"));
  assert.equal(await commentDetail(db, P, 4), null, "another page's comment is not visible");
  assert.equal(await commentDetail(db, P, 999), null);
});

test("U5 post and product performance", async () => {
  const db = seed();
  const posts = await postPerformance(db, P);
  assert.deepEqual(posts.map((p) => p.post_id), [`${P}_1`, `${P}_2`]);
  const p1 = posts[0];
  assert.equal(p1.comments, 2); assert.equal(p1.ai_replies, 2); assert.equal(p1.errors, 1);
  assert.equal(p1.sent, 1); assert.equal(p1.sent_with_link, 1);
  assert.equal(p1.product_name, "หัวชาร์จ"); assert.equal(p1.mapping_active, 1);
  assert.equal(p1.permalink, "https://www.facebook.com/x/posts/1");
  assert.equal(posts[1].product_name, null);
  const prods = await productPerformance(db, P);
  const a = prods.find((x) => x.product_id === 1);
  assert.deepEqual({ m: a.mapped_posts, c: a.comments, r: a.ai_replies, s: a.sent, l: a.sent_with_link }, { m: 1, c: 2, r: 2, s: 1, l: 1 }, "other page's comment not counted");
  assert.equal(prods.find((x) => x.product_id === 2).comments, 0);
});

/* --------------------------------- API --------------------------------- */
const SECRET = "unit-test-admin-session-secret";
const ORIGIN = "https://worker.example";
async function get(db, path) {
  const res = await worker.fetch(new Request(ORIGIN + path, { headers: { cookie: `admin_session=${await issueSession(SECRET)}`, origin: ORIGIN } }),
    createEnv({ DB: db, ADMIN_PASSWORD: "pw", ADMIN_SESSION_SECRET: SECRET }), createCtx());
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

test("U3-U6 API: routes, validation and read-only behaviour", async () => {
  const db = seed();
  const before = db._statements.length;
  const d = await get(db, "/admin/api/stats/daily?days=7");
  assert.equal(d.status, 200); assert.equal(d.json.data.length, 7); assert.equal(d.json.timezone, "Asia/Bangkok");
  assert.equal((await get(db, "/admin/api/stats/daily?days=8")).status, 400);
  assert.equal((await get(db, "/admin/api/stats/posts")).status, 200);
  assert.equal((await get(db, "/admin/api/stats/products")).status, 200);
  assert.equal((await get(db, "/admin/api/stats/nope")).status, 404);

  const page1 = await get(db, "/admin/api/comments?limit=2");
  assert.equal(page1.status, 200);
  assert.deepEqual(page1.json.data.map((r) => r.id), [3, 2]);
  assert.equal(page1.json.has_more, true);
  const page2 = await get(db, "/admin/api/comments?limit=2&cursor=" + page1.json.next_cursor);
  assert.deepEqual(page2.json.data.map((r) => r.id), [1]);
  assert.equal(page2.json.has_more, false);
  assert.equal((await get(db, "/admin/api/comments?q=" + "x".repeat(101))).status, 400);
  assert.equal((await get(db, "/admin/api/comments?status=BAD")).status, 400);
  assert.equal((await get(db, "/admin/api/comments?from=12-10-2026")).status, 400);
  assert.equal((await get(db, "/admin/api/comments?post=abc")).status, 400);
  assert.equal((await get(db, "/admin/api/comments?limit=500")).status, 400);
  assert.equal((await get(db, "/admin/api/comments?cursor=x")).status, 400);

  const det = await get(db, "/admin/api/comments/1");
  assert.equal(det.status, 200); assert.equal(det.json.data.replies.length, 2);
  assert.equal((await get(db, "/admin/api/comments/4")).status, 404, "other page");
  assert.equal((await get(db, "/admin/api/comments/abc")).status, 404);
  const writes = db._statements.slice(before).filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));
  assert.equal(writes.length, 0, "every insight route is read-only");
});

test("U3-U6 dashboard: trend chart, search, drawer, performance tab; text only", () => {
  const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.match(app, /"\/admin\/api\/stats\/daily\?days="/);
  assert.match(app, /function trendChart\(/);
  assert.match(app, /function trendTable\(/, "a table view exists for the chart");
  assert.match(app, /class: "legend"/, "legend for >= 2 series");
  assert.match(app, /ArrowRight/, "keyboard access to the chart");
  assert.match(app, /"\/admin\/api\/comments\?" \+ qs/, "activity uses the search API");
  for (const p of ['qs.set("q"', 'qs.set("from"', 'qs.set("to"', 'qs.set("post"']) assert.ok(app.includes(p), p);
  assert.match(app, /async function openComment\(id\)/);
  assert.match(app, /"\/admin\/api\/comments\/" \+ id/);
  assert.match(app, /\["performance", "ผลงาน"\]/);
  assert.match(app, /"\/admin\/api\/stats\/posts"/);
  assert.match(app, /goTo\("activity", \{ post: r\.post_id \}\)/, "post counts link to the filtered activity");
  const css = readFileSync(new URL("../dashboard/app.css", import.meta.url), "utf8");
  assert.match(css, /--s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a;/, "validated light series");
  assert.match(css, /--s1: #3987e5; --s2: #d95926; --s3: #199e70;/, "validated dark series");
});
