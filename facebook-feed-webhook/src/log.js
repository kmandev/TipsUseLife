/**
 * Safe structured logging.
 *
 * Rules enforced here:
 *  - never log secrets (they are simply never passed in, and any key
 *    whose name looks secret-ish is redacted defensively)
 *  - never log full user comment text (PII) -- truncate hard
 *  - never log authorization headers, cookies or tokens
 */

const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|authorization|cookie|api[-_]?key|credential|signature)/i;

const MAX_TEXT_PREVIEW = 40;

/**
 * Truncate free text so that logs never carry a full user message.
 * @param {unknown} text
 * @param {number} max
 */
export function safeText(text, max = MAX_TEXT_PREVIEW) {
  if (text === null || text === undefined) return null;
  const s = String(text).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/**
 * Defensive redaction of any field that looks like a secret.
 * @param {Record<string, unknown>} fields
 */
export function redact(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
export function logEvent(event, fields = {}) {
  try {
    console.log(JSON.stringify({ event, ...redact(fields) }));
  } catch {
    console.log(JSON.stringify({ event, log_error: "SERIALIZATION_FAILED" }));
  }
}

/**
 * Errors are logged by *category*, never by raw message, so that an
 * upstream error string containing a token can never leak.
 * @param {string} event
 * @param {string} category
 * @param {Record<string, unknown>} [fields]
 */
export function logError(event, category, fields = {}) {
  try {
    console.error(JSON.stringify({ event, error_category: category, ...redact(fields) }));
  } catch {
    console.error(JSON.stringify({ event, error_category: "SERIALIZATION_FAILED" }));
  }
}
