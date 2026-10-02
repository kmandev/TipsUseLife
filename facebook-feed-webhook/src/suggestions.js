/**
 * Product mapping SUGGESTIONS (Phase AM-2.3) -- review only.
 *
 * Flow (manual, admin-triggered only):
 *   unmapped logical post/Reel (discovery.js listCandidates, AM-2.2 identity)
 *     -> deterministic prefilter (suggestion-prefilter.js), at most 5 candidates
 *     -> zero candidates: no AI call
 *     -> Hermes (hermes.js requestAgentReply, reused unchanged) with the caption
 *        as JSON data and the closed candidate list
 *     -> strict validation: product_id must be in that exact candidate set
 *     -> product_suggestions (PENDING) for human review
 *
 * ISOLATION CONTRACT
 *   - Writes ONLY product_suggestions and suggestion_runs.
 *   - Never writes content_mappings, products, comments or replies; a human
 *     maps through the existing manual mapping form.
 *   - Never calls Facebook, the reply pipeline, the reply sender, ai.js or
 *     affiliate.js. Not reachable from the webhook.
 *   - Serial, bounded (MAX_AI_CALLS_PER_RUN, per-call and total deadlines),
 *     no retry; a Hermes 429 skips that item. One run at a time.
 */

import { requestAgentReply, HermesError } from "./hermes.js";
import { listCandidates, sha256Hex } from "./discovery.js";
import { prefilterProducts, MAX_CANDIDATES } from "./suggestion-prefilter.js";
import {
  SUGGESTION_SYSTEM_PROMPT,
  SUGGESTION_PROMPT_VERSION,
  MAX_REASON_CHARS,
  buildSuggestionUserMessage,
} from "./suggestion-prompt.js";
import { logEvent, logError } from "./log.js";

export const MAX_AI_CALLS_PER_RUN = 5;
export const PER_CALL_TIMEOUT_MS = 15000;
export const TOTAL_RUN_TIMEOUT_MS = 60000;
/** Below this much remaining budget no new AI call is started. */
export const MIN_CALL_BUDGET_MS = 3000;
export const STALE_RUN_SECONDS = 300;
const MAX_SUBJECTS = 500;
const CONFIDENCES = ["HIGH", "MEDIUM", "LOW"];
const URL_RE = /(?:https?:\/\/|www\.)\S+/i;

/** The logical identity used since AM-2.2. Never fabricates an id. */
export function subjectKeyOf(item) {
  return item.canonical_reel_id ? `r:${item.canonical_reel_id}` : `p:${item.post_id}`;
}

/** A mapping can only be keyed by a real `<page>_<n>` id, never a bare reel id. */
export function isMappableRepresentative(postId) {
  return /^[0-9]{5,}_[0-9]+$/.test(String(postId ?? ""));
}

/* ------------------------------ validator ------------------------------ */

/**
 * Strict validation of the model output against the EXACT candidate set.
 * Accepts the JSON object alone, optionally inside one ```json fence.
 * Anything else fails closed.
 * @returns {{ok: true, value: {product_id: number|null, confidence: string, reason: string}} | {ok: false, reason: string}}
 */
export function validateSuggestionResponse(raw, candidateIds) {
  if (typeof raw !== "string") return { ok: false, reason: "AI_OUTPUT_NOT_TEXT" };
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1].trim();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "AI_OUTPUT_NOT_JSON" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "AI_OUTPUT_NOT_OBJECT" };
  const keys = Object.keys(data).sort().join(",");
  if (keys !== "confidence,product_id,reason") return { ok: false, reason: "AI_OUTPUT_FIELDS" };

  const allowed = new Set([...candidateIds].map(Number));
  const id = data.product_id;
  if (id !== null) {
    if (!Number.isInteger(id)) return { ok: false, reason: "AI_OUTPUT_PRODUCT_ID_TYPE" };
    if (!allowed.has(id)) return { ok: false, reason: "AI_OUTPUT_PRODUCT_NOT_CANDIDATE" };
  }
  if (!CONFIDENCES.includes(data.confidence)) return { ok: false, reason: "AI_OUTPUT_CONFIDENCE" };
  if (typeof data.reason !== "string") return { ok: false, reason: "AI_OUTPUT_REASON_TYPE" };
  const reason = data.reason.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if (!reason || [...reason].length > MAX_REASON_CHARS) return { ok: false, reason: "AI_OUTPUT_REASON_LENGTH" };
  if (URL_RE.test(reason)) return { ok: false, reason: "AI_OUTPUT_REASON_URL" };
  return { ok: true, value: { product_id: id, confidence: data.confidence, reason } };
}

