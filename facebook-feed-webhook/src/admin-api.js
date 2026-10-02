/**
 * Dashboard JSON API (session-authenticated; see admin.js).
 *
 *   GET    /admin/api/overview
 *   GET    /admin/api/settings
 *   GET    /admin/api/products            ?search=&active=0|1
 *   POST   /admin/api/products
 *   PATCH  /admin/api/products/:id        (edit, or {active} toggle)
 *   DELETE /admin/api/products/:id        (soft delete)
 *   GET    /admin/api/content
 *   POST   /admin/api/content             (create or replace mapping for a post)
 *   PATCH  /admin/api/content/:id
 *   DELETE /admin/api/content/:id
 *   POST   /admin/api/discovery/run      one bounded, READ-ONLY post discovery run (AM-2)
 *   GET    /admin/api/discovery/runs      recent runs with safe error categories (AM-2)
 *   GET    /admin/api/post-candidates     ?status=&mapping=&limit=&cursor= (AM-2)
 *   GET    /admin/api/suggestions         ?status=&limit=&cursor= product suggestions (AM-2.3)
 *   POST   /admin/api/suggestions/generate  one manual, bounded AI suggestion run (AM-2.3)
 *   GET    /admin/api/suggestions/runs    recent suggestion runs (AM-2.3)
 *   POST   /admin/api/suggestions/:id/reject  PENDING -> REJECTED (AM-2.3)
 *   POST   /admin/api/suggestions/:id/approve HUMAN approval -> one content mapping (AM-2.4)
 *   GET    /admin/api/health              operational counts (Phase 8.2)
 *   GET    /admin/api/recovery            rows needing operator attention
 *   POST   /admin/api/comments/:id/retry  operator recovery of ONE comment
 *   POST   /admin/api/comments/:id/reconcile  link an AMBIGUOUS LIVE send to the
 *          reply Facebook already created (read-only Graph GET + CAS; no POST)
 *
 * Every write validates its input here, before D1, and never echoes
 * exception text. REPLY_MODE is deliberately NOT writable from here: moving
 * DRY_RUN -> LIVE is a deploy-time decision (wrangler.jsonc + secret).
 */

import { resolveConfig } from "./config.js";
import { validateAffiliateUrl } from "./affiliate.js";
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  setProductActive,
  softDeleteProduct,
  listMappings,
  listUnmappedPosts,
  getMapping,
  upsertMapping,
  updateMapping,
  deleteMapping,
  overviewStats,
} from "./admin-db.js";
import { runDiscovery, listCandidates, listRuns, CANDIDATE_STATUSES, MAPPING_FILTERS } from "./discovery.js";
import { generateSuggestions, listSuggestions, listSuggestionRuns, rejectSuggestion, approveSuggestion, SUGGESTION_STATUSES } from "./suggestions.js";
import { logEvent, logError } from "./log.js";
import { recoverComment, listRecoveryAttention, healthStats, reconcileComment, RECONCILE_REASONS } from "./recovery.js";

const PLATFORMS = ["shopee", "lazada", "tiktok", "other"];
const CONTENT_TYPES = ["POST", "REEL"];

export function apiJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });
}

export function apiError(status, code, message, extraHeaders = {}) {
  return apiJson({ error: { code, message } }, status, extraHeaders);
}

function invalid(field, message) {
  return apiError(400, "VALIDATION_ERROR", message, { "x-invalid-field": field });
}

/* ----------------------------- validation ----------------------------- */

function optText(value, max) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const v = value.trim();
  if (v.length > max) return { ok: false };
  return { ok: true, value: v.length ? v : null };
}

function toActive(value, fallback = 1) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return null;
}

