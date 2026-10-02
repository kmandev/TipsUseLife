/**
 * Read-only post discovery (Phase AM-2): run, store, list.
 *
 * ISOLATION CONTRACT
 *   - Reads Facebook with GET only (facebook-posts.js).
 *   - Writes ONLY post_candidates and discovery_runs.
 *   - Never creates, changes or deactivates a content mapping, never calls
 *     the comment-reply pipeline or the Facebook reply sender, never talks
 *     to Hermes. The reply pipeline never reads these tables.
 *   - Idempotent: running it again changes nothing unless a post is new or
 *     its text was edited.
 *   - Overlap-safe: a RUNNING row younger than STALE_RUN_SECONDS blocks a
 *     second run (atomic INSERT ... WHERE NOT EXISTS).
 */

import {
  fetchPageContent,
  canonicalReelIdFromPermalink,
  DISCOVERY_EDGE_DEADLINE_MS,
  DISCOVERY_TOTAL_DEADLINE_MS,
} from "./facebook-posts.js";
import { logEvent, logError } from "./log.js";

/** A RUNNING row older than this is treated as abandoned (Worker was killed). */
export const STALE_RUN_SECONDS = 300;
export const MAX_STORED_MESSAGE_CHARS = 2000;
const IN_CHUNK = 40; // D1 allows 100 bound parameters per statement

/** Order matters: reels first so a reel also listed under posts keeps REEL. */
const SOURCE_ORDER = ["reels", "posts"];

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? "")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @returns {Promise<{ok: true, runId: number} | {ok: false, code: "ALREADY_RUNNING"}>}
 */
async function acquireRun(db, pageId) {
  // Mark abandoned runs first, so they never block forever.
  await db
    .prepare(
      `UPDATE discovery_runs
          SET status = 'FAILED', error_code = 'RUN_ABANDONED', finished_at = datetime('now')
        WHERE page_id = ? AND status = 'RUNNING'
          AND started_at <= datetime('now', ?)`
    )
    .bind(pageId, `-${STALE_RUN_SECONDS} seconds`)
    .run();
  const row = await db
    .prepare(
      `INSERT INTO discovery_runs (page_id, status)
       SELECT ?1, 'RUNNING'
        WHERE NOT EXISTS (SELECT 1 FROM discovery_runs WHERE page_id = ?1 AND status = 'RUNNING')
       RETURNING id`
    )
    .bind(pageId)
    .first();
  return row ? { ok: true, runId: Number(row.id) } : { ok: false, code: "ALREADY_RUNNING" };
}

/**
 * Upsert one source's items. Returns counters; per-item D1 failures are
 * counted, not thrown, so one bad row cannot hide the rest.
 */
