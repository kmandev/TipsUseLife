/**
 * Operator alerts (Upgrade U1): a read-only health + Page-token check that
 * sends a Telegram message when something NEW goes wrong (and once when it
 * recovers). Driven by the Cron Trigger in wrangler.jsonc via index.js
 * `scheduled()`, and by the Dashboard "ตรวจตอนนี้" / "ส่งข้อความทดสอบ" buttons.
 *
 * What this module never does:
 *  - reply to, retry, recover, reconcile or otherwise change any comment or
 *    reply row (it only READS healthStats);
 *  - call Hermes;
 *  - POST to Facebook (the token check is one Graph GET /me?fields=id);
 *  - put a token, secret, comment text or author into a message or a log.
 *
 * Noise control: counters alert only when they INCREASE since the last
 * check (a permanently protected row such as the ambiguous row 196 is part
 * of the baseline and never re-alerts); the first check after deploy only
 * records the baseline. Flags (token problem, LIVE send stuck) alert on the
 * transition into the bad state and once on recovery. State lives in the
 * existing `settings` table (key `alert_state_v1`); no migration.
 */

import { resolveConfig } from "./config.js";
import { healthStats as defaultHealthStats } from "./recovery.js";
import { classifyGraphFailure } from "./facebook-posts.js";
import { logEvent, logError } from "./log.js";

export const ALERT_STATE_KEY = "alert_state_v1";
export const TOKEN_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Graph token check at most hourly
export const TELEGRAM_TIMEOUT_MS = 8000;
export const GRAPH_CHECK_TIMEOUT_MS = 8000;
const MAX_MESSAGE_CHARS = 3500; // Telegram limit is 4096

/** Counters: an increase since the last check is a new incident. */
export const COUNTER_RULES = Object.freeze([
  { key: "live_outcome_unknown", icon: "🔴", text: (d) => `ผลการส่ง LIVE ไม่แน่นอนเพิ่ม ${d} รายการ — ตรวจโพสต์บน Facebook ก่อน ห้าม Retry` },
  { key: "live_failed_total", icon: "🟠", text: (d) => `Facebook ปฏิเสธคำตอบ LIVE เพิ่ม ${d} รายการ` },
  { key: "errors_total", icon: "🟠", text: (d) => `คอมเมนต์สถานะ ERROR ใหม่ ${d} รายการ` },
  { key: "stale_received", icon: "🟡", text: (d) => `คอมเมนต์ค้างสถานะ RECEIVED เพิ่ม ${d} รายการ (ยังไม่ได้ประมวลผล)` },
]);

export const TOKEN_STATUS = Object.freeze({
  OK: "OK",
  MISSING: "MISSING",
  INVALID: "INVALID",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  PAGE_MISMATCH: "PAGE_MISMATCH",
  UNKNOWN: "UNKNOWN", // transient / rate limit / network: keeps the previous verdict
});
const TOKEN_BAD = new Set([TOKEN_STATUS.MISSING, TOKEN_STATUS.INVALID, TOKEN_STATUS.PERMISSION_DENIED, TOKEN_STATUS.PAGE_MISMATCH]);
const TOKEN_TEXT = {
  MISSING: "ยังไม่ได้ตั้งค่า PAGE_ACCESS_TOKEN — ระบบตอบคอมเมนต์จริงไม่ได้",
  INVALID: "Page access token หมดอายุหรือถูกยกเลิก — ระบบตอบคอมเมนต์จริงไม่ได้ ต้องออก token ใหม่",
  PERMISSION_DENIED: "Page access token ไม่มีสิทธิ์ที่ต้องใช้ — ตรวจ permission ของแอป Meta",
  PAGE_MISMATCH: "Page access token ไม่ใช่ของเพจที่ตั้งค่าไว้ (PAGE_ID)",
};

export function telegramConfigured(env) {
  return Boolean(env?.TELEGRAM_BOT_TOKEN) && Boolean(env?.TELEGRAM_CHAT_ID);
}

/* ------------------------------ state ------------------------------ */