/** @returns {{ok: true, value: object} | {ok: false, response: Response}} */
export function validateProductInput(body, allowedHosts) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: apiError(400, "INVALID_REQUEST", "Invalid request body") };
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 200) return { ok: false, response: invalid("name", "Name is required (max 200 characters)") };

  const url = validateAffiliateUrl(body.affiliate_url, allowedHosts);
  if (!url.ok) return { ok: false, response: invalid("affiliate_url", `Affiliate URL rejected: ${url.reason}`) };

  const platform = String(body.platform ?? "shopee").toLowerCase();
  if (!PLATFORMS.includes(platform)) return { ok: false, response: invalid("platform", "Unknown platform") };

  const description = optText(body.description, 2000);
  if (!description.ok) return { ok: false, response: invalid("description", "Description too long") };
  const keywords = optText(body.keywords, 1000);
  if (!keywords.ok) return { ok: false, response: invalid("keywords", "Keywords too long") };

  let imageUrl = null;
  if (body.image_url !== undefined && body.image_url !== null && String(body.image_url).trim() !== "") {
    // Images are display-only in the Dashboard; any https host is fine.
    const img = validateAffiliateUrl(String(body.image_url), []);
    if (!img.ok) return { ok: false, response: invalid("image_url", `Image URL rejected: ${img.reason}`) };
    imageUrl = img.url;
  }

  const active = toActive(body.active);
  if (active === null) return { ok: false, response: invalid("active", "active must be true/false") };

  return {
    ok: true,
    value: {
      name,
      description: description.value,
      keywords: keywords.value ?? "",
      platform,
      image_url: imageUrl,
      affiliate_url: url.url,
      active,
    },
  };
}