/* -------------------------------- lock -------------------------------- */

async function acquireRun(db, pageId) {
  await db
    .prepare(
      `UPDATE suggestion_runs
          SET status = 'FAILED', error_code = 'RUN_ABANDONED', finished_at = datetime('now')
        WHERE page_id = ? AND status = 'RUNNING' AND started_at <= datetime('now', ?)`
    )
    .bind(pageId, `-${STALE_RUN_SECONDS} seconds`)
    .run();
  const row = await db
    .prepare(
      `INSERT INTO suggestion_runs (page_id, status)
       SELECT ?1, 'RUNNING'
        WHERE NOT EXISTS (SELECT 1 FROM suggestion_runs WHERE page_id = ?1 AND status = 'RUNNING')
       RETURNING id`
    )
    .bind(pageId)
    .first();
  return row ? Number(row.id) : null;
}

/* ------------------------------- generate ------------------------------ */

/**
 * One manual, bounded, serial generation run. Never throws for AI or
 * per-item failures; they are counted.
 *
 * @param {{db: any, env: any, config: any, fetchImpl?: typeof fetch,
 *          limits?: {maxCalls?: number, perCallTimeoutMs?: number, totalTimeoutMs?: number}}} deps
 * @returns {Promise<{ok: boolean, code?: string, summary?: object}>}
 */
