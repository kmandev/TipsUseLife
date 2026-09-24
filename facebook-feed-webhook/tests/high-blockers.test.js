/**
 * Regression tests for the two HIGH findings of the final pre-push audit:
 *   1. the AI must never be able to output a bare domain (any TLD, any script);
 *   2. an affiliate link may only come from the product explicitly mapped
 *      to the current post/reel -- never from keyword matching.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { validateAgentResponse, DOMAIN_SHAPE_PATTERN } from "../src/ai.js";
import { createFakeD1, createEnv, createCtx, commentPayload, signedRequest, installFetchMock, hermesChat } from "./helpers.js";

/* ============================ Blocker 1 ============================ */

const reply = (reply_text) => validateAgentResponse({ action: "REPLY", reply_text, include_affiliate_cta: false });

test("HIGH-1: bare domains on any TLD are rejected", () => {
  for (const t of [
    "evil.xyz", "promo.info", "shop-now.online", "go.store", "evil.top/pay", "ร้าน.ไทย",
    "example.co.uk", "foo.bar", "foo.dev", "foo.ai", "foo.xyz", "EVIL.XYZ",
    "สั่งที่ evil.xyz ได้เลยครับ", "กดที่ go.store/abc นะครับ",
  ]) {
    assert.equal(reply(t).reason, "AI_RESPONSE_INVENTED_URL", t);
  }
});

test("HIGH-1: unicode, IDN, punycode and dot look-alike domains are rejected", () => {
  for (const t of [
    "xn--shope-9ze.co.th",     // punycode label
    "example.xn--o3cw4h",      // punycode TLD (.ไทย)
    "shоpee.co.th",            // Cyrillic о homograph
    "evil。xyz",           // ideographic full stop
    "evil．xyz",           // full-width full stop
    "evil｡xyz",           // half-width ideographic full stop
    "evil​.xyz",          // zero-width space inside
    "ตัวอย่าง.คอม",             // Thai labels
  ]) {
    assert.equal(reply(t).reason, "AI_RESPONSE_INVENTED_URL", JSON.stringify(t));
  }
});

test("HIGH-1: explicit URLs, schemes, scheme-relative links and IPs are still rejected", () => {
  for (const t of [
    "https://evil.com", "http://evil.com", "www.evil.com", "//evil.com", "evil.com/path",
    "javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "192.168.1.1",
  ]) {
    assert.equal(reply(t).reason, "AI_RESPONSE_INVENTED_URL", t);
  }
});

test("HIGH-1: ordinary Thai text with dots is not mistaken for a domain", () => {
  for (const t of ["A.I.", "v1.2", "3.14", "รุ่น 2.0", "ราคา 99.90 บาท", "ลด 20%", "e.g. ตัวนี้", "ขนาด 1.5 ม.", "ครับ... ค่ะ", "Ver. 2"]) {
    assert.equal(DOMAIN_SHAPE_PATTERN.test(t), false, `detector false positive: ${t}`);
    const r = reply(t);
    assert.notEqual(r.reason, "AI_RESPONSE_INVENTED_URL", `validator false positive: ${t}`);
  }
  // Non-price cases are accepted outright.
  for (const t of ["A.I. ช่วยตอบครับ", "รุ่น 2.0 ครับ", "ได้เลยครับ 👇 กดดูสินค้าได้ที่นี่ครับ", "ขอบคุณครับ 😊"]) {
    assert.equal(reply(t).ok, true, t);
  }
});

