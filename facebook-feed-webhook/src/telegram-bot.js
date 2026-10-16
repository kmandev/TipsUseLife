/**
 * Upgrade U12: map products from Telegram.
 *
 * The bot sends each PENDING product suggestion (AM-2.3) to the owner's chat
 * with buttons. Every state change needs TWO taps (choose -> confirm), the
 * same explicit human decision as the Dashboard (AM-2.4):
 *   ✅ ผูกสินค้านี้      -> confirm -> approveSuggestion (all AM-2.4 guards)
 *   🔁 เลือกสินค้าอื่น   -> product list -> confirm -> create-only mapping
 *                          (AM-2.5 guards) + the AI suggestion is REJECTED
 *   ❌ ปฏิเสธ           -> confirm -> rejectSuggestion
 *
 * Security: Telegram calls POST /admin/telegram/webhook with the header
 * X-Telegram-Bot-Api-Secret-Token, which must equal a value derived from
 * ADMIN_SESSION_SECRET (set by the Dashboard "เชื่อมต่อ Telegram" button; no
 * new secret). Only updates whose sender id equals TELEGRAM_CHAT_ID (the
 * owner's private chat) are acted on. No reply to a Facebook comment, no
 * Facebook call, no Hermes call. Message text is plain text (no parse mode).
 */

import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";
import { resolveConfig } from "./config.js";
import { listSuggestions, approveSuggestion, rejectSuggestion, subjectKeyOf, isMappableRepresentative, approvalNote } from "./suggestions.js";
import { listCandidates } from "./discovery.js";
import { prefilterProducts } from "./suggestion-prefilter.js";
import { getProduct, subjectSourcePostIds, insertMappingIfAbsent, recordAudit, deactivateMapping } from "./admin-db.js";
import { telegramConfigured } from "./alerts.js";
import { logEvent, logError } from "./log.js";

export const TELEGRAM_WEBHOOK_PATH = "/admin/telegram/webhook";
export const NOTIFIED_KEY = "telegram_notified_v1";
const TG_TIMEOUT_MS = 8000;
const MAX_UPDATE_BYTES = 64 * 1024;
const MAX_PRODUCT_CHOICES = 8;
const CALLBACK_RE = /^([vaArRopPuU]):([0-9]{1,9})(?::([0-9]{1,9}))?$/;

/** Derived webhook secret (Telegram allows A-Z a-z 0-9 _ -, 1-256 chars). */
export async function webhookSecret(env) {
  if (!env?.ADMIN_SESSION_SECRET) return null;
  return (await hmacSha256Hex(env.ADMIN_SESSION_SECRET, "telegram-webhook-v1")).slice(0, 48);
}

export async function tgCall(env, method, payload, fetchImpl = fetch) {
  if (!env?.TELEGRAM_BOT_TOKEN) return { ok: false, error: "NOT_CONFIGURED" };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return res.ok && body?.ok !== false ? { ok: true, result: body?.result ?? null } : { ok: false, error: "TELEGRAM_HTTP_" + res.status };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "TELEGRAM_TIMEOUT" : "TELEGRAM_NETWORK" };
  }
}

/* ----------------------------- rendering ----------------------------- */

const clip = (t, n) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const isFb = (u) => /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(String(u || ""));
function postUrl(postId, permalink) {
  if (isFb(permalink)) return String(permalink);
  const m = /^([0-9]+)_([0-9]+)$/.exec(String(postId || ""));
  return m ? `https://www.facebook.com/${m[1]}/posts/${m[2]}` : null;
}
const btn = (text, data) => ({ text, callback_data: data });

export function suggestionText(s) {
  const lines = [`🛍️ คำแนะนำสินค้า #${s.id}`, "", "โพสต์: " + (clip(s.message, 220) || "(ไม่มีข้อความ)")];
  const url = postUrl(s.representative_post_id, s.permalink);
  if (url) lines.push(url);
  lines.push("");
  if (s.product_id) {
    lines.push(`AI แนะนำ: ${s.product_name || "#" + s.product_id} (${s.confidence})`);
    if (s.reason) lines.push("เหตุผล: " + clip(s.reason, 200));
    if (!s.product_usable) lines.push("⚠️ สินค้านี้ถูกปิด/ลบแล้ว — เลือกสินค้าอื่นได้");
  } else {
    lines.push("AI ไม่พบสินค้าที่ตรงกับโพสต์นี้ — เลือกสินค้าเองได้");
  }
  return lines.join("\n");
}

