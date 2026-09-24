/**
 * Parsing and validation of the Hermes/Gemini agent response.
 *
 * This module is the anti-hallucination gate. The agent is *asked* to
 * behave, but we never trust it: every draft passes a deterministic
 * validator before it can be stored as a usable reply, and anything
 * suspicious fails closed to a factless generic Thai response.
 *
 * Nothing here executes AI-produced instructions. The only field ever
 * acted upon is `action`, against a fixed allow-list.
 */

export const SAFE_GENERIC_REPLY =
  "ขอบคุณที่สนใจครับ 😊 เดี๋ยวทางเพจแนะนำรายละเอียดให้ครับ";

export const ACTIONS = Object.freeze({
  REPLY: "REPLY",
  SKIP: "SKIP",
});

const URL_PATTERN = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

/**
 * Claims we can never substantiate from the trusted product database.
 * The products table stores name / description / keywords / shopee_url
 * only -- there is no price, stock, promotion, shipping or warranty
 * column -- so any such assertion is by definition invented.
 */
const FORBIDDEN_CLAIM_PATTERNS = [
  /\d[\d,.]*\s*(บาท|฿|thb)/i,
  /฿\s*\d/,
  /ราคา\s*[:：]?\s*\d/,
  /\bprice\b\s*[:：]?\s*\d/i,
  /ส่วนลด/,
  /ลดราคา/,
  /โปรโมชั่น|โปรโมชัน/,
  /โค้ด\s*ส่วนลด|โค้ดลด/,
  /ส่งฟรี|จัดส่งฟรี|ฟรีค่าส่ง/,
  /รับประกัน/,
  /พร้อมส่ง/,
  /ของหมด|สินค้าหมด|หมดสต็อก|มีสต็อก|มีสต๊อก/,
  /จำนวนจำกัด/,
];

/** Remove control characters without using unicode escapes. */
function stripControlChars(text) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10) {
      out += ch;
      continue;
    }
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out;
}

/**
 * Best-effort extraction of a JSON object from an agent response that may
 * be raw JSON, fenced JSON, JSON embedded in prose, or an already-decoded
 * object wrapped in a Hermes envelope.
 *
 * @param {unknown} raw
 * @returns {{ok: true, value: any} | {ok: false, reason: string}}
 */
export function parseAgentResponse(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "AI_RESPONSE_EMPTY" };
  }

  // Some agent gateways wrap their JSON payload in a single-element
  // array (e.g. a content-block list: [{"type":"text","text":"..."}]).
  // We accept ONLY the unambiguous single-element case and recurse into
  // it; anything else (empty, multi-element, non-object element) stays
  // fail-closed exactly like any other unrecognized shape.
  if (Array.isArray(raw)) {
    if (raw.length !== 1) {
      return { ok: false, reason: "AI_RESPONSE_UNRECOGNIZED_SHAPE" };
    }
    const [sole] = raw;
    if (sole && typeof sole === "object" && !Array.isArray(sole)) {
      if (sole.type === "text" && typeof sole.text === "string") {
        return parseAgentResponse(sole.text);
      }
      return parseAgentResponse(sole);
    }
    return { ok: false, reason: "AI_RESPONSE_UNRECOGNIZED_SHAPE" };
  }

  if (typeof raw === "object") {
    const candidate =
      raw.action !== undefined
        ? raw
        : raw.result ?? raw.data ?? raw.output ?? raw.response ?? raw.message;

    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return { ok: true, value: candidate };
    }
    if (typeof candidate === "string") {
      return parseAgentResponse(candidate);
    }
    return { ok: false, reason: "AI_RESPONSE_UNRECOGNIZED_SHAPE" };
  }

  if (typeof raw !== "string") {
    return { ok: false, reason: "AI_RESPONSE_UNRECOGNIZED_SHAPE" };
  }

  const text = raw.trim();
  if (!text) return { ok: false, reason: "AI_RESPONSE_EMPTY" };

  const candidates = [text];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (parsed.action === undefined && parsed.result && typeof parsed.result === "object") {
          return { ok: true, value: parsed.result };
        }
        return { ok: true, value: parsed };
      }
    } catch {
      // try the next candidate
    }
  }

  return { ok: false, reason: "AI_RESPONSE_NOT_JSON" };
}

/*
 * Generic domain-SHAPE detector (not a TLD list: new TLDs appear constantly,
 * and Facebook auto-links bare domains, so any list is a future bypass).
 *
 * A domain-shaped token is one or more labels, each followed by a dot, then
 * a final label ("TLD") made only of LETTERS (any script, incl. Thai IDN
 * such as ".ไทย") of length >= 2, or a punycode TLD ("xn--..."). Requiring
 * an all-letter TLD is what keeps ordinary Thai text safe: "v1.2", "3.14",
 * "รุ่น 2.0", "99.90 บาท" end in digits, and "A.I." / "e.g." end in a
 * single letter, so none of them match. Dot look-alikes (U+3002, U+FF0E,
 * U+FF61), which IDNA treats as dots, count as dots.
 */
