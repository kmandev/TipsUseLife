/**
 * Conservative product matching.
 *
 * Philosophy: a wrong match is worse than no match, because a wrong
 * match feeds untrue product context to the model. When in doubt we
 * return null and the agent produces a generic, factless reply.
 */

const MIN_KEYWORD_LENGTH = 3;
const MIN_SCORE = 2;
const AMBIGUITY_MARGIN = 1; // best must beat runner-up by more than this

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[​﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split the comma/pipe/newline separated keyword column into terms.
 * @param {string} keywords
 */
function parseKeywords(keywords) {
  return normalize(keywords)
    .split(/[,|\n;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length >= MIN_KEYWORD_LENGTH);
}

/**
 * Score a single product against the comment text.
 * Keyword hits are strong signal (weight 2); a full product-name hit is
 * the strongest (weight 3). Description is NOT used for matching --
 * it is prose and produces false positives.
 *
 * @param {any} product
 * @param {string} haystack normalized comment text
 */
export function scoreProduct(product, haystack) {
  let score = 0;

  const name = normalize(product?.name);
  if (name.length >= MIN_KEYWORD_LENGTH && haystack.includes(name)) {
    score += 3;
  }

  for (const keyword of parseKeywords(product?.keywords)) {
    if (haystack.includes(keyword)) score += 2;
  }

  return score;
}

/**
 * @param {string} commentText
 * @param {any[]} products rows from the products table (active only)
 * @returns {any|null} the matched product row, or null when not confident
 */
export function matchProduct(commentText, products) {
  const haystack = normalize(commentText);
  if (!haystack || !Array.isArray(products) || products.length === 0) {
    return null;
  }

  const scored = products
    .filter((p) => p && Number(p.active) === 1)
    .map((p) => ({ product: p, score: scoreProduct(p, haystack) }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  // Ambiguous between two products -> refuse to guess.
  if (scored.length > 1 && scored[0].score - scored[1].score <= AMBIGUITY_MARGIN) {
    return null;
  }

  return scored[0].product;
}
