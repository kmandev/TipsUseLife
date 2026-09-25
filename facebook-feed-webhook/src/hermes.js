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
 * again.
 *
 * BACKPRESSURE: the ONLY retried outcome is HTTP 429 from Hermes' concurrent-
 * run cap (gateway.api_server.max_concurrent_runs, default 10). Hermes
 * rejects such a request before any agent run starts, so nothing was
 * executed and a retry cannot duplicate work. See
 * requestAgentReplyWithBackpressure(): bounded attempts, jittered backoff,
 * one overall deadline. Timeouts, network errors, 5xx and every other
 * failure are never retried.
 *
 * Errors are surfaced as HermesError with a stable, secret-free category.
 */

export class HermesError extends Error {
  /**
   * @param {string} category stable, secret-free error category
   * @param {number|null} [statusCode]
   */
  constructor(category, statusCode = null, retryAfterMs = null) {
    super(category);
    this.name = "HermesError";
    this.category = category;
    this.statusCode = statusCode;
    /** Parsed Retry-After (429 only), in ms; null when absent/invalid. */
    this.retryAfterMs = retryAfterMs;
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
  if (response.status === 429) {
    throw new HermesError("HERMES_BUSY", 429, parseRetryAfterMs(response.headers?.get?.("retry-after")));
  }
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

/** Retry-After as delta-seconds only (Hermes sends "1"); null otherwise. */
export function parseRetryAfterMs(value) {
  if (typeof value !== "string" || !/^\s*\d{1,3}\s*$/.test(value)) return null;
  return Number(value) * 1000;
}

export const BACKPRESSURE_DEFAULTS = Object.freeze({
  // Total attempts including the first one.
  maxAttempts: 4,
  // Never start an attempt with less than this much of the deadline left:
  // a real run takes ~3-12 s, so a late attempt would only time out.
  minAttemptBudgetMs: 10000,
  // Backoff before attempt n (n >= 2): max(Retry-After, n-1 s) capped at
  // 3 s, plus 0-1000 ms jitter so a burst does not retry in lock-step.
  baseDelayMs: 1000,
  maxDelayMs: 3000,
  jitterMs: 1000,
});

/**
 * requestAgentReply() with bounded backpressure for Hermes' concurrency cap.
 *
 * - Retries ONLY HermesError("HERMES_BUSY") (HTTP 429). Nothing else.
 * - At most `maxAttempts` attempts, all inside ONE deadline of `timeoutMs`
 *   measured from the first attempt; each attempt's own timeout is the
 *   remaining budget, so the total can never exceed `timeoutMs`.
 * - Same Idempotency-Key on every attempt.
 * - When the budget or the attempts run out, the last HERMES_BUSY error is
 *   thrown unchanged, so the caller's fail-closed path is unchanged.
 *
 * @param {Parameters<typeof requestAgentReply>[0]} request
 * @param {Parameters<typeof requestAgentReply>[1]} options
 * @param {{maxAttempts?: number, minAttemptBudgetMs?: number, baseDelayMs?: number,
 *          maxDelayMs?: number, jitterMs?: number, now?: () => number,
 *          sleep?: (ms: number) => Promise<void>, random?: () => number,
 *          onRetry?: (info: {attempt: number, delayMs: number}) => void}} [policy]
 * @returns {Promise<{content: string, attempts: number}>}
 */
export async function requestAgentReplyWithBackpressure(request, options, policy = {}) {
  const p = { ...BACKPRESSURE_DEFAULTS, ...policy };
  const now = p.now || (() => Date.now());
  const sleep = p.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = p.random || Math.random;
  const totalMs = options?.timeoutMs ?? 25000;
  const deadline = now() + totalMs;

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - now();
    try {
      const content = await requestAgentReply(request, { ...options, timeoutMs: Math.max(1, remaining) });
      return { content, attempts: attempt };
    } catch (error) {
      const busy = error instanceof HermesError && error.category === "HERMES_BUSY";
      if (!busy || attempt >= p.maxAttempts) throw error;

      const backoff = Math.min(Math.max(error.retryAfterMs ?? 0, p.baseDelayMs * attempt), p.maxDelayMs);
      const delayMs = Math.round(backoff + random() * p.jitterMs);
      // Only retry if, after waiting, a full attempt budget is still left.
      if (deadline - now() - delayMs < p.minAttemptBudgetMs) throw error;

      p.onRetry?.({ attempt, delayMs });
      await sleep(delayMs);
    }
  }
}