export function validateMappingInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: apiError(400, "INVALID_REQUEST", "Invalid request body") };
  }
  const postId = typeof body.facebook_post_id === "string" ? body.facebook_post_id.trim() : "";
  // Page post ids look like "<page_id>_<post_id>"; reels/videos are numeric.
  if (!/^[0-9]{5,}(_[0-9]{1,})?$/.test(postId)) {
    return { ok: false, response: invalid("facebook_post_id", "Facebook post/reel id must look like 123_456 or 123456") };
  }
  const type = String(body.facebook_content_type ?? "POST").toUpperCase();
  if (!CONTENT_TYPES.includes(type)) return { ok: false, response: invalid("facebook_content_type", "Type must be POST or REEL") };
  const productId = Number(body.product_id);
  if (!Number.isInteger(productId) || productId <= 0) return { ok: false, response: invalid("product_id", "product_id is required") };
  const note = optText(body.note, 500);
  if (!note.ok) return { ok: false, response: invalid("note", "Note too long") };
  const active = toActive(body.active);
  if (active === null) return { ok: false, response: invalid("active", "active must be true/false") };
  return { ok: true, value: { facebook_post_id: postId, facebook_content_type: type, product_id: productId, note: note.value, active } };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function parseId(segment) {
  if (!/^[0-9]{1,12}$/.test(segment || "")) return null;
  const n = Number(segment);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/* ------------------------------- router ------------------------------- */

/**
 * @param {Request} request
 * @param {URL} url
 * @param {any} env
 * @param {string} subpath path after "/admin/api", e.g. "/products/3"
 */
export async function handleAdminApi(request, url, env, subpath, ctx) {
  if (!env?.DB) {
    logError("admin_api_failed", "D1_BINDING_MISSING");
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
  const db = env.DB;
  const config = resolveConfig(env);
  const [, resource, idSegment, extra, tooDeep] = subpath.split("/");
  const method = request.method;

  // POST /admin/api/comments/:id/retry -- the only 3-segment route.
  if (resource === "comments" && extra === "retry" && tooDeep === undefined) {
    return handleRetry(request, db, env, config, idSegment, ctx);
  }
  // POST /admin/api/comments/:id/reconcile -- read-only Graph lookup + CAS.
  if (resource === "comments" && extra === "reconcile" && tooDeep === undefined) {
    return handleReconcile(request, db, env, config, idSegment);
  }
  // POST /admin/api/suggestions/:id/reject -- review state only (AM-2.3).
  if (resource === "suggestions" && extra === "reject" && tooDeep === undefined) {
    return handleSuggestionReject(request, db, config, idSegment);
  }
  // POST /admin/api/suggestions/:id/approve -- explicit human approval (AM-2.4).
  if (resource === "suggestions" && extra === "approve" && tooDeep === undefined) {
    return handleSuggestionApprove(request, db, config, idSegment);
  }
  if (extra !== undefined) return apiError(404, "NOT_FOUND", "Not found");

  try {
    if (resource === "health" && idSegment === undefined) {
      if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET" });
      return apiJson({ data: await healthStats(db, config.pageId), mode: config.mode });
    }

    if (resource === "discovery" && (idSegment === "run" || idSegment === "runs")) {
      if (idSegment === "runs") {
        if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET" });
        return apiJson({ data: await listRuns(db, config.pageId, 10) });
      }
      if (method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "POST" });
      return await handleDiscoveryRun(db, env, config);
    }

    if (resource === "suggestions") {
      if (idSegment === "generate") {
        if (method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "POST" });
        return await handleSuggestionGenerate(db, env, config);
      }
      if (idSegment === "runs") {
        if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET" });
        return apiJson({ data: await listSuggestionRuns(db, config.pageId, 10) });
      }
      if (idSegment !== undefined) return apiError(404, "NOT_FOUND", "Not found");
      if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET" });
      const status = url.searchParams.get("status");
      if (status !== null && !SUGGESTION_STATUSES.includes(status)) return invalid("status", "Unknown status");
      let limit = 25;
      const limitParam = url.searchParams.get("limit");
      if (limitParam !== null) {
        limit = /^\d{1,3}$/.test(limitParam) ? Number(limitParam) : 0;
        if (limit < 1 || limit > 100) return invalid("limit", "limit must be 1-100");
      }
      let beforeId = null;
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null) {
        beforeId = parseId(cursor);
        if (!beforeId) return invalid("cursor", "Invalid cursor");
      }
      const rows = await listSuggestions(db, config.pageId, { status, beforeId, limit: limit + 1 });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return apiJson({ data: page, has_more: hasMore, next_cursor: hasMore ? String(page[page.length - 1].id) : null });
    }

    if (resource === "post-candidates" && idSegment === undefined) {
      if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET" });
      const status = url.searchParams.get("status");
      if (status !== null && !CANDIDATE_STATUSES.includes(status)) return invalid("status", "Unknown status");
      const mapping = url.searchParams.get("mapping");
      if (mapping !== null && !MAPPING_FILTERS.includes(mapping)) return invalid("mapping", "Unknown mapping filter");
      let limit = 25;
      const limitParam = url.searchParams.get("limit");
      if (limitParam !== null) {
        limit = /^\d{1,3}$/.test(limitParam) ? Number(limitParam) : 0;
        if (limit < 1 || limit > 100) return invalid("limit", "limit must be 1-100");
      }
      let beforeId = null;
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null) {
        beforeId = parseId(cursor);
        if (!beforeId) return invalid("cursor", "Invalid cursor");
      }
      const rows = await listCandidates(db, config.pageId, { status, mapping, beforeId, limit: limit + 1 });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      // Logical (de-duplicated) items; the cursor is the group's newest source id.
      const nextCursor = hasMore ? String(page[page.length - 1].group_id) : null;
      return apiJson({ data: page.map(({ group_id, ...item }) => item), has_more: hasMore, next_cursor: nextCursor });
    }

    if (resource === "recovery" && idSegment === undefined) {
      if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET" });
      return apiJson({ data: await listRecoveryAttention(db, config.pageId) });
    }

    if (resource === "overview" && idSegment === undefined) {
      if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET" });
      return apiJson({ data: await overviewStats(db, config.pageId), mode: config.mode });
    }

    if (resource === "settings" && idSegment === undefined) {
      if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET" });
      let hermesHost = null;
      try {
        hermesHost = new URL(config.hermesUrl).host;
      } catch {
        hermesHost = null;
      }
      // Read-only and secret-free: names/presence only, never values.
      return apiJson({
        data: {
          reply_mode: config.mode,
          reply_mode_requested: env?.REPLY_MODE === "LIVE" ? "LIVE" : "DRY_RUN",
          page_id: config.pageId,
          hermes_host: hermesHost,
          hermes_timeout_ms: config.hermesTimeoutMs,
          graph_api_version: config.graphApiVersion,
          max_reply_length: config.maxReplyLength,
          affiliate_allowed_hosts: config.affiliateAllowedHosts,
          secrets_present: {
            META_APP_SECRET: Boolean(env?.META_APP_SECRET),
            META_VERIFY_TOKEN: Boolean(env?.META_VERIFY_TOKEN),
            HERMES_API_KEY: Boolean(env?.HERMES_API_KEY),
            PAGE_ACCESS_TOKEN: Boolean(env?.PAGE_ACCESS_TOKEN),
          },
        },
      });
    }

    if (resource === "products") {
      if (idSegment === undefined) {
        if (method === "GET") {
          const search = (url.searchParams.get("search") || "").trim().slice(0, 100) || null;
          const activeParam = url.searchParams.get("active");
          const active = activeParam === "1" ? 1 : activeParam === "0" ? 0 : null;
          return apiJson({ data: await listProducts(db, { search, active }) });
        }
        if (method === "POST") {
          const checked = validateProductInput(await readJson(request), config.affiliateAllowedHosts);
          if (!checked.ok) return checked.response;
          const id = await createProduct(db, checked.value);
          logEvent("admin_product_created", { product_id: id });
          return apiJson({ data: await getProduct(db, id) }, 201);
        }
        return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET, POST" });
      }

      const id = parseId(idSegment);
      if (!id) return apiError(404, "NOT_FOUND", "Not found");
      const existing = await getProduct(db, id);
      if (!existing || existing.deleted_at) return apiError(404, "NOT_FOUND", "Product not found");

      if (method === "GET") return apiJson({ data: existing });

      if (method === "PATCH") {
        const body = await readJson(request);
        if (body && typeof body === "object" && Object.keys(body).length === 1 && "active" in body) {
          const active = toActive(body.active, null);
          if (active === null) return invalid("active", "active must be true/false");
          await setProductActive(db, id, active);
          logEvent("admin_product_toggled", { product_id: id, active });
          return apiJson({ data: await getProduct(db, id) });
        }
        const checked = validateProductInput(body, config.affiliateAllowedHosts);
        if (!checked.ok) return checked.response;
        await updateProduct(db, id, checked.value);
        logEvent("admin_product_updated", { product_id: id });
        return apiJson({ data: await getProduct(db, id) });
      }

      if (method === "DELETE") {
        await softDeleteProduct(db, id);
        logEvent("admin_product_deleted", { product_id: id });
        return apiJson({ ok: true });
      }
      return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET, PATCH, DELETE" });
    }

    if (resource === "content") {
      if (idSegment === undefined) {
        if (method === "GET") {
          const [mappings, unmapped] = await Promise.all([
            listMappings(db, config.pageId),
            listUnmappedPosts(db, config.pageId),
          ]);
          return apiJson({ data: { mappings, unmapped } });
        }
        if (method === "POST") {
          const checked = validateMappingInput(await readJson(request));
          if (!checked.ok) return checked.response;
          const product = await getProduct(db, checked.value.product_id);
          if (!product || product.deleted_at) return invalid("product_id", "Product not found");
          const id = await upsertMapping(db, { ...checked.value, facebook_page_id: config.pageId });
          logEvent("admin_mapping_saved", { mapping_id: id, product_id: checked.value.product_id });
          return apiJson({ data: await getMapping(db, id) }, 201);
        }
        return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "GET, POST" });
      }

      const id = parseId(idSegment);
      if (!id) return apiError(404, "NOT_FOUND", "Not found");
      const existing = await getMapping(db, id);
      if (!existing || existing.facebook_page_id !== config.pageId) return apiError(404, "NOT_FOUND", "Mapping not found");

      if (method === "PATCH") {
        const body = await readJson(request);
        const merged = {
          facebook_post_id: existing.facebook_post_id,
          facebook_content_type: existing.facebook_content_type,
          product_id: existing.product_id,
          note: existing.note,
          active: existing.active,
          ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
        };
        merged.facebook_post_id = existing.facebook_post_id; // the key is immutable
        const checked = validateMappingInput(merged);
        if (!checked.ok) return checked.response;
        const product = await getProduct(db, checked.value.product_id);
        if (!product || product.deleted_at) return invalid("product_id", "Product not found");
        await updateMapping(db, id, config.pageId, checked.value);
        logEvent("admin_mapping_updated", { mapping_id: id });
        return apiJson({ data: await getMapping(db, id) });
      }

      if (method === "DELETE") {
        await deleteMapping(db, id, config.pageId);
        logEvent("admin_mapping_deleted", { mapping_id: id });
        return apiJson({ ok: true });
      }
      return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "PATCH, DELETE" });
    }

    return apiError(404, "NOT_FOUND", "Not found");
  } catch {
    logError("admin_api_failed", "UNHANDLED_EXCEPTION", { resource: resource ?? null });
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
}

