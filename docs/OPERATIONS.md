# Operations — TipsUseLife Facebook Comment Agent

All Cloudflare commands run **on the Raspberry Pi** (`~/TipsUseLife-AI`),
where wrangler is authenticated. Never paste secret values into chat, logs
or command lines; pipe them or use the interactive prompt.

## Worker configuration

| Name | Kind | Purpose |
|---|---|---|
| `REPLY_MODE` | var | `DRY_RUN` (default). Only the exact string `LIVE` **and** a present `PAGE_ACCESS_TOKEN` enable replies. |
| `PAGE_ID` | var | `853313081388711` |
| `HERMES_URL` | var | `https://hermes-feed.cloudnext.icu/v1/chat/completions` |
| `HERMES_TIMEOUT_MS` | var | `20000`. The whole per-comment pipeline has a 27 s budget (`PIPELINE_BUDGET_MS`, below the ~30 s `waitUntil` window); Hermes only ever gets what is left after reserving the Graph slice. |
| `GRAPH_TIMEOUT_MS` | var, optional | default `5000`: hard abort for one LIVE Graph send. A LIVE send that no longer fits the budget is not started (`SEND_BUDGET_EXHAUSTED`). |
| LIVE send states | D1 `replies` (mode=LIVE) | `GENERATED`+`GRAPH_SEND_IN_PROGRESS` = attempt started (written before the request) · `SENT` = HTTP 2xx (id may be null: `SENT_ID_UNPARSEABLE`) · `FAILED`+`GRAPH_REJECTED_<4xx>` = confirmed not sent · `GENERATED`+`GRAPH_OUTCOME_UNKNOWN:*` = timeout/network/5xx, **may exist on Facebook — never retry automatically, check the post by hand**. Graph sends are never retried. |
| Hermes concurrency | Pi config | Hermes `api_server` runs at most `gateway.api_server.max_concurrent_runs` (default **10**) agent runs at once and answers the rest `429 Retry-After: 1` before any run starts. The Worker retries **only** that 429: at most 4 attempts, 1–3 s backoff + up to 1 s jitter, all inside the Hermes budget (`HERMES_TIMEOUT_MS`, 20 s) (log event `hermes_busy_backoff`). Timeouts, network errors and 5xx are never retried. Measured (Phase 7.1): 1–10 concurrent comments → 0 errors; above 10 the excess used to fail as `HERMES_BUSY`. |
| `GRAPH_API_VERSION` | var | `v21.0` (available until 2027-01-21) |
| `MAX_REPLY_LENGTH` | var | `300` — max AI text length (link excluded) |
| `AFFILIATE_ALLOWED_HOSTS` | var, optional | comma list; default Shopee/Lazada/TikTok short-link hosts |
| `META_APP_SECRET` | secret | Meta webhook signature |
| `META_VERIFY_TOKEN` | secret | Meta subscription handshake |
| `HERMES_API_KEY` | secret | = `API_SERVER_KEY` in the Pi's `~/.hermes/.env` |
| `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` | secret | Dashboard login / session signing |
| `PAGE_ACCESS_TOKEN` | secret, **LIVE only** | Page token with `pages_manage_engagement`; absent = hard DRY_RUN lock |
| `HERMES_SECRET` | secret, **unused** | Not read by any Worker code (all repo references removed in Phase 6). It belonged to the retired `/webhooks/facebook-comments` path. Still present as a production Worker secret; safe to delete with `npx wrangler secret delete HERMES_SECRET` (creates a new Worker version — do it as a separate, audited change). Hermes auth uses `HERMES_API_KEY` only. |
| `ADMIN_LOGIN_LIMITER` | rate-limit binding | `ratelimits` in `wrangler.jsonc`: 5 login attempts / 60 s per client IP → `429 RATE_LIMITED`. Per-location and approximate. If the binding is missing, login still works (logged as `admin_login_ratelimit_unavailable`). |

## Recovery and health (Phase 8.2)

**Operator recovery only** — nothing retries automatically. Dashboard → ภาพรวม → "สถานะการทำงาน" lists comments needing attention; a **Retry** button appears only when the shared rule (`src/recovery.js recoveryReasonSql`) says `ELIGIBLE`:

* comment younger than 24 h, **and**
* no reply row at all — except exactly one LIVE `SKIPPED` `SEND_BUDGET_EXHAUSTED` row (nothing was sent), **and**
* `status = ERROR`, or `status = RECEIVED` for > 2 min and untouched for 2 min.

Retry = `POST /admin/api/comments/:id/retry` (session + same-origin JSON). It claims the row atomically (`UPDATE … WHERE <rule> = 'ELIGIBLE'`, one winner), then resumes the normal pipeline from the product lookup with the same `fbc:<comment_id>` Idempotency-Key, Hermes budget/backoff, validation, link guard, LIVE gates and send marker. Responses: `200 RECOVERED` (with the pipeline outcome), `409 NOT_ELIGIBLE`/`ALREADY_CLAIMED` (with a reason), `404`, `400 INVALID_ID`.

**Never recoverable** (no button; the dashboard shows "ตรวจสอบโพสต์บน Facebook ก่อน — ห้าม Retry" for the first two): LIVE `GENERATED` + `GRAPH_OUTCOME_UNKNOWN:*`, LIVE `GENERATED` + `GRAPH_SEND_IN_PROGRESS`, LIVE `SENT`, LIVE `FAILED`, any DRY_RUN reply, any other reply state, anything older than 24 h (e.g. the historical test ERROR rows).