async function storeItems(db, pageId, items, counters) {
  const existing = new Map();
  for (const group of chunks(items, IN_CHUNK)) {
    const marks = group.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT post_id, content_hash FROM post_candidates WHERE page_id = ? AND post_id IN (${marks})`)
      .bind(pageId, ...group.map((i) => i.post_id))
      .all();
    for (const r of rows?.results ?? []) existing.set(String(r.post_id), String(r.content_hash));
  }

  const unchangedIds = [];
  for (const item of items) {
    const hash = await sha256Hex(item.message ?? "");
    const stored = item.message === null ? null : item.message.slice(0, MAX_STORED_MESSAGE_CHARS);
    const known = existing.get(item.post_id);
    try {
      if (known === undefined) {
        const inserted = await db
          .prepare(
            `INSERT INTO post_candidates
               (page_id, post_id, content_type, message, permalink, fb_created_time, source_status_type,
                content_hash, discovery_source, canonical_reel_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED')
             ON CONFLICT(page_id, post_id) DO NOTHING
             RETURNING id`
          )
          .bind(pageId, item.post_id, item.content_type, stored, item.permalink, item.fb_created_time, item.source_status_type, hash, item.discovery_source, item.canonical_reel_id ?? null)
          .first();
        if (inserted) {
          counters.inserted += 1;
          continue;
        }
        // Lost a race with another writer: treat as already known and refresh below.
      }
      if (known === hash) {
        unchangedIds.push(item.post_id);
        counters.unchanged += 1;
        continue;
      }
      // Edited content (or a raced insert with different content).
      const edit = await db
        .prepare(
          `UPDATE post_candidates
              SET message = ?, content_hash = ?, permalink = COALESCE(?, permalink),
                  fb_created_time = COALESCE(?, fb_created_time),
                  content_type = COALESCE(?, content_type),
                  source_status_type = COALESCE(?, source_status_type),
                  canonical_reel_id = COALESCE(canonical_reel_id, ?),
                  status = 'UPDATED', revision = revision + 1,
                  content_changed_at = datetime('now'), last_seen_at = datetime('now'),
                  updated_at = datetime('now')
            WHERE page_id = ? AND post_id = ? AND content_hash <> ?`
        )
        .bind(stored, hash, item.permalink, item.fb_created_time, item.content_type, item.source_status_type, item.canonical_reel_id ?? null, pageId, item.post_id, hash)
        .run();
      if (Number(edit?.meta?.changes ?? 0) > 0) counters.updated += 1;
      else counters.unchanged += 1;
    } catch {
      counters.failed += 1;
    }
  }

  for (const group of chunks(unchangedIds, IN_CHUNK)) {
    const marks = group.map(() => "?").join(",");
    try {
      await db
        .prepare(`UPDATE post_candidates SET last_seen_at = datetime('now') WHERE page_id = ? AND post_id IN (${marks})`)
        .bind(pageId, ...group)
        .run();
    } catch {
      // last_seen_at is informational; the content itself was already compared.
    }
  }
}

/**
 * Run one bounded discovery. Never throws for Facebook or per-item
 * failures; those are reported in the summary.
 *
 * @param {{db: any, env: any, config: any, fetchImpl?: typeof fetch,
 *          budget?: {edgeDeadlineMs?: number, totalDeadlineMs?: number}}} deps
 * @returns {Promise<{ok: boolean, code?: string, summary?: object}>}
 */
export async function runDiscovery({ db, env, config, fetchImpl, budget }) {
  if (!env?.PAGE_ACCESS_TOKEN) return { ok: false, code: "TOKEN_MISSING" };

  const lock = await acquireRun(db, config.pageId);
  if (!lock.ok) return { ok: false, code: lock.code };

  const counters = { discovered: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const sources = [];
  let truncated = false;
  let runStatus = "FAILED";
  let errorCode = null;
  // Each edge gets its own deadline (a slow edge cannot starve the other);
  // the total deadline is the hard outer bound for the whole run.
  const edgeMs = Number(budget?.edgeDeadlineMs) > 0 ? Number(budget.edgeDeadlineMs) : DISCOVERY_EDGE_DEADLINE_MS;
  const totalMs = Number(budget?.totalDeadlineMs) > 0 ? Number(budget.totalDeadlineMs) : DISCOVERY_TOTAL_DEADLINE_MS;
  const totalDeadlineAt = Date.now() + totalMs;

  try {
    const merged = new Map();
    for (const name of SOURCE_ORDER) {
      const read = await fetchPageContent(name, {
        pageId: config.pageId,
        accessToken: env.PAGE_ACCESS_TOKEN,
        graphApiVersion: config.graphApiVersion,
        deadlineAt: Math.min(Date.now() + edgeMs, totalDeadlineAt),
        fetchImpl,
      });
      counters.skipped += read.skipped;
      if (read.truncated) truncated = true;
      sources.push({
        source: name,
        ok: read.error === null,
        error_code: read.error?.category ?? null,
        graph_code: read.error?.graphCode ?? null,
        http_status: read.error?.statusCode ?? null,
        pages: read.pages,
        items: read.items.length,
        complete: read.complete,
        truncated: read.truncated,
      });
      for (const item of read.items) {
        if (merged.has(item.post_id)) counters.skipped += 1; // same post under two edges
        else merged.set(item.post_id, item);
      }
    }

    const items = [...merged.values()];
    counters.discovered = items.length;
    await storeItems(db, config.pageId, items, counters);
    // Idempotent: only fills canonical_reel_id where it is still NULL.
    try {
      await backfillCanonicalReelIds(db, config.pageId);
    } catch {
      // A derived grouping key; never fails the run.
    }

    const okCount = sources.filter((s) => s.ok).length;
    if (okCount === 0) {
      runStatus = "FAILED";
      errorCode = sources[0]?.error_code ?? "DISCOVERY_FAILED";
    } else if (okCount < sources.length || counters.failed > 0) {
      runStatus = "PARTIAL";
      errorCode = sources.find((s) => !s.ok)?.error_code ?? (counters.failed > 0 ? "ITEM_WRITE_FAILED" : null);
    } else {
      runStatus = "OK";
    }
  } catch {
    runStatus = "FAILED";
    errorCode = "INTERNAL_ERROR";
    logError("discovery_failed", "UNHANDLED_EXCEPTION");
  }

  const summary = { run_id: lock.runId, status: runStatus, error_code: errorCode, ...counters, truncated, sources };
  try {
    await db
      .prepare(
        `UPDATE discovery_runs
            SET status = ?, finished_at = datetime('now'), discovered = ?, inserted = ?, updated = ?,
                unchanged = ?, skipped = ?, failed = ?, truncated = ?, detail = ?, error_code = ?
          WHERE id = ?`
      )
      .bind(
        runStatus, counters.discovered, counters.inserted, counters.updated, counters.unchanged,
        counters.skipped, counters.failed, truncated ? 1 : 0, JSON.stringify(sources), errorCode, lock.runId
      )
      .run();
  } catch {
    logError("discovery_run_record_failed", "D1_UPDATE_FAILED", { run_id: lock.runId });
  }
  logEvent("discovery_run", { run_id: lock.runId, status: runStatus, error_code: errorCode, ...counters, truncated });
  return { ok: runStatus !== "FAILED", code: runStatus === "FAILED" ? errorCode : undefined, summary };
}

/* ------------------------------ backfill ------------------------------ */

/**
 * Populate canonical_reel_id for existing candidates from their stored
 * permalink. Deterministic and idempotent: it only touches rows whose
 * canonical_reel_id IS NULL, writes only that column, never changes post_id,
 * never deletes, and never reads or writes content_mappings. Rows whose
 * permalink is not an explicit Reel permalink stay NULL.
 *
 * @returns {Promise<{scanned: number, updated: number}>}
 */
export async function backfillCanonicalReelIds(db, pageId, { limit = 500 } = {}) {
  const found = await db
    .prepare(
      `SELECT id, permalink FROM post_candidates
        WHERE page_id = ? AND canonical_reel_id IS NULL AND permalink LIKE '%/reel/%'
        ORDER BY id LIMIT ?`
    )
    .bind(pageId, limit)
    .all();
  let updated = 0;
  for (const row of found?.results ?? []) {
    const canonical = canonicalReelIdFromPermalink(row.permalink);
    if (!canonical) continue;
    const result = await db
      .prepare(`UPDATE post_candidates SET canonical_reel_id = ? WHERE id = ? AND canonical_reel_id IS NULL`)
      .bind(canonical, row.id)
      .run();
    updated += Number(result?.meta?.changes ?? 0);
  }
  return { scanned: (found?.results ?? []).length, updated };
}

/* ------------------------------ queries ------------------------------ */

export const CANDIDATE_STATUSES = ["DISCOVERED", "UPDATED"];
export const MAPPING_FILTERS = ["mapped", "unmapped", "inactive"];

/**
 * LOGICAL candidates: one item per logical content. Source rows are never
 * merged or deleted -- grouping happens only here, at read time.
 *
 * Logical identity:
 *   same page + same non-null canonical_reel_id  -> one logical Reel
 *   canonical_reel_id NULL                        -> (page_id, post_id) itself
 *
 * REPRESENTATIVE of a group (the row whose fields are shown, and whose
 * post_id decides the mapping state), first match wins:
 *   1. a row whose post_id matches an existing content_mappings row
 *      (an ACTIVE mapping before an inactive one);
 *   2. otherwise the posts-edge row (its `<page>_<n>` id is the form comment
 *      webhooks, and therefore content_mappings, use);
 *   3. otherwise the reels-edge row;
 *   4. ties: the lowest candidate id.
 * No `<page>_<n>` id is ever fabricated and content_mappings is only read.
 *
 * mapping_state: NONE (no mapping row for the representative's post_id),
 * ACTIVE, INACTIVE. Filters apply to the logical result. Keyset pagination
 * on group_id (the newest source row id of the group), newest first.
 */
export async function listCandidates(db, pageId, { status = null, mapping = null, beforeId = null, limit = 25 } = {}) {
  const where = ["rn = 1"];
  const args = [pageId];
  if (status) { where.push("status = ?"); args.push(status); }
  if (mapping === "mapped") where.push("mapping_state = 'ACTIVE'");
  else if (mapping === "inactive") where.push("mapping_state = 'INACTIVE'");
  else if (mapping === "unmapped") where.push("mapping_state = 'NONE'");
  if (beforeId) { where.push("group_id < ?"); args.push(beforeId); }
  const result = await db
    .prepare(
      `WITH base AS (
         SELECT c.id, c.post_id, c.content_type, c.message, c.permalink, c.fb_created_time,
                c.source_status_type, c.discovery_source, c.status, c.revision,
                c.first_seen_at, c.last_seen_at, c.content_changed_at, c.canonical_reel_id,
                CASE WHEN c.canonical_reel_id IS NOT NULL THEN 'r:' || c.canonical_reel_id
                     ELSE 'p:' || c.post_id END AS gkey,
                CASE WHEN m.id IS NULL THEN 'NONE' WHEN m.active = 1 THEN 'ACTIVE' ELSE 'INACTIVE' END AS mapping_state,
                CASE WHEN m.id IS NULL THEN 2 WHEN m.active = 1 THEN 0 ELSE 1 END AS map_rank,
                CASE WHEN c.discovery_source = 'posts' THEN 0 ELSE 1 END AS src_rank
           FROM post_candidates c
           LEFT JOIN content_mappings m
             ON m.facebook_page_id = c.page_id AND m.facebook_post_id = c.post_id
          WHERE c.page_id = ?
       ),
       ranked AS (
         SELECT base.*,
                ROW_NUMBER() OVER (PARTITION BY gkey ORDER BY map_rank, src_rank, id) AS rn,
                COUNT(*) OVER (PARTITION BY gkey) AS source_count,
                MAX(id) OVER (PARTITION BY gkey) AS group_id,
                GROUP_CONCAT(post_id, ',') OVER (PARTITION BY gkey) AS source_ids
           FROM base
       )
       SELECT id, post_id, content_type, message, permalink, fb_created_time, source_status_type,
              discovery_source, status, revision, first_seen_at, last_seen_at, content_changed_at,
              canonical_reel_id, mapping_state, source_count, source_ids, group_id
         FROM ranked
        WHERE ${where.join(" AND ")}
        ORDER BY group_id DESC
        LIMIT ?`
    )
    .bind(...args, limit)
    .all();
  return (result?.results ?? []).map(({ source_ids, ...row }) => ({
    ...row,
    representative_post_id: row.post_id,
    source_post_ids: String(source_ids ?? row.post_id).split(",").sort(),
  }));
}

export async function listRuns(db, pageId, limit = 10) {
  const result = await db
    .prepare(
      `SELECT id, status, started_at, finished_at, discovered, inserted, updated, unchanged, skipped,
              failed, truncated, error_code, detail
         FROM discovery_runs WHERE page_id = ? ORDER BY id DESC LIMIT ?`
    )
    .bind(pageId, limit)
    .all();
  return (result?.results ?? []).map((r) => {
    let sources = null;
    try { sources = r.detail ? JSON.parse(r.detail) : null; } catch { sources = null; }
    const { detail, ...rest } = r;
    return { ...rest, sources };
  });
}
