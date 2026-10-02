/**
 * Deterministic product PREFILTER for mapping suggestions (Phase AM-2.3).
 *
 * Discovery-only. This is NOT the reply-time keyword matcher that Phase 6
 * removed: it is never imported by the reply path (pipeline.js / affiliate.js
 * / ai.js), it never selects a product, and its output only narrows and
 * ranks the closed candidate set a human (helped by the AI) reviews.
 *
 * Signals (strongest first):
 *   FULL_NAME        the whole product name appears in the caption      10
 *   BRAND            a Latin brand/model token of the name (>= 3 chars,
 *                    starts with a letter) appears as a whole word       5
 *   KEYWORD          a product keyword (>= 3 chars) appears               2
 *   GENERIC_KEYWORD  a keyword shared by >= 2 active products appears    1
 * Thai has no word spaces, so names and keywords are compared on a
 * "compact" form with whitespace, punctuation and symbols removed. No
 * fuzzy matching and no Thai word segmentation. URLs are removed before
 * matching and are never a signal. `description` is deliberately NOT used:
 * long marketing text would match almost any caption.
 */

export const PREFILTER_WEIGHTS = Object.freeze({ FULL_NAME: 10, BRAND: 5, KEYWORD: 2, GENERIC_KEYWORD: 1 });
export const MIN_KEYWORD_CHARS = 3;
export const MAX_CANDIDATES = 5;

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/giu;

/** NFC, lower case, URLs removed, '#' and whitespace normalized to single spaces. */
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(URL_RE, " ")
    .replace(/#/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Normalized text with whitespace, punctuation and symbols removed. */
export function compactText(value) {
  return normalizeText(value).replace(/[\s\p{P}\p{S}]+/gu, "");
}

const charLength = (s) => [...s].length;

function keywordsOf(product) {
  const seen = new Set();
  for (const raw of String(product?.keywords ?? "").split(",")) {
    const k = compactText(raw);
    if (charLength(k) >= MIN_KEYWORD_CHARS) seen.add(k);
  }
  return [...seen];
}

function brandTokensOf(product) {
  const tokens = normalizeText(product?.name).split(/[\s\p{P}\p{S}]+/u);
  return [...new Set(tokens.filter((t) => /^[a-z][a-z0-9]{2,}$/.test(t)))];
}

function hasWord(spaced, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(spaced);
}

/**
 * @param {string} caption untrusted post text
 * @param {Array<{id:number,name:string,keywords?:string,active?:number,deleted_at?:string|null}>} products
 * @param {{maxCandidates?: number}} [options]
 * @returns {Array<{product_id:number, score:number, matched_signals:Array<{type:string,value:string}>}>}
 *   score > 0 only; score DESC, then product_id ASC; at most maxCandidates.
 */
export function prefilterProducts(caption, products, { maxCandidates = MAX_CANDIDATES } = {}) {
  const usable = (Array.isArray(products) ? products : []).filter(
    (p) => p && Number.isInteger(Number(p.id)) && Number(p.active) === 1 && !p.deleted_at && typeof p.name === "string"
  );
  const spaced = normalizeText(caption);
  const compact = compactText(caption);
  if (!compact) return [];

  const keywordOwners = new Map();
  for (const p of usable) for (const k of keywordsOf(p)) keywordOwners.set(k, (keywordOwners.get(k) ?? 0) + 1);

  const results = [];
  for (const p of usable) {
    const signals = [];
    let score = 0;
    const name = compactText(p.name);
    if (charLength(name) >= MIN_KEYWORD_CHARS && compact.includes(name)) {
      score += PREFILTER_WEIGHTS.FULL_NAME;
      signals.push({ type: "FULL_NAME", value: p.name });
    }
    for (const brand of brandTokensOf(p)) {
      if (hasWord(spaced, brand)) {
        score += PREFILTER_WEIGHTS.BRAND;
        signals.push({ type: "BRAND", value: brand });
      }
    }
    for (const k of keywordsOf(p)) {
      if (k === name) continue;
      if (compact.includes(k)) {
        const generic = (keywordOwners.get(k) ?? 0) > 1;
        score += generic ? PREFILTER_WEIGHTS.GENERIC_KEYWORD : PREFILTER_WEIGHTS.KEYWORD;
        signals.push({ type: generic ? "GENERIC_KEYWORD" : "KEYWORD", value: k });
      }
    }
    if (score > 0) results.push({ product_id: Number(p.id), score, matched_signals: signals });
  }
  results.sort((a, b) => b.score - a.score || a.product_id - b.product_id);
  return results.slice(0, Math.max(0, maxCandidates));
}
