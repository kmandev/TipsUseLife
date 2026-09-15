/**
 * HMAC helpers shared by the Meta inbound verification and the Hermes
 * outbound signature. No secret value is ever returned or logged here.
 */

/**
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>} lowercase hex digest
 */
export async function hmacSha256Hex(secret, message) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time-ish string comparison. Both inputs are hex digests.
 * @param {string} a
 * @param {string} b
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Short, non-reversible identifier used for safe logging of author ids.
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function shortHash(value) {
  if (!value) return "none";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
