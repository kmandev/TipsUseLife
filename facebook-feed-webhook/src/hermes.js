/**
 * Hermes client -- OpenAI-compatible synchronous chat completions.
 *
 * ARCHITECTURE (see docs/ARCHITECTURE.md)
 * ---------------------------------------
 * Worker --HTTPS--> Cloudflare Tunnel --> edge proxy (127.0.0.1:8644)
 *        --> Hermes api_server (127.0.0.1:8642)  POST /v1/chat/completions
 *
 * The request is awaited: Hermes runs the agent and returns the final
 * assistant text in `choices[0].message.content` of the same HTTP
 * response. (The older `/webhooks/{route}` platform replies 202 before the
 * agent runs and cannot return a result, so it is no longer used.)
 *
 * AUTH: `Authorization: Bearer <HERMES_API_KEY>` -- Hermes refuses to start
 * the API server without a strong key and checks it with a constant-time
 * compare on every request.
 *
 * IDEMPOTENCY: `Idempotency-Key: fbc:<comment_id>`. Hermes caches the
 * result per key for 5 minutes, so an accidental retry of the same comment
 * returns the cached answer instead of running (and billing) the model
 * again. The Worker never retries on its own -- see pipeline.js.
 *
 * Errors are surfaced as HermesError with a stable, secret-free category.
 */

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
 * @param {{systemPrompt: string, userMessage: string, idempotencyKey?: string}} request
 * @param {{url: string, apiKey: string, timeoutMs?: number, fetchImpl?: typeof fetch}} options
 * @returns {Promise<string>} the assistant message content
 */
export async function requestAgentReply(request, options) {
  const { url, apiKey, timeoutMs = 25000, fetchImpl = fetch } = options || {};
  if (!apiKey) throw new HermesError("HERMES_API_KEY_MISSING");
  if (!url) throw new HermesError("HERMES_URL_MISSING");

  const body = JSON.stringify({
    stream: false,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userMessage },
    ],
  });

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (request.idempotencyKey) headers["idempotency-key"] = request.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
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

  if (response.status === 401 || response.status === 403) {
    throw new HermesError("HERMES_UNAUTHORIZED", response.status);
  }
  if (response.status === 429) throw new HermesError("HERMES_BUSY", 429);
  if (!response.ok) throw new HermesError("HERMES_HTTP_ERROR", response.status);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new HermesError("HERMES_RESPONSE_NOT_JSON", response.status);
  }

  if (data?.hermes && (data.hermes.failed || data.hermes.completed === false)) {
    throw new HermesError("HERMES_RUN_INCOMPLETE", response.status);
  }

  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  if (!choice) throw new HermesError("HERMES_RESPONSE_NO_CHOICES", response.status);

  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new HermesError("HERMES_RESPONSE_NO_CONTENT", response.status);
  }

  return content;
}
