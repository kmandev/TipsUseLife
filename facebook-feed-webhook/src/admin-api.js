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
import { logEvent, logError } from "./log.js";

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
export async function handleAdminApi(request, url, env, subpath) {
  if (!env?.DB) {
    logError("admin_api_failed", "D1_BINDING_MISSING");
    return apiError(500, "INTERNAL_ERROR", "Internal error");
  }
  const db = env.DB;
  const config = resolveConfig(env);
  const [, resource, idSegment, extra] = subpath.split("/");
  if (extra !== undefined) return apiError(404, "NOT_FOUND", "Not found");
  const method = request.method;

  try {
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