export function suggestionKeyboard(s) {
  const rows = [];
  if (s.product_id && s.mappable) rows.push([btn("✅ ผูกสินค้านี้", `a:${s.id}`)]);
  if (isMappableRepresentative(s.representative_post_id)) rows.push([btn(s.product_id ? "🔁 เลือกสินค้าอื่น" : "🔎 เลือกสินค้า", `o:${s.id}`)]);
  rows.push([btn(s.product_id ? "❌ ปฏิเสธ" : "❌ ข้ามโพสต์นี้", `r:${s.id}`)]);
  return { inline_keyboard: rows };
}

async function getSuggestion(db, pageId, id) {
  const rows = await listSuggestions(db, pageId, { beforeId: id + 1, limit: 1 });
  return rows[0] && Number(rows[0].id) === id ? rows[0] : null;
}

/* ---------------------------- notifications ---------------------------- */

async function readNotified(db) {
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(NOTIFIED_KEY).first();
    const v = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(v) ? v.map(Number) : [];
  } catch { return []; }
}
async function writeNotified(db, ids) {
  await db
    .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(NOTIFIED_KEY, JSON.stringify(ids.slice(-300)))
    .run();
}

/**
 * Send PENDING suggestions as button messages (oldest first). `onlyNew`
 * skips ones already sent. Never changes a suggestion or a mapping.
 */
export async function notifyPendingSuggestions(env, { max = 5, onlyNew = true, fetchImpl = fetch } = {}) {
  const db = env?.DB;
  if (!db || !telegramConfigured(env)) return { ok: false, sent: 0, error: "NOT_CONFIGURED" };
  const config = resolveConfig(env);
  const pending = (await listSuggestions(db, config.pageId, { status: "PENDING", limit: 100 })).reverse();
  const done = await readNotified(db);
  const queue = pending.filter((s) => isMappableRepresentative(s.representative_post_id) && (!onlyNew || !done.includes(Number(s.id)))).slice(0, max);
  let sent = 0;
  for (const s of queue) {
    const r = await tgCall(env, "sendMessage", { chat_id: String(env.TELEGRAM_CHAT_ID), text: suggestionText(s), reply_markup: suggestionKeyboard(s), disable_web_page_preview: true }, fetchImpl);
    if (!r.ok) break;
    sent += 1;
    done.push(Number(s.id));
  }
  if (sent) { try { await writeNotified(db, done); } catch { logError("telegram_notified_write_failed", "D1_WRITE_FAILED"); } }
  logEvent("telegram_suggestions_sent", { sent, queued: queue.length, pending: pending.length });
  const remaining = pending.filter((s) => isMappableRepresentative(s.representative_post_id) && !done.includes(Number(s.id))).length;
  return { ok: true, sent, remaining };
}

/* ------------------------------- actions ------------------------------- */

/** Products offered for "เลือกสินค้าอื่น": prefilter matches first, then other active products. */
export async function productChoices(db, message) {
  const res = await db.prepare(`SELECT id, name, keywords, active, deleted_at FROM products WHERE active = 1 AND deleted_at IS NULL ORDER BY name`).all();
  const products = res?.results ?? [];
  const ranked = prefilterProducts(message || "", products, { maxCandidates: MAX_PRODUCT_CHOICES }).map((r) => r.product_id);
  const rest = products.map((p) => Number(p.id)).filter((id) => !ranked.includes(id));
  const byId = new Map(products.map((p) => [Number(p.id), p]));
  return [...ranked, ...rest].slice(0, MAX_PRODUCT_CHOICES).map((id) => byId.get(id));
}