export async function generateSuggestions({ db, env, config, fetchImpl, limits }) {
  if (!env?.HERMES_API_KEY || !config?.hermesUrl) return { ok: false, code: "HERMES_NOT_CONFIGURED" };
  const maxCalls = Number(limits?.maxCalls) > 0 ? Math.min(Number(limits.maxCalls), MAX_AI_CALLS_PER_RUN) : MAX_AI_CALLS_PER_RUN;
  const perCallMs = Number(limits?.perCallTimeoutMs) > 0 ? Number(limits.perCallTimeoutMs) : PER_CALL_TIMEOUT_MS;
  const totalMs = Number(limits?.totalTimeoutMs) > 0 ? Number(limits.totalTimeoutMs) : TOTAL_RUN_TIMEOUT_MS;
  const minCallMs = Math.min(MIN_CALL_BUDGET_MS, perCallMs);

  const runId = await acquireRun(db, config.pageId);
  if (!runId) return { ok: false, code: "ALREADY_RUNNING" };

  const deadline = Date.now() + totalMs;
  const c = { eligible: 0, processed: 0, suggested: 0, no_match: 0, skipped: 0, failed: 0, superseded: 0 };
  let errorCode = null;
  let fatal = false;

  try {
    // Logical items (AM-2.2): mapped ones are excluded; inactive mappings count as mapped.
    const all = await listCandidates(db, config.pageId, { limit: MAX_SUBJECTS });
    const mappedKeys = new Set(all.filter((i) => i.mapping_state !== "NONE").map(subjectKeyOf));
    const unmapped = all.filter((i) => i.mapping_state === "NONE");

    // Stale PENDING suggestions: the subject got mapped, or its text changed.
    const pending = await db
      .prepare(`SELECT id, subject_key, content_hash FROM product_suggestions WHERE page_id = ? AND status = 'PENDING'`)
      .bind(config.pageId)
      .all();
    const currentHash = new Map();
    for (const item of unmapped) currentHash.set(subjectKeyOf(item), await sha256Hex(item.message ?? ""));
    for (const s of pending?.results ?? []) {
      const mapped = mappedKeys.has(s.subject_key);
      const changed = currentHash.has(s.subject_key) && currentHash.get(s.subject_key) !== s.content_hash;
      if (mapped || changed) {
        const r = await db
          .prepare(`UPDATE product_suggestions SET status = 'SUPERSEDED', updated_at = datetime('now') WHERE id = ? AND status = 'PENDING'`)
          .bind(s.id)
          .run();
        c.superseded += Number(r?.meta?.changes ?? 0);
      }
    }

    const productsRes = await db
      .prepare(`SELECT id, name, keywords, description, active, deleted_at FROM products WHERE active = 1 AND deleted_at IS NULL`)
      .all();
    const products = productsRes?.results ?? [];
    const byId = new Map(products.map((p) => [Number(p.id), p]));

    const work = [];
    for (const item of unmapped) {
      const subject = subjectKeyOf(item);
      const hash = currentHash.get(subject);
      const ranked = prefilterProducts(item.message ?? "", products, { maxCandidates: MAX_CANDIDATES });
      if (ranked.length === 0) {
        c.skipped += 1; // no deterministic signal -> no AI call
        continue;
      }
      const already = await db
        .prepare(`SELECT 1 AS x FROM product_suggestions WHERE page_id = ? AND subject_key = ? AND content_hash = ? LIMIT 1`)
        .bind(config.pageId, subject, hash)
        .first();
      if (already) {
        c.skipped += 1; // already suggested (or rejected) for this exact text
        continue;
      }
      work.push({ item, subject, hash, ranked });
    }
    c.eligible = work.length;

    for (const w of work) {
      if (c.processed >= maxCalls) {
        c.skipped += 1;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining < minCallMs) {
        c.skipped += 1;
        errorCode = errorCode ?? "RUN_BUDGET_EXHAUSTED";
        continue;
      }
      c.processed += 1;
      const candidates = w.ranked.map((r) => byId.get(r.product_id)).filter(Boolean);
      const candidateIds = candidates.map((p) => Number(p.id));
      let raw;
      try {
        raw = await requestAgentReply(
          {
            systemPrompt: SUGGESTION_SYSTEM_PROMPT,
            userMessage: buildSuggestionUserMessage(w.item.message ?? "", candidates),
            idempotencyKey: `sug:${w.subject}:${w.hash.slice(0, 16)}`,
          },
          { url: config.hermesUrl, apiKey: env.HERMES_API_KEY, timeoutMs: Math.min(perCallMs, remaining), fetchImpl }
        );
      } catch (error) {
        const category = error instanceof HermesError ? error.category : "HERMES_ERROR";
        if (category === "HERMES_BUSY") {
          c.skipped += 1; // Hermes is at capacity: leave it, never retry here
        } else {
          c.failed += 1;
        }
        errorCode = errorCode ?? category;
        continue;
      }
      const checked = validateSuggestionResponse(raw, candidateIds);
      if (!checked.ok) {
        c.failed += 1;
        errorCode = errorCode ?? checked.reason;
        continue;
      }
      const v = checked.value;
      const score = v.product_id === null ? w.ranked[0].score : w.ranked.find((r) => r.product_id === v.product_id)?.score ?? 0;
      try {
        const inserted = await db
          .prepare(
            `INSERT INTO product_suggestions
               (page_id, subject_key, representative_post_id, product_id, rank, confidence, prefilter_score,
                source, reason, model, prompt_version, content_hash, status)
             VALUES (?, ?, ?, ?, 1, ?, ?, 'AI', ?, NULL, ?, ?, 'PENDING')
             ON CONFLICT DO NOTHING
             RETURNING id`
          )
          .bind(config.pageId, w.subject, String(w.item.representative_post_id), v.product_id, v.confidence, score, v.reason, SUGGESTION_PROMPT_VERSION, w.hash)
          .first();
        if (!inserted) c.skipped += 1;
        else if (v.product_id === null) c.no_match += 1;
        else c.suggested += 1;
      } catch {
        c.failed += 1;
        errorCode = errorCode ?? "D1_INSERT_FAILED";
      }
    }
  } catch {
    fatal = true;
    errorCode = "INTERNAL_ERROR";
    logError("suggestion_run_failed", "UNHANDLED_EXCEPTION");
  }

  let status;
  if (fatal) status = "FAILED";
  else if (c.failed === 0) status = "OK";
  else if (c.suggested + c.no_match > 0) status = "PARTIAL";
  else status = "FAILED";

  try {
    await db
      .prepare(
        `UPDATE suggestion_runs
            SET status = ?, finished_at = datetime('now'), eligible = ?, processed = ?, suggested = ?, no_match = ?,
                skipped = ?, failed = ?, superseded = ?, error_code = ?
          WHERE id = ?`
      )
      .bind(status, c.eligible, c.processed, c.suggested, c.no_match, c.skipped, c.failed, c.superseded, errorCode, runId)
      .run();
  } catch {
    logError("suggestion_run_record_failed", "D1_UPDATE_FAILED", { run_id: runId });
  }
  logEvent("suggestion_run", { run_id: runId, status, error_code: errorCode, ...c });
  return { ok: status !== "FAILED", code: status === "FAILED" ? errorCode : undefined, summary: { run_id: runId, status, error_code: errorCode, ...c } };
}