export async function readAlertState(db) {
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(ALERT_STATE_KEY).first();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeAlertState(db, state) {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(ALERT_STATE_KEY, JSON.stringify(state))
    .run();
}

/* --------------------------- token check --------------------------- */

/**
 * One read-only Graph GET: /me?fields=id with the Page token. Never a POST.
 * @returns {Promise<{status: string, graphCode: number|null}>}
 */
export async function checkPageToken(env, config, fetchImpl = fetch) {
  const token = env?.PAGE_ACCESS_TOKEN;
  if (!token) return { status: TOKEN_STATUS.MISSING, graphCode: null };
  const url = `https://graph.facebook.com/${encodeURIComponent(config.graphApiVersion)}/me?fields=id`;
  let res;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(GRAPH_CHECK_TIMEOUT_MS) });
  } catch {
    return { status: TOKEN_STATUS.UNKNOWN, graphCode: null };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.ok) {
    return { status: String(body?.id ?? "") === String(config.pageId) ? TOKEN_STATUS.OK : TOKEN_STATUS.PAGE_MISMATCH, graphCode: null };
  }
  const { category, graphCode } = classifyGraphFailure(res.status, body);
  if (category === "TOKEN_INVALID") return { status: TOKEN_STATUS.INVALID, graphCode };
  if (category === "PERMISSION_DENIED") return { status: TOKEN_STATUS.PERMISSION_DENIED, graphCode };
  return { status: TOKEN_STATUS.UNKNOWN, graphCode };
}

/* ----------------------------- telegram ---------------------------- */

/**
 * @returns {Promise<{ok: boolean, error?: string}>} safe category only
 */
export async function sendTelegram(env, text, fetchImpl = fetch) {
  if (!telegramConfigured(env)) return { ok: false, error: "NOT_CONFIGURED" };
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: String(env.TELEGRAM_CHAT_ID), text: String(text).slice(0, MAX_MESSAGE_CHARS), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.status === 401 || res.status === 404 ? "TELEGRAM_BAD_TOKEN" : res.status === 400 || res.status === 403 ? "TELEGRAM_BAD_CHAT" : res.status === 429 ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_HTTP_" + res.status };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "TELEGRAM_TIMEOUT" : "TELEGRAM_NETWORK" };
  }
}

/* ---------------------------- evaluation --------------------------- */

/**
 * Pure: compare the current health/token with the previous state.
 * @returns {{lines: string[], recovered: string[], next: object}}
 */
export function evaluateAlerts(prev, health, token, nowIso) {
  const first = !prev || typeof prev !== "object" || !prev.counters;
  const counters = {};
  const lines = [];
  const recovered = [];
  for (const rule of COUNTER_RULES) {
    const now = Number(health?.[rule.key] ?? 0);
    counters[rule.key] = now;
    const before = first ? now : Number(prev.counters[rule.key] ?? 0);
    if (!first && now > before) lines.push(`${rule.icon} ${rule.text(now - before)} (ทั้งหมด ${now})`);
  }

  // LIVE send stuck: in progress on two consecutive checks.
  const inProgress = Number(health?.live_send_in_progress ?? 0);
  const prevInProgress = first ? 0 : Number(prev.in_progress ?? 0);
  const stuck = inProgress > 0 && prevInProgress > 0;
  const wasStuck = !first && Boolean(prev.stuck);
  if (stuck && !wasStuck) lines.push(`🔴 มีคำตอบ LIVE ค้างสถานะ "กำลังส่ง" ${inProgress} รายการนานเกินปกติ — ตรวจโพสต์บน Facebook ห้าม Retry`);
  if (!stuck && wasStuck) recovered.push("คำตอบ LIVE ที่ค้างสถานะกำลังส่งไม่มีแล้ว");

  // Token: UNKNOWN (or not checked this run) keeps the previous verdict.
  const prevToken = first ? null : prev.token_status ?? null;
  const tokenStatus = token && token.status !== TOKEN_STATUS.UNKNOWN ? token.status : prevToken;
  const bad = TOKEN_BAD.has(tokenStatus);
  const wasBad = TOKEN_BAD.has(prevToken);
  if (bad && (!wasBad || tokenStatus !== prevToken)) lines.push(`🔴 ${TOKEN_TEXT[tokenStatus]}`);
  if (!bad && wasBad && tokenStatus === TOKEN_STATUS.OK) recovered.push("Page access token ใช้งานได้ตามปกติแล้ว");

  const next = {
    version: 1,
    counters,
    in_progress: inProgress,
    stuck,
    token_status: tokenStatus,
    token_graph_code: token && token.status !== TOKEN_STATUS.UNKNOWN ? token.graphCode ?? null : prev?.token_graph_code ?? null,
    token_checked_at: token ? nowIso : prev?.token_checked_at ?? null,
    last_check_at: nowIso,
    last_sent_at: prev?.last_sent_at ?? null,
    last_error: prev?.last_error ?? null,
    baseline_at: first ? nowIso : prev.baseline_at ?? nowIso,
  };
  return { lines, recovered, next, first };
}