/**
 * Map the suggestion's post to a product the owner chose (AM-2.5 create-only
 * rules) and REJECT the AI suggestion. If the owner chose the suggested
 * product itself, this is a normal AM-2.4 approval.
 */
export async function mapChosenProduct(db, pageId, sid, pid) {
  const s = await getSuggestion(db, pageId, sid);
  if (!s) return { ok: false, code: "NOT_FOUND" };
  if (s.status !== "PENDING") return { ok: false, code: "NOT_PENDING" };
  if (s.product_id && Number(s.product_id) === pid) {
    const r = await approveSuggestion(db, pageId, sid);
    return r.ok ? { ok: true, via: "APPROVE", mapping: r.mapping, idempotent: Boolean(r.idempotent) } : r;
  }
  const product = await getProduct(db, pid);
  if (!product || Number(product.active) !== 1 || product.deleted_at) return { ok: false, code: "PRODUCT_UNAVAILABLE" };
  const items = await listCandidates(db, pageId, { limit: 500 });
  const item = items.find((i) => subjectKeyOf(i) === s.subject_key);
  if (!item) return { ok: false, code: "SUBJECT_NOT_FOUND" };
  if (item.mapping_state !== "NONE") return { ok: false, code: "MAPPING_EXISTS" };
  const rep = item.representative_post_id;
  if (item.discovery_source !== "posts" || !isMappableRepresentative(rep) || !String(rep).startsWith(`${pageId}_`)) return { ok: false, code: "NO_SAFE_REPRESENTATIVE" };
  if (item.content_type !== "POST" && item.content_type !== "REEL") return { ok: false, code: "CONTENT_TYPE_UNKNOWN" };
  const sourceIds = await subjectSourcePostIds(db, pageId, rep);
  const note = `จาก Telegram (คำแนะนำ #${sid})`;
  const id = await insertMappingIfAbsent(db, { facebook_page_id: pageId, facebook_post_id: rep, facebook_content_type: item.content_type, product_id: pid, active: 1, note }, sourceIds);
  if (!id) return { ok: false, code: "MAPPING_EXISTS" };
  await rejectSuggestion(db, pageId, sid);
  return { ok: true, via: "MANUAL", mapping_id: id, mapping: { post_id: rep, product_id: pid, content_type: item.content_type }, product_name: product.name };
}

const FAIL_TEXT = {
  NOT_FOUND: "ไม่พบคำแนะนำนี้", NOT_PENDING: "คำแนะนำนี้ถูกตัดสินไปแล้ว", NO_PRODUCT: "คำแนะนำนี้ไม่มีสินค้า",
  PRODUCT_UNAVAILABLE: "สินค้าถูกปิดหรือลบแล้ว", SUBJECT_NOT_FOUND: "ไม่พบโพสต์นี้ในรายการที่ค้นพบแล้ว",
  MAPPING_EXISTS: "โพสต์/Reel นี้ผูกสินค้าไว้แล้ว", NO_SAFE_REPRESENTATIVE: "ยังไม่มีรหัสโพสต์ของเพจสำหรับ Reel นี้ — รันค้นหาโพสต์ก่อน",
  CONTENT_TYPE_UNKNOWN: "ไม่ทราบประเภทโพสต์ — ผูกในแดชบอร์ดแทน", SUGGESTION_STALE: "ข้อความโพสต์เปลี่ยนไปแล้ว — สร้างคำแนะนำใหม่",
  CONFLICT: "สถานะเปลี่ยนระหว่างทำรายการ — ลองใหม่", MAPPING_WRITE_FAILED: "บันทึกไม่สำเร็จ ไม่มีอะไรถูกเปลี่ยน",
};

async function audit(db, pageId, action, targetType, targetId, before, after) {
  const ok = await recordAudit(db, { pageId, action, targetType, targetId, before, after });
  if (!ok) logError("admin_audit_write_failed", "D1_WRITE_FAILED", { action });
}

/**
 * Handle one callback (button tap). Returns {text, keyboard|null, toast}.
 * Exported for tests; the webhook only adds transport.
 */