const DOMAIN_LABEL = "[\\p{L}\\p{M}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]*[\\p{L}\\p{M}\\p{N}])?";
const DOMAIN_DOT = "[.\\u3002\\uFF0E\\uFF61]";
const DOMAIN_TLD = "(?:[\\p{L}\\p{M}]{2,63}|xn--[a-z0-9-]{1,59})";
export const DOMAIN_SHAPE_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}-])(?:${DOMAIN_LABEL}${DOMAIN_DOT})+${DOMAIN_TLD}(?![\\p{L}\\p{M}\\p{N}-])`,
  "iu"
);

/**
 * Anything that looks like a link, domain, e-mail, IP, phone number or a
 * link scheme. The AI must never write one: the only link a reply may carry
 * is appended later by affiliate.js from the trusted database.
 */
const LINK_LIKE_PATTERNS = [
  URL_PATTERN,
  DOMAIN_SHAPE_PATTERN,
  /(^|[^\p{L}\p{N}])\/\/\S/u, // scheme-relative //host
  /\b(?:javascript|vbscript|data|file|blob|about|intent|mailto|tel|sms|ftp)\s*:/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // IPv4
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /(\+?66|0)[\s-]?\d{1,2}[\s-]?\d{3}[\s-]?\d{4}/,
];

/**
 * Invisible format characters (zero-width space/joiner, bidi controls) are
 * removed before link detection so "evil\u200B.xyz" cannot slip through.
 */
function linkProbeText(text) {
  return String(text).replace(/\p{Cf}/gu, "");
}

/** Signs the model was steered into echoing its instructions or internals. */
const LEAK_PATTERNS = [
  /system\s*prompt/i,
  /\binstructions?\b/i,
  /คำสั่งระบบ|พรอมต์|พร้อมต์|prompt/i,
  /api[\s_-]?key|secret|token|password|รหัสผ่าน/i,
  /\bjson\b/i,
];

/**
 * Deterministic validation of a parsed agent response.
 *
 * Contract (see agent-prompt.js):
 *   {"action":"REPLY","reply_text":"...","include_affiliate_cta":bool}
 *   {"action":"SKIP","reason":"..."}
 *
 * @param {any} parsed
 * @param {{maxLength?: number}} options
 * @returns {{ok: true, action: string, text: string, includeCta: boolean, skipReason?: string}
 *          | {ok: false, reason: string}}
 */
export function validateAgentResponse(parsed, options = {}) {
  const { maxLength = 300 } = options;

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "AI_RESPONSE_NOT_OBJECT" };
  }

  const action = String(parsed.action ?? "").toUpperCase();
  if (action !== ACTIONS.REPLY && action !== ACTIONS.SKIP) {
    return { ok: false, reason: "AI_RESPONSE_UNKNOWN_ACTION" };
  }

  if (action === ACTIONS.SKIP) {
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 60) : null;
    return { ok: true, action: ACTIONS.SKIP, text: "", includeCta: false, skipReason: reason };
  }

  const rawText = parsed.reply_text ?? parsed.text ?? parsed.reply;
  if (typeof rawText !== "string") {
    return { ok: false, reason: "AI_RESPONSE_MISSING_TEXT" };
  }

  const text = stripControlChars(rawText).trim();

  if (!text) return { ok: false, reason: "AI_RESPONSE_EMPTY_TEXT" };
  if (text.length > maxLength) return { ok: false, reason: "AI_RESPONSE_TOO_LONG" };

  const probe = linkProbeText(text);
  for (const pattern of LINK_LIKE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(probe)) return { ok: false, reason: "AI_RESPONSE_INVENTED_URL" };
  }

  for (const pattern of FORBIDDEN_CLAIM_PATTERNS) {
    if (pattern.test(text)) return { ok: false, reason: "AI_RESPONSE_UNVERIFIABLE_CLAIM" };
  }

  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(text)) return { ok: false, reason: "AI_RESPONSE_POLICY_LEAK" };
  }

  const cta = parsed.include_affiliate_cta;
  const includeCta = cta === true || cta === "true";

  return { ok: true, action: ACTIONS.REPLY, text, includeCta };
}

/** Convenience wrapper: parse + validate in one step. */
export function evaluateAgentResponse(raw, options) {
  const parsed = parseAgentResponse(raw);
  if (!parsed.ok) return parsed;
  return validateAgentResponse(parsed.value, options);
}

/**
 * Safe, secret-free structural description of an agent response, for
 * diagnostic logging only. Never includes any content -- only the JS
 * type, whether it is an array, and (for a plain object) up to its
 * first 10 top-level key NAMES. No values, no comment text, no prompt,
 * no raw response body.
 *
 * @param {unknown} raw
 * @returns {{raw_type: string, is_array: boolean, top_level_keys: string[] | null}}
 */
export function describeResponseShape(raw) {
  const isArray = Array.isArray(raw);
  const rawType = raw === null ? "null" : isArray ? "array" : typeof raw;
  let topLevelKeys = null;
  if (raw && typeof raw === "object" && !isArray) {
    topLevelKeys = Object.keys(raw).slice(0, 10);
  }
  return { raw_type: rawType, is_array: isArray, top_level_keys: topLevelKeys };
}