export function formatAlertMessage({ lines, recovered }, dashboardUrl) {
  const out = [];
  if (lines.length) out.push("⚠️ TipsUseLife AI — แจ้งเตือนระบบ", ...lines.map((l) => "• " + l));
  if (recovered.length) {
    if (out.length) out.push("");
    out.push("✅ กลับมาปกติ", ...recovered.map((l) => "• " + l));
  }
  if (dashboardUrl) out.push("", "แดชบอร์ด: " + dashboardUrl + "#overview");
  return out.join("\n");
}

function dashboardUrlOf(env) {
  const raw = String(env?.DASHBOARD_URL || "");
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.origin + "/admin/" : null;
  } catch {
    return null;
  }
}

/* ------------------------------- run ------------------------------- */

/**
 * One alert check. Safe to call from the Cron Trigger or the Dashboard.
 * @param {any} env
 * @param {{now?: Date, fetchImpl?: typeof fetch, healthStats?: Function, forceTokenCheck?: boolean}} [opts]
 */
export async function runAlertCheck(env, opts = {}) {
  const db = env?.DB;
  if (!db) {
    logError("alert_check_failed", "D1_BINDING_MISSING");
    return { ok: false, error: "D1_BINDING_MISSING" };
  }
  const now = opts.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();
  const nowIso = now.toISOString();
  const fetchImpl = opts.fetchImpl || fetch;
  const config = resolveConfig(env);

  let health;
  try {
    health = await (opts.healthStats || defaultHealthStats)(db, config.pageId);
  } catch {
    logError("alert_check_failed", "D1_SELECT_FAILED");
    return { ok: false, error: "D1_SELECT_FAILED" };
  }
  const prev = await readAlertState(db);

  const lastTokenAt = Date.parse(prev?.token_checked_at ?? "");
  const tokenDue = opts.forceTokenCheck || !Number.isFinite(lastTokenAt) || now.getTime() - lastTokenAt >= TOKEN_CHECK_INTERVAL_MS;
  const token = tokenDue ? await checkPageToken(env, config, fetchImpl) : null;

  const result = evaluateAlerts(prev, health, token, nowIso);
  const { lines, recovered, next } = result;
  let sent = false;
  let sendError = null;
  if (lines.length || recovered.length) {
    if (telegramConfigured(env)) {
      const r = await sendTelegram(env, formatAlertMessage(result, dashboardUrlOf(env)), fetchImpl);
      sent = r.ok;
      sendError = r.ok ? null : r.error;
    } else {
      sendError = "NOT_CONFIGURED";
    }
  }

  if (sendError && sendError !== "NOT_CONFIGURED") {
    // Not delivered: keep the old baseline so the next check alerts again.
    // Only the bookkeeping fields move forward.
    // With no previous state there is nothing to keep: the next check is
    // again a "first" check (baseline + token verdict, which re-alerts).
    if (prev && prev.counters) {
      const keep = { ...prev, last_check_at: nowIso, last_error: sendError };
      await safeWrite(db, keep); // token_checked_at unchanged -> re-checked (and re-alerted) next time
    }
  } else {
    if (sent) { next.last_sent_at = nowIso; next.last_error = null; }
    if (sendError === "NOT_CONFIGURED") next.last_error = "NOT_CONFIGURED";
    await safeWrite(db, next);
  }

  logEvent("alert_check", {
    first: result.first,
    alerts: lines.length,
    recovered: recovered.length,
    sent,
    send_error: sendError,
    token_checked: Boolean(token),
    token_status: next.token_status,
  });
  return { ok: true, first: result.first, alerts: lines.length, recovered: recovered.length, sent, send_error: sendError, token_status: next.token_status };
}

async function safeWrite(db, state) {
  try {
    await writeAlertState(db, state);
  } catch {
    logError("alert_state_write_failed", "D1_WRITE_FAILED");
  }
}

/** Dashboard test message: proves the bot token + chat id work. No D1 write. */
export async function sendTestAlert(env, fetchImpl = fetch) {
  const text = "✅ TipsUseLife AI — ทดสอบการแจ้งเตือน\nถ้าเห็นข้อความนี้ แปลว่าระบบส่งแจ้งเตือนเข้า Telegram ได้แล้ว";
  return sendTelegram(env, text, fetchImpl);
}