/* ------------------------------ discovery ----------------------------- */

const DISCOVERY_FAILURE_HTTP = { ALREADY_RUNNING: 409, TOKEN_MISSING: 503 };

/**
 * POST /admin/api/discovery/run (AM-2). Operator-triggered, bounded,
 * READ-ONLY against Facebook (GET only). Writes post_candidates and
 * discovery_runs only; never touches mappings or the reply pipeline.
 * Session + same-origin/JSON CSRF checks already ran in admin.js. The body
 * is ignored. A failed read is reported as a failure -- never as an empty
 * success. Response: counts and error categories only, no tokens, no Graph
 * error text, no post text.
 */
async function handleDiscoveryRun(db, env, config) {
  let result;
  try {
    result = await runDiscovery({ db, env, config });
  } catch {
    logError("admin_discovery_failed", "UNHANDLED_EXCEPTION");
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
  if (!result.summary) {
    return apiError(DISCOVERY_FAILURE_HTTP[result.code] ?? 500, result.code, result.code === "TOKEN_MISSING" ? "Page access token is not configured" : "Discovery is already running");
  }
  // FAILED -> 502 (the read did not succeed); OK / PARTIAL -> 200 with status.
  return apiJson({ data: result.summary }, result.summary.status === "FAILED" ? 502 : 200);
}

/* ----------------------------- suggestions ----------------------------- */

const SUGGESTION_FAILURE_HTTP = { ALREADY_RUNNING: 409, HERMES_NOT_CONFIGURED: 503 };

/**
 * POST /admin/api/suggestions/generate (AM-2.3). Operator-triggered,
 * serial, bounded. Writes product_suggestions / suggestion_runs only --
 * never content_mappings, never Facebook. Session + same-origin/JSON CSRF
 * checks already ran in admin.js. Response: counters and a safe error
 * category only (no prompt, no AI text, no secrets).
 */
async function handleSuggestionGenerate(db, env, config) {
  let result;
  try {
    result = await generateSuggestions({ db, env, config });
  } catch {
    logError("admin_suggestions_failed", "UNHANDLED_EXCEPTION");
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
  if (!result.summary) {
    const message = result.code === "ALREADY_RUNNING" ? "A suggestion run is already in progress" : "AI suggestions are not configured";
    return apiError(SUGGESTION_FAILURE_HTTP[result.code] ?? 500, result.code, message);
  }
  return apiJson({ data: result.summary }, result.summary.status === "FAILED" ? 502 : 200);
}

/** POST /admin/api/suggestions/:id/reject -- PENDING -> REJECTED only. */
async function handleSuggestionReject(request, db, config, idSegment) {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "POST" });
  const id = parseId(idSegment);
  if (!id) return apiError(400, "INVALID_ID", "Invalid suggestion id");
  let outcome;
  try {
    outcome = await rejectSuggestion(db, config.pageId, id);
  } catch {
    logError("admin_suggestion_reject_failed", "UNHANDLED_EXCEPTION", { suggestion_id: id });
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
  if (outcome === "NOT_FOUND") return apiError(404, "NOT_FOUND", "Suggestion not found");
  if (outcome === "NOT_PENDING") return apiError(409, "NOT_PENDING", "Only a pending suggestion can be rejected");
  logEvent("admin_suggestion_rejected", { suggestion_id: id });
  return apiJson({ data: { id, status: "REJECTED" } });
}

const APPROVE_FAILURE = {
  NOT_FOUND: [404, "Suggestion not found"],
  NOT_PENDING: [409, "Only a pending suggestion can be approved"],
  NO_PRODUCT: [409, "This suggestion has no product to map"],
  PRODUCT_UNAVAILABLE: [409, "The suggested product is inactive or deleted"],
  SUBJECT_NOT_FOUND: [409, "The post for this suggestion is no longer in the discovered list"],
  MAPPING_EXISTS: [409, "This post/Reel already has a mapping"],
  NO_SAFE_REPRESENTATIVE: [409, "No Page post id is known for this Reel yet; run discovery first"],
  CONTENT_TYPE_UNKNOWN: [409, "The post type is unknown; map it manually"],
  SUGGESTION_STALE: [409, "The post text changed after this suggestion; generate a new suggestion"],
  CONFLICT: [409, "The state changed during approval; reload and try again"],
  MAPPING_WRITE_FAILED: [409, "The mapping could not be written; nothing was changed"],
};

/**
 * POST /admin/api/suggestions/:id/approve (AM-2.4). Explicit operator action
 * only. The request body is ignored: product, page and post come from the
 * stored suggestion and D1 (suggestions.js approveSuggestion). No Facebook,
 * no Hermes, no network. Session + same-origin/JSON CSRF already ran in
 * admin.js.
 */
async function handleSuggestionApprove(request, db, config, idSegment) {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "POST" });
  const id = parseId(idSegment);
  if (!id) return apiError(400, "INVALID_ID", "Invalid suggestion id");
  let result;
  try {
    result = await approveSuggestion(db, config.pageId, id);
  } catch {
    logError("admin_suggestion_approve_failed", "UNHANDLED_EXCEPTION", { suggestion_id: id });
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
  if (!result.ok) {
    const [status, message] = APPROVE_FAILURE[result.code] ?? [409, "Approval rejected"];
    logEvent("admin_suggestion_approve_rejected", { suggestion_id: id, reason: result.code });
    return apiError(status, result.code, message);
  }
  logEvent("admin_suggestion_approved", { suggestion_id: id, product_id: result.mapping.product_id, idempotent: Boolean(result.idempotent) });
  return apiJson({ ok: true, suggestion_id: id, idempotent: Boolean(result.idempotent), mapping: result.mapping });
}

