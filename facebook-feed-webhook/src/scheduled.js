/**
 * Cron Trigger dispatcher (index.js `scheduled()`).
 *   every 5 minutes -> read-only alert check (src/alerts.js, U1)
 *   DAILY_CRON     -> daily housekeeping (src/daily-jobs.js, U7)
 * Neither replies to, retries, recovers or reconciles a comment.
 */

import { runAlertCheck } from "./alerts.js";
import { runDailyJobs } from "./daily-jobs.js";

export const DAILY_CRON = "17 23 * * *"; // 06:17 Asia/Bangkok

export function runScheduled(controller, env) {
  const now = new Date(controller?.scheduledTime ?? Date.now());
  if (controller?.cron === DAILY_CRON) return runDailyJobs(env, { now });
  return runAlertCheck(env, { now });
}