test("HIGH-1: a bare domain from the AI never reaches D1 or Facebook (end to end)", async () => {
  const db = createFakeD1({
    products: [{ id: 1, name: "หัวชาร์จ", affiliate_url: "https://s.shopee.co.th/a" }],
    mappings: [{ facebook_post_id: "853313081388711_900", product_id: 1 }],
  });
  const ctx = createCtx();
  const mock = installFetchMock((url) =>
    /graph\.facebook\.com/.test(url) ? assert.fail("no Graph call") : hermesChat({ action: "REPLY", reply_text: "สั่งที่ evil.top/pay ได้เลยครับ", include_affiliate_cta: true })
  );
  try {
    await worker.fetch(await signedRequest(commentPayload({ value: { message: "ขอพิกัด" } })), createEnv({ DB: db, REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "t" }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
  }
  assert.equal(mock.graphCalls().length, 0);
  const [r] = db._state.replies;
  assert.equal(r.status, "SKIPPED");
  assert.equal(r.error_message, "AI_RESPONSE_INVENTED_URL");
  assert.ok(!JSON.stringify(db._state).includes("evil.top"), "the domain is not stored anywhere");
});

/* ============================ Blocker 2 ============================ */

const POST_A = "853313081388711_900";
const POST_B = "853313081388711_901";
const URL_A = "https://s.shopee.co.th/product-a";
const URL_B = "https://s.shopee.co.th/product-b";
const CATALOG = [
  { id: 1, name: "หัวชาร์จ Anker", keywords: "หัวชาร์จ, ชาร์จเร็ว", affiliate_url: URL_A },
  { id: 2, name: "หูฟัง", keywords: "หูฟัง", affiliate_url: URL_B },
];
const CTA = { action: "REPLY", reply_text: "ได้เลยครับ 👇 กดดูสินค้าได้ที่นี่ครับ", include_affiliate_cta: true };
const TEXT_ONLY = { action: "REPLY", reply_text: "เดี๋ยวแอดมินแจ้งรายละเอียดให้นะครับ", include_affiliate_cta: false };

let seq = 3000;
async function comment(db, { post, message, agent = CTA }) {
  const ctx = createCtx();
  const seen = [];
  const mock = installFetchMock((url, init) => {
    seen.push(init);
    return hermesChat(agent);
  });
  try {
    const id = `853313081388711_${seq++}`;
    const payload = commentPayload({ value: { comment_id: id, post_id: post, message, from: { id: `author-${seq}`, name: "A" } } });
    await worker.fetch(await signedRequest(payload), createEnv({ DB: db }), ctx);
    await ctx.settle();
    const row = db._query("SELECT * FROM comments WHERE facebook_comment_id = ?", id)[0];
    const rep = db._query("SELECT * FROM replies WHERE comment_id = ?", row.id)[0];
    const sentToAi = JSON.parse(JSON.parse(seen[0].body).messages[1].content);
    return { row, rep, sentToAi };
  } finally {
    mock.restore();
  }
}

test("HIGH-2 A: mapped post -> its product and its link", async () => {
  const db = createFakeD1({ products: CATALOG, mappings: [{ facebook_post_id: POST_A, product_id: 1 }] });
  const { row, rep } = await comment(db, { post: POST_A, message: "ขอพิกัดครับ" });
  assert.equal(row.product_source, "MAPPING");
  assert.equal(row.matched_product_id, 1);
  assert.equal(rep.affiliate_url, URL_A);
  assert.ok(rep.response_text.endsWith(`\n${URL_A}`));
});

test("HIGH-2 B: unmapped post + 'ขอพิกัดครับ' -> no product, no link", async () => {
  const db = createFakeD1({ products: CATALOG });
  const { row, rep, sentToAi } = await comment(db, { post: POST_B, message: "ขอพิกัดครับ" });
  assert.equal(sentToAi.product, null);
  assert.equal(sentToAi.affiliate_link_available, false);
  assert.equal(row.matched_product_id, null);
  assert.equal(rep.affiliate_url, null);
  // The AI may still answer in plain text.
  const text = await comment(db, { post: POST_B, message: "ขอพิกัดครับ", agent: TEXT_ONLY });
  assert.equal(text.rep.status, "GENERATED");
  assert.equal(text.rep.affiliate_url, null);
  assert.ok(!/https?:\/\//.test(text.rep.response_text));
});

test("HIGH-2 C: unmapped post naming a catalog keyword -> still no link", async () => {
  const db = createFakeD1({ products: CATALOG });
  const { row, rep, sentToAi } = await comment(db, { post: POST_B, message: "หัวชาร์จยี่ห้ออะไรครับ" });
  assert.equal(sentToAi.product, null, "the keyword-matched product is not even offered to the AI");
  assert.equal(row.product_source, "NONE");
  assert.equal(rep.affiliate_url, null);
});

test("HIGH-2 D: mapped product disabled or deleted -> no link, no fallback", async () => {
  for (const state of [{ active: 0 }, { deleted_at: "2026-09-24 00:00:00" }]) {
    const db = createFakeD1({
      products: [{ ...CATALOG[0], ...state }, CATALOG[1]],
      mappings: [{ facebook_post_id: POST_A, product_id: 1 }],
    });
    const { row, rep } = await comment(db, { post: POST_A, message: "หัวชาร์จ หูฟัง ขอพิกัด" });
    assert.equal(row.matched_product_id, null, JSON.stringify(state));
    assert.equal(rep.affiliate_url, null, JSON.stringify(state));
  }
});

test("HIGH-2 E: a changed mapping takes effect on the next comment", async () => {
  const db = createFakeD1({ products: CATALOG, mappings: [{ facebook_post_id: POST_A, product_id: 1 }] });
  assert.equal((await comment(db, { post: POST_A, message: "ขอพิกัด" })).rep.affiliate_url, URL_A);
  db._sqlite.prepare("UPDATE content_mappings SET product_id = 2 WHERE facebook_post_id = ?").run(POST_A);
  const next = await comment(db, { post: POST_A, message: "ขอพิกัด" });
  assert.equal(next.row.matched_product_id, 2);
  assert.equal(next.rep.affiliate_url, URL_B);
});

test("HIGH-2 F: two products sharing a keyword on an unmapped post -> no link", async () => {
  const db = createFakeD1({
    products: [
      { id: 1, name: "เครื่องตัด A", keywords: "เครื่องตัด", affiliate_url: URL_A },
      { id: 2, name: "เครื่องตัด B", keywords: "เครื่องตัด", affiliate_url: URL_B },
    ],
  });
  const { rep } = await comment(db, { post: POST_B, message: "เครื่องตัดตัวนี้ ขอพิกัด" });
  assert.equal(rep.affiliate_url, null);
});

test("INVARIANT: every stored affiliate_url belongs to the active product mapped to that comment's post", async () => {
  const db = createFakeD1({ products: CATALOG, mappings: [{ facebook_post_id: POST_A, product_id: 1 }] });
  for (const [post, message] of [[POST_A, "ขอพิกัด"], [POST_B, "หัวชาร์จ ขอพิกัด"], [POST_B, "หูฟัง ขอลิงก์"], [POST_A, "หูฟัง ขอลิงก์"]]) {
    await comment(db, { post, message });
  }
  const rows = db._query(`
    SELECT r.affiliate_url, c.facebook_post_id, c.page_id,
           (SELECT COALESCE(p.affiliate_url, p.shopee_url) FROM content_mappings m JOIN products p ON p.id = m.product_id
             WHERE m.facebook_page_id = c.page_id AND m.facebook_post_id = c.facebook_post_id
               AND m.active = 1 AND p.active = 1 AND p.deleted_at IS NULL) AS mapped_url
      FROM replies r JOIN comments c ON c.id = r.comment_id
     WHERE r.affiliate_url IS NOT NULL`);
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.equal(r.affiliate_url, r.mapped_url, `link on ${r.facebook_post_id} is not its mapped product's`);
  assert.equal(db._query("SELECT COUNT(*) n FROM replies r JOIN comments c ON c.id = r.comment_id WHERE c.facebook_post_id = ? AND r.affiliate_url IS NOT NULL", POST_B)[0].n, 0);
});
