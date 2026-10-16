/**
 * Upgrade U13: automatic mapping of HIGH-confidence suggestions.
 *
 * Owner decision (2026-10-16): a PENDING suggestion is mapped without a tap
 * when ALL hold:
 *   - AI confidence is HIGH (the closed-candidate AM-2.3 validator already
 *     guarantees the product was one of the prefiltered candidates);
 *   - the deterministic prefilter score is >= AUTO_MAP_MIN_PREFILTER (5 =
 *     at least a brand-word or full-name match in the post text);
 *   - the product is active and not deleted, and the representative is a
 *     posts-edge `<page>_<n>` id (`mappable`).
 * The write itself is the unchanged AM-2.4 `approveSuggestion` (subject still
 * exists, text hash unchanged, no mapping of any state on any source id of
 * the Reel, one D1 batch), so no AM-2.4 / AM-2.5 guard is bypassed.
 *
 * Every auto-mapping is audited (via: auto) and announced in Telegram with an
 * "ยกเลิกการผูก" button (two taps; it deactivates the mapping). At most
 * AUTO_MAP_MAX_PER_RUN per run. Switch: var AUTO_MAP_HIGH ("0" = off).
 */

import { resolveConfig } from "./config.js";
import { listSuggestions, approveSuggestion } from "./suggestions.js";
import { recordAudit } from "./admin-db.js";
import { tgCall } from "./telegram-bot.js";
import { telegramConfigured } from "./alerts.js";
import { logEvent, logError } from "./log.js";

export const AUTO_MAP_MIN_PREFILTER = 5;
export const AUTO_MAP_MAX_PER_RUN = 5;

export function isAutoMappable(s) {
  return s && s.status === "PENDING" && s.confidence === "HIGH" && s.product_id !== null && s.product_id !== undefined
    && Boolean(s.mappable) && Number(s.prefilter_score) >= AUTO_MAP_MIN_PREFILTER;
}

const clip = (t, n) => { const v = String(t || "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n) + "…" : v; };

export async function autoMapHighConfidence(env, { fetchImpl = fetch, max = AUTO_MAP_MAX_PER_RUN } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, mapped: 0, error: "D1_BINDING_MISSING" };
  if (String(env?.AUTO_MAP_HIGH ?? "1") === "0") return { ok: true, mapped: 0, skipped: "OFF" };
  const pageId = resolveConfig(env).pageId;
  const pending = (await listSuggestions(db, pageId, { status: "PENDING", limit: 100 })).reverse().filter(isAutoMappable);
  const mapped = [];
  const failed = [];
  for (const s of pending.slice(0, max)) {
    let r;
    try { r = await approveSuggestion(db, pageId, Number(s.id)); } catch { r = { ok: false, code: "UNHANDLED_EXCEPTION" }; }
    if (!r.ok) { failed.push({ id: Number(s.id), code: r.code }); continue; }
    if (r.idempotent) continue;
    mapped.push({ id: Number(s.id), product_id: r.mapping.product_id, post_id: r.mapping.post_id, product_name: s.product_name, message: s.message });
    const ok = await recordAudit(db, { pageId, action: "SUGGESTION_APPROVE", targetType: "SUGGESTION", targetId: Number(s.id), before: { status: "PENDING" }, after: { status: "APPROVED", product_id: r.mapping.product_id, mapping_post_id: r.mapping.post_id, via: "auto" } });
    if (!ok) logError("admin_audit_write_failed", "D1_WRITE_FAILED", { action: "SUGGESTION_APPROVE" });
  }
  let notified = 0;
  if (mapped.length && telegramConfigured(env)) {
    for (const m of mapped) {
      const text = [`🤖 ผูกสินค้าอัตโนมัติแล้ว (AI มั่นใจสูง) — คำแนะนำ #${m.id}`, "", "โพสต์: " + (clip(m.message, 200) || "(ไม่มีข้อความ)"), "สินค้า: " + (m.product_name || "#" + m.product_id), "", "คำตอบคอมเมนต์ถัดไปของโพสต์นี้จะแนบลิงก์สินค้านี้ ถ้าไม่ถูกต้องกดยกเลิกได้"].join("\n");
      const r = await tgCall(env, "sendMessage", { chat_id: String(env.TELEGRAM_CHAT_ID), text, reply_markup: { inline_keyboard: [[{ text: "↩️ ยกเลิกการผูก", callback_data: `u:${m.id}` }]] }, disable_web_page_preview: true }, fetchImpl);
      if (r.ok) notified += 1;
    }
  }
  logEvent("auto_map_run", { candidates: pending.length, mapped: mapped.length, failed: failed.length, notified });
  return { ok: true, mapped: mapped.length, failed, notified };
}
