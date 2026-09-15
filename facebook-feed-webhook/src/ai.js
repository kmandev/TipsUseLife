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

/**
 * Deterministic validation of a parsed agent response.
 *
 * @param {any} parsed
 * @param {{maxLength?: number, trustedProduct?: any}} options
 * @returns {{ok: true, action: string, text: string} | {ok: false, reason: string}}
 */
export function validateAgentResponse(parsed, options = {}) {
  const { maxLength = 600, trustedProduct = null } = options;

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "AI_RESPONSE_NOT_OBJECT" };
  }

  const action = String(parsed.action ?? "").toUpperCase();
  if (action !== ACTIONS.REPLY && action !== ACTIONS.SKIP) {
    return { ok: false, reason: "AI_RESPONSE_UNKNOWN_ACTION" };
  }

  if (action === ACTIONS.SKIP) {
    return { ok: true, action: ACTIONS.SKIP, text: "" };
  }

  const rawText = parsed.reply_text ?? parsed.text ?? parsed.reply;
  if (typeof rawText !== "string") {
    return { ok: false, reason: "AI_RESPONSE_MISSING_TEXT" };
  }

  const text = stripControlChars(rawText).trim();

  if (!text) return { ok: false, reason: "AI_RESPONSE_EMPTY_TEXT" };
  if (text.length > maxLength) return { ok: false, reason: "AI_RESPONSE_TOO_LONG" };

  // URLs: only the exact shopee_url of a matched, trusted product is allowed.
  const urls = text.match(URL_PATTERN) || [];
  if (urls.length > 0) {
    const allowed = trustedProduct?.shopee_url
      ? String(trustedProduct.shopee_url).trim()
      : null;

    if (!allowed) return { ok: false, reason: "AI_RESPONSE_INVENTED_URL" };

    for (const url of urls) {
      const cleaned = url.replace(/[)\].,;!?]+$/, "");
      if (cleaned !== allowed) return { ok: false, reason: "AI_RESPONSE_INVENTED_URL" };
    }
  }

  for (const pattern of FORBIDDEN_CLAIM_PATTERNS) {
    if (pattern.test(text)) return { ok: false, reason: "AI_RESPONSE_UNVERIFIABLE_CLAIM" };
  }

  return { ok: true, action: ACTIONS.REPLY, text };
}

/** Convenience wrapper: parse + validate in one step. */
export function evaluateAgentResponse(raw, options) {
  const parsed = parseAgentResponse(raw);
  if (!parsed.ok) return parsed;
  return validateAgentResponse(parsed.value, options);
}
