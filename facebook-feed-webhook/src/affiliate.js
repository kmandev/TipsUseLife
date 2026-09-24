/**
 * Affiliate product resolution and final reply composition.
 *
 * TRUST BOUNDARY
 * --------------
 * The AI never sees, chooses, writes or edits an affiliate URL. It only
 * says whether a call-to-action is appropriate (`include_affiliate_cta`).
 * Which product applies, and which URL is appended, is decided here from
 * trusted database rows:
 *
 *   1. Dashboard content mapping for the exact Facebook post/reel
 *      (source = MAPPING) -- the primary, authoritative path;
 *   2. otherwise the conservative keyword matcher over active products
 *      (source = KEYWORD);
 *   3. otherwise no product (source = NONE) -- the reply carries no link.
 *
 * A product is only usable when it is active, not soft-deleted, and its
 * affiliate URL passes validateAffiliateUrl(). Anything else fails closed.
 */

import { matchProduct } from "./products.js";

export const PRODUCT_SOURCES = Object.freeze({
  MAPPING: "MAPPING",
  KEYWORD: "KEYWORD",
  NONE: "NONE",
});

const MAX_URL_LENGTH = 2048;

/**
 * Deterministic affiliate URL check used both when an admin saves a
 * product and again at reply time (defence in depth: a row edited directly
 * in D1 still has to pass).
 *
 * @param {unknown} value
 * @param {string[]} allowedHosts lower-case host names; subdomains of an
 *   allowed host are accepted.
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function validateAffiliateUrl(value, allowedHosts = []) {
  if (typeof value !== "string") return { ok: false, reason: "URL_MISSING" };
  const raw = value.trim();
  if (!raw) return { ok: false, reason: "URL_MISSING" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "URL_TOO_LONG" };
  if (/\s/.test(raw)) return { ok: false, reason: "URL_HAS_WHITESPACE" };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "URL_INVALID" };
  }

  if (parsed.protocol !== "https:") return { ok: false, reason: "URL_NOT_HTTPS" };
  if (parsed.username || parsed.password) return { ok: false, reason: "URL_HAS_CREDENTIALS" };

  const host = parsed.hostname.toLowerCase();
  if (Array.isArray(allowedHosts) && allowedHosts.length > 0) {
    const allowed = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) return { ok: false, reason: "URL_HOST_NOT_ALLOWED" };
  }

  return { ok: true, url: raw };
}

/** @returns {boolean} whether a product row may be offered at all. */
export function isUsableProduct(product, allowedHosts) {
  if (!product || typeof product !== "object") return false;
  if (Number(product.active) !== 1) return false;
  if (product.deleted_at) return false;
  return validateAffiliateUrl(affiliateUrlOf(product), allowedHosts).ok;
}

/** The URL column the application treats as authoritative. */
export function affiliateUrlOf(product) {
  return product?.affiliate_url ?? product?.shopee_url ?? null;
}

/**
 * Resolve the product for a comment.
 *
 * @param {{mappedProduct: any|null, activeProducts: any[], commentText: string, allowedHosts: string[]}} input
 * @returns {{product: any|null, source: string}}
 */
export function resolveProduct({ mappedProduct, activeProducts, commentText, allowedHosts }) {
  if (mappedProduct) {
    // An explicit mapping is authoritative. If the mapped product is not
    // usable we do NOT fall back to keyword matching -- the admin said
    // "this post is about product X"; offering product Y instead would be
    // exactly the "wrong product" failure we must never produce.
    return isUsableProduct(mappedProduct, allowedHosts)
      ? { product: mappedProduct, source: PRODUCT_SOURCES.MAPPING }
      : { product: null, source: PRODUCT_SOURCES.NONE };
  }

  const usable = (activeProducts || []).filter((p) => isUsableProduct(p, allowedHosts));
  const matched = matchProduct(commentText, usable);
  return matched
    ? { product: matched, source: PRODUCT_SOURCES.KEYWORD }
    : { product: null, source: PRODUCT_SOURCES.NONE };
}

/**
 * Wording that promises a link. If the AI writes this but no trusted URL
 * can be appended, the reply would point at nothing -- a malformed CTA --
 * so it is refused.
 */
const LINK_REFERENCE_PATTERN = /(ลิงก์|ลิ้งก์|ลิ้งค์|ลิงค์|link|👇|คลิก|กดดู|กดสั่ง|กดที่|พิกัด|ตะกร้า)/i;

/**
 * Compose the final public reply from the validated AI text plus, when
 * appropriate, the trusted affiliate URL.
 *
 * @param {{text: string, includeCta: boolean, product: any|null, allowedHosts: string[], suppressLink?: boolean}} input
 * @returns {{ok: true, text: string, affiliateUrl: string|null} | {ok: false, reason: string}}
 */
export function composeFinalReply({ text, includeCta, product, allowedHosts, suppressLink = false }) {
  const body = String(text || "").trim();
  if (!body) return { ok: false, reason: "FINAL_EMPTY" };

  const wantsLink = Boolean(includeCta);
  const referencesLink = LINK_REFERENCE_PATTERN.test(body);

  if (!wantsLink) {
    // A reply that talks about a link it does not carry is malformed.
    if (referencesLink) return { ok: false, reason: "CTA_TEXT_WITHOUT_LINK" };
    return { ok: true, text: body, affiliateUrl: null };
  }

  if (suppressLink) return { ok: false, reason: "DUPLICATE_LINK_SUPPRESSED" };
  if (!product) return { ok: false, reason: "CTA_WITHOUT_PRODUCT" };

  const checked = validateAffiliateUrl(affiliateUrlOf(product), allowedHosts);
  if (!checked.ok) return { ok: false, reason: `AFFILIATE_${checked.reason}` };

  return { ok: true, text: `${body}\n${checked.url}`, affiliateUrl: checked.url };
}