/* ------------------------------ recovery ------------------------------ */

const RETRY_HTTP_STATUS = { RECOVERED: 200, NOT_FOUND: 404, NOT_ELIGIBLE: 409, ALREADY_CLAIMED: 409 };

/**
 * POST /admin/api/comments/:id/retry. Operator-triggered, one comment,
 * never automatic, never a Graph retry. Session + same-origin/JSON CSRF
 * checks already ran in admin.js. The body is ignored.
 */
async function handleRetry(request, db, env, config, idSegment, ctx) {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "POST" });
  const id = parseId(idSegment);
  if (!id) return apiError(400, "INVALID_ID", "Invalid comment id");

  let result;
  try {
    const work = recoverComment(id, { db, env, config });
    // Keep the run alive even if the operator closes the page.
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work.catch(() => {}));
    result = await work;
  } catch {
    logError("admin_retry_failed", "UNHANDLED_EXCEPTION", { comment_row_id: id });
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }

  logEvent("admin_retry", { comment_row_id: id, status: result.status, reason: result.reason ?? null, outcome: result.outcome ?? null });
  return apiJson(
    {
      data: {
        id,
        status: result.status,
        reason: result.reason ?? null,
        outcome: result.outcome ?? null,
        outcome_reason: result.outcomeReason ?? null,
        mode: config.mode,
      },
    },
    RETRY_HTTP_STATUS[result.status] ?? 409
  );
}

