/**
 * Hermes webhook gateway client.
 *
 * The contract with Hermes is unchanged from the working ingestion path:
 * POST JSON, signed with HMAC-SHA256 over the exact request body using
 * HERMES_SECRET, in an `X-Hub-Signature-256: sha256=<hex>` header.
 *
 * What DID change: we forward a normalized, minimal payload instead of
 * the raw Meta envelope. The signature is computed over that exact
 * serialized body, so Hermes-side verification is unaffected.
 */

import { hmacSha256Hex } from "./crypto.js";

export class HermesError extends Error {
  /**
   * @param {string} category stable, secret-free error category
   * @param {number|null} [statusCode]
   */
  constructor(category, statusCode = null) {
    super(category);
    this.name = "HermesError";
    this.category = category;
    this.statusCode = statusCode;
  }
}

/**
 * @param {object} payload normalized event
 * @param {{url: string, secret: string, timeoutMs?: number}} options
 * @returns {Promise<unknown>} decoded JSON body, or the raw text when the
 *   response is not JSON (the AI layer copes with both)
 */
export async function sendToHermes(payload, { url, secret, timeoutMs = 25000 }) {
  if (!secret) throw new HermesError("HERMES_SECRET_MISSING");
  if (!url) throw new HermesError("HERMES_URL_MISSING");

  const body = JSON.stringify(payload);
  const signature = await hmacSha256Hex(secret, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    // Never surface the raw error message: it can echo request details.
    throw new HermesError(
      error?.name === "AbortError" ? "HERMES_TIMEOUT" : "HERMES_NETWORK_ERROR"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new HermesError("HERMES_HTTP_ERROR", response.status);
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
