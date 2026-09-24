/**
 * Phase 6 -- LIVE-readiness hardening.
 *   1. /admin/login throttling (Cloudflare rate-limit binding, fail-open).
 *   2. Unicode compatibility-form domains (NFKC, U+2024, U+FE52, spaced dot).
 *   3. Affiliate URLs: default HTTPS port only.
 *   4. Dashboard copy: mapping is the only product source.
 *   5. Dead keyword matcher is gone.
 * No network, no Facebook, no real credentials.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import worker from "../src/index.js";
import * as db from "../src/db.js";
import { validateAgentResponse, linkProbeVariants, SPACED_DOT_DOMAIN_PATTERN } from "../src/ai.js";
import { validateAffiliateUrl, isUsableProduct } from "../src/affiliate.js";
import { DASHBOARD_JS } from "../src/dashboard.js";
import { createFakeD1, createEnv, createCtx, commentPayload, signedRequest, installFetchMock, hermesChat, captureConsole } from "./helpers.js";
import { TEST_ADMIN_PASSWORD, createAdminEnv, createAdminFakeD1, adminPost } from "./admin-helpers.js";

/* ============================ 1. login throttling ============================ */

/** Deterministic stand-in for the Workers rate-limit binding. */
function fakeLimiter(limit) {
  const counts = new Map();
  const keys = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

function loginFrom(ip, password) {
  const req = adminPost("/admin/login", { password });
  const headers = new Headers(req.headers);
  if (ip) headers.set("cf-connecting-ip", ip);
  return new Request(req, { headers });
}

test("P6 login: attempts over the limit get 429 before the password is checked", async () => {
  const limiter = fakeLimiter(5);
  const env = createAdminEnv({ DB: createAdminFakeD1(), ADMIN_LOGIN_LIMITER: limiter });
  for (let i = 0; i < 5; i++) {
    assert.equal((await worker.fetch(loginFrom("203.0.113.7", "wrong-" + i), env, createCtx())).status, 401);
  }
  // Even the CORRECT password is refused once throttled: no oracle.
  const blocked = await worker.fetch(loginFrom("203.0.113.7", TEST_ADMIN_PASSWORD), env, createCtx());
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.equal((await blocked.json()).error.code, "RATE_LIMITED");
  assert.ok(limiter.keys.every((k) => k === "admin-login:203.0.113.7"));
});

test("P6 login: the limit is per client IP; another IP still logs in", async () => {
  const env = createAdminEnv({ DB: createAdminFakeD1(), ADMIN_LOGIN_LIMITER: fakeLimiter(1) });
  await worker.fetch(loginFrom("203.0.113.7", "wrong"), env, createCtx());
  assert.equal((await worker.fetch(loginFrom("203.0.113.7", TEST_ADMIN_PASSWORD), env, createCtx())).status, 429);
  const ok = await worker.fetch(loginFrom("198.51.100.9", TEST_ADMIN_PASSWORD), env, createCtx());
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie"), /^admin_session=/);
});

test("P6 login: legitimate login within the limit is unchanged", async () => {
  const env = createAdminEnv({ DB: createAdminFakeD1(), ADMIN_LOGIN_LIMITER: fakeLimiter(5) });
  const ok = await worker.fetch(loginFrom("203.0.113.7", TEST_ADMIN_PASSWORD), env, createCtx());
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
});

test("P6 login: fail-open when the binding is missing or errors (owner is never locked out)", async () => {
  const broken = { limit: async () => { throw new Error("limiter down"); } };
  for (const extra of [{}, { ADMIN_LOGIN_LIMITER: broken }]) {
    const logs = captureConsole();
    try {
      const env = createAdminEnv({ DB: createAdminFakeD1(), ...extra });
      assert.equal((await worker.fetch(loginFrom("203.0.113.7", TEST_ADMIN_PASSWORD), env, createCtx())).status, 200);
      assert.equal((await worker.fetch(loginFrom("203.0.113.7", "wrong"), env, createCtx())).status, 401);
    } finally {
      logs.restore();
    }
    const text = logs.text();
    assert.ok(text.includes("admin_login_ratelimit_unavailable"));
  }
});

test("P6 login: neither the password nor the client IP is logged", async () => {
  const logs = captureConsole();
  try {
    const env = createAdminEnv({ DB: createAdminFakeD1(), ADMIN_LOGIN_LIMITER: fakeLimiter(1) });
    await worker.fetch(loginFrom("203.0.113.77", "sup3r-s3cret-guess"), env, createCtx());
    await worker.fetch(loginFrom("203.0.113.77", "sup3r-s3cret-guess"), env, createCtx());
  } finally {
    logs.restore();
  }
  const text = logs.text();
  assert.ok(text.includes("RATE_LIMITED"));
  assert.ok(!text.includes("sup3r-s3cret-guess"));
  assert.ok(!text.includes("203.0.113.77"));
  assert.ok(!text.includes(TEST_ADMIN_PASSWORD));
});

/* ============================ 2. unicode domains ============================ */

const reply = (reply_text) => validateAgentResponse({ action: "REPLY", reply_text, include_affiliate_cta: false });

const ADVERSARIAL = [
  "evil.xyz",
  "evil。xyz", // 。 ideographic full stop
  "evil．xyz", // ． full-width full stop
  "evil｡xyz", // ｡ half-width ideographic full stop
  "evil․xyz", // ․ ONE DOT LEADER
  "evil﹒xyz", // ﹒ SMALL FULL STOP
  "evil .xyz", // whitespace before the dot
  "evil​.xyz", // zero-width space
  "evil​․xyz", // zero-width + dot leader
  "ｅｖｉｌ．ｘｙｚ", // full-width letters
  "สั่งที่ evil﹒xyz ได้เลยครับ",
  "ดูที่ shop․online/abc ครับ",
  "กดที่ evil .com นะครับ",
  "evil\t.xyz",
];

test("P6 unicode: dot look-alikes, compatibility forms and a spaced dot are all rejected", () => {
  for (const t of ADVERSARIAL) assert.equal(reply(t).reason, "AI_RESPONSE_INVENTED_URL", JSON.stringify(t));
});

test("P6 unicode: normal Thai text and punctuation remain accepted", () => {
  for (const t of [
    "ขอบคุณครับ 😊",
    "เดี๋ยวแอดมินแจ้งรายละเอียดให้นะครับ",
    "ดีครับ . แนะนำเลย",
    "โอเคครับ. ขอบคุณครับ",
    "สวัสดีครับ… เดี๋ยวแอดมินแจ้งนะครับ",
    "ใช้ดีมาก! ครับ",
    "A.I. ช่วยตอบครับ",
    "รุ่น 2.0 ครับ",
    "ครับ ...",
    "ตัวนี้ 20W ครับ",
    "ขอบคุณที่สนใจนะคะ (^^)",
  ]) {
    assert.equal(reply(t).ok, true, JSON.stringify(t));
  }
  assert.equal(SPACED_DOT_DOMAIN_PATTERN.test("ราคา .50"), false);
  assert.equal(SPACED_DOT_DOMAIN_PATTERN.test("ดีครับ .แนะนำ"), false, "Thai after a spaced dot is prose, not a TLD");
});

test("P6 unicode: NFKC probe folds compatibility dots but leaves plain text alone", () => {
  assert.deepEqual(linkProbeVariants("ขอบคุณครับ"), ["ขอบคุณครับ"]);
  const [, folded] = linkProbeVariants("evil․xyz");
  assert.equal(folded, "evil.xyz");
  assert.equal(linkProbeVariants("evil﹒xyz")[1], "evil.xyz");
  assert.equal(linkProbeVariants("a​b")[0], "ab");
});

test("P6 unicode: DRY_RUN end to end -- a dot-leader domain is SKIPPED, never stored, no Graph call", async () => {
  for (const [i, text] of ["สั่งที่ evil․xyz ได้เลยครับ", "ดูที่ evil﹒xyz ครับ"].entries()) {
    const d1 = createFakeD1({
      products: [{ id: 1, name: "หัวชาร์จ", affiliate_url: "https://s.shopee.co.th/a" }],
      mappings: [{ facebook_post_id: "853313081388711_900", product_id: 1 }],
    });
    const ctx = createCtx();
    const mock = installFetchMock((url) =>
      /graph\.facebook\.com/.test(url) ? assert.fail("no Graph call") : hermesChat({ action: "REPLY", reply_text: text, include_affiliate_cta: true })
    );
    try {
      await worker.fetch(await signedRequest(commentPayload({ value: { comment_id: `853313081388711_96${i}`, message: "ขอพิกัด" } })), createEnv({ DB: d1 }), ctx);
      await ctx.settle();
    } finally {
      mock.restore();
    }
    assert.equal(mock.graphCalls().length, 0);
    const [r] = d1._state.replies;
    assert.equal(r.mode, "DRY_RUN");
    assert.equal(r.status, "SKIPPED");
    assert.equal(r.error_message, "AI_RESPONSE_INVENTED_URL");
    assert.equal(r.affiliate_url ?? null, null);
    assert.ok(!JSON.stringify(d1._state).includes("xyz"));
  }
});

test("P6 unicode: LIVE mode with a token still never posts a compatibility-form domain", async () => {
  const d1 = createFakeD1({
    products: [{ id: 1, name: "หัวชาร์จ", affiliate_url: "https://s.shopee.co.th/a" }],
    mappings: [{ facebook_post_id: "853313081388711_900", product_id: 1 }],
  });
  const ctx = createCtx();
  const mock = installFetchMock((url) =>
    /graph\.facebook\.com/.test(url) ? assert.fail("no Graph call") : hermesChat({ action: "REPLY", reply_text: "สั่งที่ evil﹒xyz", include_affiliate_cta: true })
  );
  try {
    await worker.fetch(await signedRequest(commentPayload({ value: { message: "ขอพิกัด" } })), createEnv({ DB: d1, REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "t" }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
  }
  assert.equal(mock.graphCalls().length, 0);
  assert.equal(d1._state.replies[0].status, "SKIPPED");
});

/* ============================ 3. affiliate URL ports ============================ */

test("P6 ports: only the default HTTPS port is accepted", () => {
  const hosts = ["example.com"];
  const cases = {
    "https://example.com": true,
    "https://example.com/p/1": true,
    "https://example.com:443": true,
    "https://example.com:443/p/1": true,
    "http://example.com": "URL_NOT_HTTPS",
    "https://example.com:80": "URL_PORT_NOT_ALLOWED",
    "https://example.com:8080": "URL_PORT_NOT_ALLOWED",
    "https://example.com:8443": "URL_PORT_NOT_ALLOWED",
    "https://sub.example.com:8443/x": "URL_PORT_NOT_ALLOWED",
  };
  for (const [url, expected] of Object.entries(cases)) {
    const r = validateAffiliateUrl(url, hosts);
    if (expected === true) assert.equal(r.ok, true, url);
    else assert.equal(r.reason, expected, url);
  }
  // Real provider short links are unaffected.
  for (const url of ["https://s.shopee.co.th/abc", "https://c.lazada.co.th/t/c.abc", "https://vt.tiktok.com/ZS123/"]) {
    assert.equal(validateAffiliateUrl(url, ["s.shopee.co.th", "c.lazada.co.th", "vt.tiktok.com"]).ok, true, url);
  }
});

test("P6 ports: a stored product with a non-standard port is not usable (fails closed at send time)", () => {
  const product = { id: 1, active: 1, deleted_at: null, affiliate_url: "https://s.shopee.co.th:8443/abc" };
  assert.equal(isUsableProduct(product, ["s.shopee.co.th"]), false);
  assert.equal(isUsableProduct({ ...product, affiliate_url: "https://s.shopee.co.th/abc" }, ["s.shopee.co.th"]), true);
});

test("P6 ports: the admin API refuses to save a product URL with a port", async () => {
  const { validateProductInput } = await import("../src/admin-api.js");
  const r = validateProductInput({ name: "x", affiliate_url: "https://s.shopee.co.th:8080/abc", platform: "shopee" }, ["s.shopee.co.th"]);
  assert.equal(r.ok, false);
  assert.equal(r.response.status, 400);
});

/* ============================ 4. dashboard copy ============================ */

test("P6 dashboard: the keyword hint no longer claims keywords select a product", () => {
  assert.ok(!DASHBOARD_JS.includes("ใช้จับคู่เมื่อโพสต์ยังไม่ได้ผูกสินค้า"), "stale keyword-matching hint is gone");
  assert.ok(DASHBOARD_JS.includes("ระบบไม่ใช้คีย์เวิร์ดเลือกสินค้า"));
  assert.ok(DASHBOARD_JS.includes("จะไม่ได้รับลิงก์ Affiliate อัตโนมัติ"));
  assert.ok(DASHBOARD_JS.includes("ระบบไม่เลือกสินค้าจากคีย์เวิร์ดในคอมเมนต์"));
});

/* ============================ 5. dead code ============================ */

test("P6 dead code: the keyword matcher and listActiveProducts are gone", () => {
  assert.equal(existsSync(new URL("../src/products.js", import.meta.url)), false);
  assert.equal(typeof db.listActiveProducts, "undefined");
  assert.equal(typeof db.getMappedProduct, "function");
});
