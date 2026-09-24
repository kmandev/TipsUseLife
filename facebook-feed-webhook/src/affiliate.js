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
 *   - Dashboard content mapping for the exact Facebook post/reel
 *     (source = MAPPING) -- the ONLY way a product (and therefore an
 *     affiliate URL) can be attached to a reply;
 *   - otherwise no product (source = NONE) -- the reply carries no link.
 *
 * INVARIANT: every affiliate URL that can reach Facebook originates from an
 * active, non-deleted product explicitly mapped to the current post/reel.
 *
 * There is deliberately no keyword matcher: one only sees the comment and
 * the catalog, never what the post is about, so on an unmapped post it
 * could attach product B's link to a post about product A. The old helper
 * (products.js / matchProduct) was removed in Phase 6.
 *
 * A product is only usable when it is active, not soft-deleted, and its
 * affiliate URL passes validateAffiliateUrl(). Anything else fails closed.
 */

export const PRODUCT_SOURCES = Object.freeze({
  MAPPING: "MAPPING",
  // Historical value only (rows written before keyword fallback was
  // removed); resolveProduct() never returns it.
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
  // Only the default HTTPS port. WHATWG URL parsing elides ":443" for
  // https, so `port` is "" for both "https://h/x" and "https://h:443/x";
  // any explicit other port (":80", ":8080", ":8443") is refused. Real
  // Shopee / Lazada / TikTok affiliate links never carry a port.
  if (parsed.port !== "") return { ok: false, reason: "URL_PORT_NOT_ALLOWED" };

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
 * Resolve the product for a comment: the post/reel's mapped product, and
 * only if it is usable. No mapping, or an unusable mapped product, means
 * no product -- never a fallback to another one.
 *
 * @param {{mappedProduct: any|null, allowedHosts: string[]}} input
 * @returns {{product: any|null, source: string}}
 */
export function resolveProduct({ mappedProduct, allowedHosts }) {
  if (mappedProduct && isUsableProduct(mappedProduct, allowedHosts)) {
    return { product: mappedProduct, source: PRODUCT_SOURCES.MAPPING };
  }
  return { product: null, source: PRODUCT_SOURCES.NONE };
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