export async function handleCallback(db, pageId, data) {
  const m = CALLBACK_RE.exec(String(data || ""));
  if (!m) return { toast: "คำสั่งไม่ถูกต้อง" };
  const [, op, a, b] = m;
  const sid = Number(a);
  const s = await getSuggestion(db, pageId, sid);
  if (!s) return { toast: FAIL_TEXT.NOT_FOUND, text: `คำแนะนำ #${sid} — ไม่พบแล้ว`, keyboard: null };
  const decided = (extra) => ({ text: suggestionText(s) + "\n\n" + extra, keyboard: null });

  // U13: undo an automatic (or any approved) mapping -- two taps, deactivates it.
  if (op === "u" || op === "U") {
    const row = await db
      .prepare(`SELECT id, facebook_post_id, facebook_content_type, product_id, active, note FROM content_mappings WHERE facebook_page_id = ? AND note = ? LIMIT 1`)
      .bind(pageId, approvalNote(sid))
      .first();
    if (!row) return { toast: "ไม่พบการผูกของคำแนะนำนี้", text: `คำแนะนำ #${sid} — ไม่พบการผูก`, keyboard: null };
    if (Number(row.active) !== 1) return { toast: "ปิดการผูกไปแล้ว", text: `↩️ คำแนะนำ #${sid}: การผูกถูกปิดแล้ว`, keyboard: null };
    if (op === "u") {
      return { text: `ยกเลิกการผูก “${s.product_name || "#" + row.product_id}” กับโพสต์ ${row.facebook_post_id}?\nโพสต์นี้จะไม่ได้รับลิงก์สินค้าอีก จนกว่าจะผูกใหม่ในแดชบอร์ด`, keyboard: { inline_keyboard: [[btn("↩️ ยืนยันยกเลิก", `U:${sid}`)]] }, toast: "" };
    }
    const changed = await deactivateMapping(db, Number(row.id), pageId);
    if (changed) {
      const ok = await recordAudit(db, { pageId, action: "MAPPING_UPDATE", targetType: "MAPPING", targetId: Number(row.id), before: row, after: { ...row, active: 0 } });
      if (!ok) logError("admin_audit_write_failed", "D1_WRITE_FAILED", { action: "MAPPING_UPDATE" });
      await recordAudit(db, { pageId, action: "SUGGESTION_UNDO", targetType: "SUGGESTION", targetId: sid, after: { status: "APPROVED", product_id: row.product_id, via: "telegram" } });
      logEvent("telegram_mapping_undone", { suggestion_id: sid, mapping_id: Number(row.id) });
    }
    return { toast: "ยกเลิกการผูกแล้ว", text: `↩️ ยกเลิกการผูก “${s.product_name || "#" + row.product_id}” กับโพสต์ ${row.facebook_post_id} แล้ว — แก้ไขหรือผูกใหม่ได้ที่แดชบอร์ด (โพสต์ / Reel)`, keyboard: null };
  }

  if (s.status !== "PENDING" && op !== "v") return { toast: FAIL_TEXT.NOT_PENDING, ...decided(`สถานะ: ${s.status}`) };

  if (op === "v") return { text: suggestionText(s), keyboard: s.status === "PENDING" ? suggestionKeyboard(s) : null, toast: "" };
  if (op === "a") {
    return { text: suggestionText(s) + `\n\nยืนยันผูก “${s.product_name}” กับโพสต์นี้? คำตอบคอมเมนต์ถัดไปของโพสต์นี้จะแนบลิงก์สินค้านี้`, keyboard: { inline_keyboard: [[btn("✅ ยืนยันผูก", `A:${sid}`), btn("↩️ กลับ", `v:${sid}`)]] }, toast: "" };
  }
  if (op === "A") {
    const r = await approveSuggestion(db, pageId, sid);
    if (!r.ok) return { toast: FAIL_TEXT[r.code] || r.code, ...decided("❗ " + (FAIL_TEXT[r.code] || r.code)) };
    if (!r.idempotent) await audit(db, pageId, "SUGGESTION_APPROVE", "SUGGESTION", sid, { status: "PENDING" }, { status: "APPROVED", product_id: r.mapping.product_id, mapping_post_id: r.mapping.post_id, via: "telegram" });
    logEvent("telegram_suggestion_approved", { suggestion_id: sid, idempotent: Boolean(r.idempotent) });
    return { toast: "ผูกสินค้าแล้ว", ...decided(`✅ ผูก “${s.product_name}” แล้ว`) };
  }
  if (op === "r") {
    return { text: suggestionText(s) + "\n\nยืนยัน" + (s.product_id ? "ปฏิเสธคำแนะนำนี้?" : "ข้ามโพสต์นี้?"), keyboard: { inline_keyboard: [[btn("❌ ยืนยัน", `R:${sid}`), btn("↩️ กลับ", `v:${sid}`)]] }, toast: "" };
  }
  if (op === "R") {
    const r = await rejectSuggestion(db, pageId, sid);
    if (r !== "REJECTED") return { toast: FAIL_TEXT[r] || r, ...decided("❗ " + (FAIL_TEXT[r] || r)) };
    await audit(db, pageId, "SUGGESTION_REJECT", "SUGGESTION", sid, { status: "PENDING" }, { status: "REJECTED", via: "telegram" });
    return { toast: "ปฏิเสธแล้ว", ...decided("❌ ปฏิเสธแล้ว") };
  }
  if (op === "o") {
    const choices = await productChoices(db, s.message);
    if (!choices.length) return { toast: "ยังไม่มีสินค้าที่เปิดใช้", text: suggestionText(s), keyboard: suggestionKeyboard(s) };
    const rows = choices.map((p) => [btn((Number(p.id) === Number(s.product_id) ? "⭐ " : "") + clip(p.name, 40), `p:${sid}:${p.id}`)]);
    rows.push([btn("↩️ กลับ", `v:${sid}`)]);
    return { text: suggestionText(s) + "\n\nเลือกสินค้าที่จะผูกกับโพสต์นี้:", keyboard: { inline_keyboard: rows }, toast: "" };
  }
  if (op === "p" || op === "P") {
    const pid = Number(b);
    if (!pid) return { toast: "คำสั่งไม่ถูกต้อง" };
    const product = await getProduct(db, pid);
    if (!product || Number(product.active) !== 1 || product.deleted_at) return { toast: FAIL_TEXT.PRODUCT_UNAVAILABLE, text: suggestionText(s), keyboard: suggestionKeyboard(s) };
    if (op === "p") {
      return { text: suggestionText(s) + `\n\nยืนยันผูก “${product.name}” กับโพสต์นี้?`, keyboard: { inline_keyboard: [[btn("✅ ยืนยันผูก", `P:${sid}:${pid}`), btn("↩️ กลับ", `o:${sid}`)]] }, toast: "" };
    }
    const r = await mapChosenProduct(db, pageId, sid, pid);
    if (!r.ok) return { toast: FAIL_TEXT[r.code] || r.code, ...decided("❗ " + (FAIL_TEXT[r.code] || r.code)) };
    if (r.via === "MANUAL") {
      await audit(db, pageId, "MAPPING_CREATE", "MAPPING", r.mapping_id, null, { facebook_post_id: r.mapping.post_id, facebook_content_type: r.mapping.content_type, product_id: pid, active: 1, note: `จาก Telegram (คำแนะนำ #${sid})` });
      await audit(db, pageId, "SUGGESTION_REJECT", "SUGGESTION", sid, { status: "PENDING" }, { status: "REJECTED", via: "telegram" });
    } else if (!r.idempotent) {
      await audit(db, pageId, "SUGGESTION_APPROVE", "SUGGESTION", sid, { status: "PENDING" }, { status: "APPROVED", product_id: pid, mapping_post_id: r.mapping.post_id, via: "telegram" });
    }
    logEvent("telegram_product_mapped", { suggestion_id: sid, product_id: pid, via: r.via });
    return { toast: "ผูกสินค้าแล้ว", ...decided(`✅ ผูก “${product.name}” แล้ว`) };
  }
  return { toast: "คำสั่งไม่ถูกต้อง" };
}