/**
 * POST /admin/api/comments/:id/reconcile (Phase 8.36). Operator-triggered,
 * one comment. Read-only Graph lookup + one compare-and-set; it never posts
 * to Facebook and never retries a send. Session + same-origin/JSON CSRF
 * checks already ran in admin.js. Safe to repeat: a reconciled row is SENT
 * and answers NOT_ELIGIBLE. Response: ids and reasons only -- no text,
 * no Graph body, no secrets.
 */
async function handleReconcile(request, db, env, config, idSegment) {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "POST" });
  const id = parseId(idSegment);
  if (!id) return apiError(400, "INVALID_ID", "Invalid comment id");

  let result;
  try {
    result = await reconcileComment(id, { db, env, config });
  } catch {
    logError("admin_reconcile_failed", "UNHANDLED_EXCEPTION", { comment_row_id: id });
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
  if (!result.commentFound) return apiError(404, "NOT_FOUND", "Comment not found");

  logEvent("admin_reconcile", { comment_row_id: id, reason: result.reason, detail: result.detail ?? null });
  const status =
    result.reason === RECONCILE_REASONS.RECONCILED ? 200 : String(result.reason).startsWith("GRAPH_READ_") ? 502 : 409;
  return apiJson(
    {
      data: {
        id,
        reason: result.reason,
        detail: result.detail ?? null,
        reply_row_id: result.replyRowId ?? null,
        facebook_reply_id: result.reason === RECONCILE_REASONS.RECONCILED ? result.facebookReplyId : null,
        comment_status_updated: result.commentStatusUpdated ?? null,
        candidates: result.candidates ?? null,
        mode: config.mode,
      },
    },
    status
  );
}
