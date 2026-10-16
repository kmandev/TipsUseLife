/**
 * Upgrade U7: the daily housekeeping run (Cron Trigger DAILY_CRON, 06:17
 * Bangkok). It runs the two EXISTING operator actions, unchanged:
 *   1. post discovery  (read-only Graph GETs, AM-2 / AM-2.2)
 *   2. product suggestions (review-only, AM-2.3: <= 5 Hermes calls, serial)
 * and sends one Telegram summary when there is something new to review.
 *
 * It NEVER creates, changes or approves a mapping (approval stays the
 * explicit human action of AM-2.4), never replies to a comment and never
 * POSTs to Facebook. Each step keeps its own lock (a run already in progress
 * is skipped, not waited for) and its own time budget. Switches (vars):
 * AUTO_DISCOVERY / AUTO_SUGGESTIONS, "0" = off. State: settings key
 * `daily_jobs_v1` (no migration).
 */

import { resolveConfig } from "./config.js";
import { runDiscovery } from "./discovery.js";
import { generateSuggestions } from "./suggestions.js";
import { sendTelegram, telegramConfigured } from "./alerts.js";
import { notifyPendingSuggestions } from "./telegram-bot.js";
import { autoMapHighConfidence } from "./auto-map.js";
import { logEvent, logError } from "./log.js";

export const DAILY_STATE_KEY = "daily_jobs_v1";
export const DAILY_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // a duplicate cron fire is a no-op

export async function readDailyState(db) {
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(DAILY_STATE_KEY).first();
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

async function writeDailyState(db, state) {
  try {
    await db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(DAILY_STATE_KEY, JSON.stringify(state))
      .run();
  } catch {
    logError("daily_state_write_failed", "D1_WRITE_FAILED");
  }
}

const on = (v) => String(v ?? "1") !== "0";

/**
 * @param {any} env
 * @param {{now?: Date, force?: boolean, fetchImpl?: typeof fetch, discover?: Function, suggest?: Function}} [opts]
 */
export async function runDailyJobs(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "D1_BINDING_MISSING" };
  const now = opts.now instanceof Date ? opts.now : new Date();
  const config = resolveConfig(env);
  const prev = await readDailyState(db);
  const last = Date.parse(prev?.ran_at ?? "");
  if (!opts.force && Number.isFinite(last) && now.getTime() - last < DAILY_MIN_INTERVAL_MS) {
    return { ok: true, skipped: "RECENT_RUN" };
  }
  const discover = opts.discover || ((a) => runDiscovery(a));
  const suggest = opts.suggest || ((a) => generateSuggestions(a));

  const state = { ran_at: now.toISOString(), discovery: null, suggestions: null, pending: null };
  if (on(env?.AUTO_DISCOVERY)) {
    try {
      const r = await discover({ db, env, config, fetchImpl: opts.fetchImpl });
      state.discovery = r.summary
        ? { status: r.summary.status, inserted: Number(r.summary.inserted || 0), updated: Number(r.summary.updated || 0), error: r.summary.error_code || null }
        : { status: "NOT_RUN", inserted: 0, updated: 0, error: r.code || "UNKNOWN" };
    } catch {
      state.discovery = { status: "FAILED", inserted: 0, updated: 0, error: "UNHANDLED_EXCEPTION" };
    }
  }
  if (on(env?.AUTO_SUGGESTIONS)) {
    try {
      const r = await suggest({ db, env, config });
      state.suggestions = r.summary
        ? { status: r.summary.status, suggested: Number(r.summary.suggested || 0), no_match: Number(r.summary.no_match || 0), error: r.summary.error_code || null }
        : { status: "NOT_RUN", suggested: 0, no_match: 0, error: r.code || "UNKNOWN" };
    } catch {
      state.suggestions = { status: "FAILED", suggested: 0, no_match: 0, error: "UNHANDLED_EXCEPTION" };
    }
  }
  // U13: map HIGH-confidence suggestions automatically (AM-2.4 approval path, audited, undo in Telegram).
  try {
    const a = await autoMapHighConfidence(env, { fetchImpl: opts.fetchImpl });
    state.auto_mapped = a.mapped || 0;
  } catch {
    state.auto_mapped = 0;
    logError("auto_map_failed", "UNHANDLED_EXCEPTION");
  }
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM product_suggestions WHERE page_id = ? AND status = 'PENDING' AND product_id IS NOT NULL`)
      .bind(config.pageId)
      .first();
    state.pending = Number(row?.n ?? 0);
  } catch {
    state.pending = null;
  }

  const lines = [];
  const d = state.discovery;
  const s = state.suggestions;
  if (d && (d.inserted || d.updated)) lines.push(`• ค้นพบโพสต์/Reel ใหม่ ${d.inserted} รายการ${d.updated ? ` · ข้อความถูกแก้ไข ${d.updated}` : ""}`);
  if (d && d.status !== "OK" && d.status !== "NOT_RUN") lines.push(`• การค้นหาโพสต์: ${d.status}${d.error ? " (" + d.error + ")" : ""}`);
  if (d && d.status === "NOT_RUN" && d.error !== "ALREADY_RUNNING") lines.push(`• การค้นหาโพสต์ไม่ได้ทำงาน (${d.error})`);
  if (s && s.suggested) lines.push(`• AI แนะนำสินค้าใหม่ ${s.suggested} รายการ`);
  if (state.auto_mapped) lines.push(`• ผูกสินค้าอัตโนมัติ (AI มั่นใจสูง) ${state.auto_mapped} รายการ — ยกเลิกได้จากข้อความแจ้งแต่ละรายการ`);
  if (s && s.status === "FAILED") lines.push(`• การสร้างคำแนะนำล้มเหลว${s.error ? " (" + s.error + ")" : ""}`);
  if ((s && s.suggested) || (d && d.inserted)) {
    if (state.pending) lines.push(`• รอคุณตรวจและอนุมัติ ${state.pending} รายการ (ระบบไม่ผูกสินค้าเอง)`);
  }
  let sent = false;
  if (lines.length && telegramConfigured(env)) {
    let url = null;
    try { const u = new URL(String(env?.DASHBOARD_URL || "")); if (u.protocol === "https:") url = u.origin + "/admin/#suggestions"; } catch { url = null; }
    const r = await sendTelegram(env, ["🗓️ TipsUseLife AI — สรุปงานประจำวัน", ...lines, ...(url ? ["", "ตรวจคำแนะนำ: " + url] : [])].join("\n"), opts.fetchImpl);
    sent = r.ok;
    state.notify_error = r.ok ? null : r.error;
  }
  state.notified = sent;
  // U12: new pending suggestions also arrive as button messages (tap to map; two-tap confirm).
  if (telegramConfigured(env) && String(env?.TELEGRAM_MAP_BUTTONS ?? "1") !== "0") {
    try {
      const n = await notifyPendingSuggestions(env, { max: 5, onlyNew: true, fetchImpl: opts.fetchImpl });
      state.suggestion_messages = n.sent;
    } catch {
      state.suggestion_messages = 0;
    }
  }
  await writeDailyState(db, state);
  logEvent("daily_jobs", {
    discovery: d?.status ?? "OFF", inserted: d?.inserted ?? 0,
    suggestions: s?.status ?? "OFF", suggested: s?.suggested ?? 0,
    pending: state.pending, notified: sent,
  });
  return { ok: true, ...state };
}