`GET /admin/api/health` (session): ERROR 1 h / 24 h / total, recoverable ERROR and stale RECEIVED, stale RECEIVED (+ oldest), LIVE GENERATED / outcome-unknown / send-in-progress (+ oldest), LIVE FAILED 4xx / total (+ oldest), LIVE SENT, DRY_RUN GENERATED, totals. Counts and timestamps only — no text, URLs or secrets. Alerting is **not** implemented yet (channel is an operator decision); this endpoint is its data source.

### Hermes concurrency evidence (W4 — no change made)

`max_concurrent_runs` is the default **10** (not set in `~/.hermes/config.yaml`). Measured, DRY_RUN: bursts of 1–10 → 0 errors; 12/14/16 before the 429 backoff → 2/4/6 errors (exactly the excess); after the backoff 12/14/16 → 0 errors, 429s absorbed (up to 17 per burst); Phase 8.1 (20 s Hermes budget) 16 → 0 errors, slowest persist ~20 s; Pi ≥ 56 % CPU idle, ≥ 519 MB free. **No evidence yet** for bursts > 16 or with concurrent unrelated Hermes jobs (they share the same 10 slots). No recommendation to change the cap.

## Raspberry Pi services (systemd **user** units, user `pi`)

| Unit | Listens | Role |
|---|---|---|
| `hermes-gateway.service` | `127.0.0.1:8642` api_server, `127.0.0.1:8645` webhook | Hermes |
| `hermes-edge-proxy.service` | `127.0.0.1:8644`, `[::1]:8644` | allow-list proxy; source `hermes/edge-proxy/` |
| `cloudflared-facebook-feed.service` (system) | — | tunnel; ingress `hermes-feed`/`feed.cloudnext.icu → localhost:8644` (dashboard-managed, unchanged) |

Hermes config (`~/.hermes/config.yaml`, set with `hermes config set …`):

```yaml
platforms:
  webhook:    { enabled: true, extra: { host: 127.0.0.1, port: 8645 } }
  api_server: { enabled: true, extra: { host: 127.0.0.1, port: 8642 } }
platform_toolsets:
  api_server: []        # the comment agent gets NO tools
```

Health checks (no LLM call):

```bash
curl -s http://127.0.0.1:8644/health                        # proxy → api_server
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8644/api/sessions   # 404 expected
ss -ltn | grep -E ':(8642|8644|8645)\b'                      # loopback only
```

## Deploy

```bash
cd ~/TipsUseLife-AI && git pull --ff-only
cd facebook-feed-webhook && npm ci && npm test
npx wrangler d1 migrations list tipsuselife-ai --remote
npx wrangler d1 migrations apply tipsuselife-ai --remote     # additive only
npx wrangler deploy
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://facebook-feed-webhook.farkram.workers.dev/ -d '{}'   # 401
```

Set / rotate the Hermes key (value never displayed):

```bash
NEW=$(openssl rand -hex 32)
sed -i "s/^API_SERVER_KEY=.*/API_SERVER_KEY=$NEW/" ~/.hermes/.env
printf '%s' "$NEW" | npx wrangler secret put HERMES_API_KEY; unset NEW
systemctl --user restart hermes-gateway.service
```

## Production DRY_RUN test

1. `npx wrangler tail --format json` in one terminal.
2. Comment on a mapped post **from a personal account** (Page-authored
   comments are ignored by design), e.g. `ขอพิกัดครับ`.
3. Expect `comment_received → product_resolved → reply_drafted`.
4. Dashboard → กิจกรรมคอมเมนต์: status `PROCESSED`, reply `GENERATED`,
   mode `DRY_RUN`, draft ending with the product's affiliate URL.
5. Confirm **no reply appears on Facebook**.

## Switching DRY_RUN → LIVE (deliberate, two-person-rule recommended)

All must hold first: production DRY_RUN drafts reviewed and correct; Meta app
has `pages_manage_engagement` approved; a long-lived Page token with the
MODERATE task.

```bash
npx wrangler secret put PAGE_ACCESS_TOKEN        # interactive prompt
# edit wrangler.jsonc: "REPLY_MODE": "LIVE"  (exact, uppercase)
npm test && npx wrangler deploy
```

Settings → "REPLY_MODE (มีผลจริง)" must then read `LIVE`.

## Rollback

| What | How |
|---|---|
| Stop replying immediately | set `"REPLY_MODE": "DRY_RUN"` and `npx wrangler deploy`, or `npx wrangler secret delete PAGE_ACCESS_TOKEN` (instant hard lock) |
| Previous Worker version | `npx wrangler rollback` (or `wrangler deployments list` → `rollback <id>`) |
| Hermes config | backups in `~/.hermes/backups/config.yaml.<ts>` / `.env.<ts>`; copy back, `systemctl --user restart hermes-gateway` |
| Edge proxy | `systemctl --user restart hermes-edge-proxy`; to remove it: `disable --now`, then restore `~/.hermes/backups/config.yaml.<ts>` and restart Hermes |
| D1 | migrations are additive; older Worker versions ignore the new columns/table |

## Routine operations

- New product: Dashboard → สินค้า Affiliate → เพิ่มสินค้า (https link on an
  allowed host; description is the only product truth the AI gets).
- New post/reel: after its first comment it appears under
  "โพสต์ที่มีคอมเมนต์แต่ยังไม่ผูกสินค้า" → ผูกสินค้า. Or paste its id.
- Product sold out / link dead: toggle it off — mapped posts stop getting a
  link immediately (replies degrade to text-only or SKIP).
- Graph API version: bump `GRAPH_API_VERSION` before 2027-01-21.