/* ------------------------------- queries ------------------------------- */

export const SUGGESTION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUPERSEDED"];

/**
 * Suggestions newest first (keyset on id), with the product name, whether
 * the product is still usable, the post text of the representative, and
 * whether the existing manual mapping form may be pre-filled (`mappable`:
 * PENDING, a real product, a usable product and a `<page>_<n>`
 * representative -- a bare reel id is never offered).
 */
export async function listSuggestions(db, pageId, { status = null, beforeId = null, limit = 25 } = {}) {
  const where = ["s.page_id = ?"];
  const args = [pageId];
  if (status) { where.push("s.status = ?"); args.push(status); }
  if (beforeId) { where.push("s.id < ?"); args.push(beforeId); }
  const result = await db
    .prepare(
      `SELECT s.id, s.subject_key, s.representative_post_id, s.product_id, s.rank, s.confidence,
              s.prefilter_score, s.source, s.reason, s.prompt_version, s.status, s.decided_at, s.created_at,
              p.name AS product_name, p.active AS product_active, p.deleted_at AS product_deleted_at,
              c.message, c.permalink, c.content_type
         FROM product_suggestions s
         LEFT JOIN products p ON p.id = s.product_id
         LEFT JOIN post_candidates c ON c.page_id = s.page_id AND c.post_id = s.representative_post_id
        WHERE ${where.join(" AND ")}
        ORDER BY s.id DESC
        LIMIT ?`
    )
    .bind(...args, limit)
    .all();
  return (result?.results ?? []).map(({ product_active, product_deleted_at, ...row }) => {
    const productUsable = row.product_id !== null && Number(product_active) === 1 && !product_deleted_at;
    return {
      ...row,
      product_usable: productUsable,
      mappable: row.status === "PENDING" && productUsable && isMappableRepresentative(row.representative_post_id),
    };
  });
}

/** PENDING -> REJECTED only. @returns {"REJECTED"|"NOT_FOUND"|"NOT_PENDING"} */
export async function rejectSuggestion(db, pageId, id) {
  const r = await db
    .prepare(
      `UPDATE product_suggestions SET status = 'REJECTED', decided_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND page_id = ? AND status = 'PENDING'`
    )
    .bind(id, pageId)
    .run();
  if (Number(r?.meta?.changes ?? 0) > 0) return "REJECTED";
  const exists = await db.prepare(`SELECT 1 AS x FROM product_suggestions WHERE id = ? AND page_id = ?`).bind(id, pageId).first();
  return exists ? "NOT_PENDING" : "NOT_FOUND";
}

export async function listSuggestionRuns(db, pageId, limit = 10) {
  const result = await db
    .prepare(
      `SELECT id, status, started_at, finished_at, eligible, processed, suggested, no_match, skipped, failed, superseded, error_code
         FROM suggestion_runs WHERE page_id = ? ORDER BY id DESC LIMIT ?`
    )
    .bind(pageId, limit)
    .all();
  return result?.results ?? [];
}