/* ------------------------------- webhook ------------------------------- */

const HELP = "บอท TipsUseLife AI\n/pending — ส่งคำแนะนำสินค้าที่รออนุมัติ (สูงสุด 5 รายการ)\nทุกการผูกสินค้าต้องกดยืนยันอีกครั้งเสมอ";

/** POST /admin/telegram/webhook (no admin session; Telegram secret header + owner check). */
export async function handleTelegramWebhook(request, env, fetchImpl = fetch) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const expected = await webhookSecret(env);
  const got = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!expected || !telegramConfigured(env) || !env?.DB || !timingSafeEqual(got, expected)) {
    logError("telegram_webhook_rejected", "BAD_SECRET");
    return new Response("Unauthorized", { status: 401 });
  }
  const raw = await request.text();
  if (raw.length > MAX_UPDATE_BYTES) return new Response("Payload Too Large", { status: 413 });
  let update;
  try { update = JSON.parse(raw); } catch { return new Response("ok"); }
  const db = env.DB;
  const pageId = resolveConfig(env).pageId;
  const owner = String(env.TELEGRAM_CHAT_ID);
  try {
    const cq = update?.callback_query;
    if (cq) {
      if (String(cq.from?.id) !== owner) {
        await tgCall(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "ไม่มีสิทธิ์" }, fetchImpl);
        logError("telegram_webhook_rejected", "NOT_OWNER");
        return new Response("ok");
      }
      const out = await handleCallback(db, pageId, cq.data);
      await tgCall(env, "answerCallbackQuery", { callback_query_id: cq.id, text: out.toast || "" }, fetchImpl);
      if (out.text && cq.message?.message_id) {
        await tgCall(env, "editMessageText", { chat_id: cq.message.chat?.id, message_id: cq.message.message_id, text: out.text, reply_markup: out.keyboard || { inline_keyboard: [] }, disable_web_page_preview: true }, fetchImpl);
      }
      return new Response("ok");
    }
    const msg = update?.message;
    if (msg && String(msg.from?.id) === owner && String(msg.chat?.id) === owner) {
      const text = String(msg.text || "").trim();
      if (/^\/pending\b/.test(text)) {
        const r = await notifyPendingSuggestions(env, { max: 5, onlyNew: false, fetchImpl });
        if (!r.sent) await tgCall(env, "sendMessage", { chat_id: owner, text: "ไม่มีคำแนะนำที่รออนุมัติ" }, fetchImpl);
      } else {
        await tgCall(env, "sendMessage", { chat_id: owner, text: HELP }, fetchImpl);
      }
    }
  } catch {
    logError("telegram_webhook_failed", "UNHANDLED_EXCEPTION");
  }
  return new Response("ok"); // always 200 so Telegram does not redeliver
}

/** Dashboard "เชื่อมต่อ Telegram": register the webhook + commands. */
export async function setupTelegramWebhook(env, origin, fetchImpl = fetch) {
  const secret = await webhookSecret(env);
  if (!secret || !telegramConfigured(env)) return { ok: false, error: "NOT_CONFIGURED" };
  const url = String(origin).replace(/\/$/, "") + TELEGRAM_WEBHOOK_PATH;
  const r = await tgCall(env, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }, fetchImpl);
  if (!r.ok) return { ok: false, error: r.error };
  await tgCall(env, "setMyCommands", { commands: [{ command: "pending", description: "คำแนะนำสินค้าที่รออนุมัติ" }] }, fetchImpl);
  return { ok: true, url };
}

export async function telegramWebhookInfo(env, fetchImpl = fetch) {
  const r = await tgCall(env, "getWebhookInfo", {}, fetchImpl);
  if (!r.ok) return { ok: false, error: r.error };
  const i = r.result || {};
  return { ok: true, url: i.url || null, pending_update_count: Number(i.pending_update_count || 0), last_error_date: i.last_error_date || null, has_error: Boolean(i.last_error_message) };
}
