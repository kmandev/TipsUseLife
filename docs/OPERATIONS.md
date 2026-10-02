# Operations — TipsUseLife Facebook Comment Agent

All Cloudflare commands run **on the Raspberry Pi** (`~/TipsUseLife-AI`),
where wrangler is authenticated. Never paste secret values into chat, logs
or command lines; pipe them or use the interactive prompt.

## Current Operational Status — Phase 8.62

Recorded at the Phase 8.x closeout (2026-10-02). Update this section when the
state changes.

**Production**

| Item | Value |
|---|---|
| Worker version | `f2ebf09f-1d6a-42e1-9a37-6e037447be55` (100% traffic) |
| Source baseline | `936aa0d` (`fix(webhook): harden late cleanup and add Graph response telemetry`) |
| `REPLY_MODE` | `DRY_RUN` |
| Permanent LIVE | **NOT ENABLED** |
| Tests | 357 / 357 pass |

**Evidence status**

| Item | Status |
|---|---|
| Normal LIVE E2E | **PROVEN** (Phase 8.55, one authorized test): exactly one Graph POST, HTTP 200, `headers_ms` 5524, `graph_elapsed_ms` 5524, Facebook trace/request ids captured, Facebook reply verified via its own webhook echo, D1 reply `SENT`, comment `REPLIED`, no duplicate, no retry, production restored to `DRY_RUN` |
| Late-response production E2E | **NOT OBSERVED.** Covered by deterministic automated tests (Phase 8.44 / 8.50). No latency was induced and none should be. This is an evidence gap, not a known implementation failure; the design fails safe (the row is recorded ambiguous before late observation starts) |
| M1 — Worker lifetime 18–27 s | **NOT VERIFIED IN PRODUCTION.** Longest observed production invocation ≈ 17 s |
| Original Graph timeout root cause | **UNPROVEN.** Evidence shows only that response-header latency can exceed 10 s on some sends (observed 5.5 s – >10 s, with the reply created at about the start of the POST). Not attributed to Facebook, Cloudflare or the network |

**Row 196 (comment 240) — protected ambiguous send**

* Reply row 196: `LIVE` / `GENERATED` / `GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT`,
  `facebook_reply_id = NULL`. Comment 240 (`1694107882724308_1081348987969658`): `ERROR`.
* Recovery: `PROTECTED_AMBIGUOUS_SEND` → **DO NOT RETRY. DO NOT MUTATE.**
* History: one reconcile attempt (Phase 8.58) → `GRAPH_READ_4XX` (Facebook 400),
  no change; read-only Graph Explorer (Phase 8.59): the post is readable but
  comment 240 is not returned by its comment listing (deletion not proven).
* Decision (Phase 8.60): leave as is. The schema has no truthful terminal
  status for "dispatched, outcome unknown, investigation stopped": `SENT` would
  be false without an id, `FAILED` means confirmed-not-sent, and `SKIPPED` would
  remove `hasLiveSendAttempt` protection. The current state is the truthful,
  permanently protected record; no further mutation is required.

## Worker configuration

| Name | Kind | Purpose |
|---|---|---|
| `REPLY_MODE` | var | `DRY_RUN` (default). Only the exact string `LIVE` **and** a present `PAGE_ACCESS_TOKEN` enable replies. |
| `PAGE_ID` | var | `853313081388711` |
| `HERMES_URL` | var | `https://hermes-feed.cloudnext.icu/v1/chat/completions` |
| `HERMES_TIMEOUT_MS` | var | `20000`. The whole per-comment pipeline has a 27 s budget (`PIPELINE_BUDGET_MS`, below the ~30 s `waitUntil` window); Hermes only ever gets what is left after reserving the Graph slice. |
| `GRAPH_TIMEOUT_MS` | var, optional | default `5000`: the ambiguity threshold for one LIVE Graph send (with `GRAPH_LATE_OBSERVE_MS=0` it is also the hard abort, as before Phase 8.44). A LIVE send that no longer fits the budget is not started (`SEND_BUDGET_EXHAUSTED`). |
| `GRAPH_LATE_OBSERVE_MS` | var, optional | Phase 8.44, default `15000` (max `20000`; `0` disables): after the threshold the send is recorded `GRAPH_OUTCOME_UNKNOWN:GRAPH_TIMEOUT` and the **same** request keeps being observed for up to this long, bounded by the pipeline budget minus a 2 s finalize reserve. A late 2xx with a valid id moves that row to `SENT` (`LATE_RESPONSE:` provenance) through the same compare-and-set as reconciliation. Never a second request. |
| LIVE send states | D1 `replies` (mode=LIVE) | `GENERATED`+`GRAPH_SEND_IN_PROGRESS` = attempt started (written before the request) · `SENT` = HTTP 2xx (id may be null: `SENT_ID_UNPARSEABLE`) · `FAILED`+`GRAPH_REJECTED_<4xx>` = confirmed not sent · `GENERATED`+`GRAPH_OUTCOME_UNKNOWN:*` = timeout/network/5xx, **may exist on Facebook — never retry automatically, check the post by hand**. Graph sends are never retried. |
| Hermes concurrency | Pi config | Hermes `api_server` runs at most `gateway.api_server.max_concurrent_runs` (default **10**) agent runs at once and answers the rest `429 Retry-After: 1` before any run starts. The Worker retries **only** that 429: at most 4 attempts, 1–3 s backoff + up to 1 s jitter, all inside the Hermes budget (`HERMES_TIMEOUT_MS`, 20 s) (log event `hermes_busy_backoff`). Timeouts, network errors and 5xx are never retried. Measured (Phase 7.1): 1–10 concurrent comments → 0 errors; above 10 the excess used to fail as `HERMES_BUSY`. |
| `GRAPH_API_VERSION` | var | `v21.0` (available until 2027-01-21) |
| `MAX_REPLY_LENGTH` | var | `300` — max AI text length (link excluded) |
| `ECHO_GUARD_WINDOW_SECONDS` | var, optional | default `600` (not set in `wrangler.jsonc`). Self-reply layer 2.5: an event **with no author** is dropped (`event_ignored` `POSSIBLE_OWN_ECHO`, with `thread_id` and `guard_state`) if its thread got a LIVE send attempt with no known reply id (`GRAPH_SEND_IN_PROGRESS`, `GRAPH_OUTCOME_UNKNOWN:*`, `SENT_ID_UNPARSEABLE`) within this many seconds, inclusive. A D1 read error drops the event too (`POSSIBLE_OWN_ECHO_GUARD_ERROR`). Events with a `from.id` are never affected. Invalid values fall back to 600. See `docs/ARCHITECTURE.md` → "Self-reply protection". |
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

**Reconcile an ambiguous LIVE send** (Phase 8.36) — `POST /admin/api/comments/:id/reconcile` (session + same-origin JSON, like retry; no dashboard button yet). `GRAPH_OUTCOME_UNKNOWN` means the HTTP outcome was not observed, **not** that Facebook failed: on 2026-10-01 row 245 timed out at 10 s although Facebook had created the reply 0.5 s after the request. Reconcile never posts and never retries: it reads the thread once (read-only Graph GET with the Page token) and, only if exactly one Page reply matches by thread, time window and exact text, sets the row `SENT` with that `facebook_reply_id` (`error_message` `RECONCILED:…`) and the comment `REPLIED`. Responses: `200 RECONCILED`; `409` `NOT_ELIGIBLE` / `NOT_FOUND` / `MULTIPLE_MATCHES` / `INCOMPLETE` / `CAS_LOST` (row unchanged); `502 GRAPH_READ_*` (row unchanged); `404` unknown comment. Repeating it is safe (`NOT_ELIGIBLE`). If it does not reconcile, check the post on Facebook by hand — still never retry.

Recovery also runs the self-reply layers 2 and 2.5: a stored comment that looks like our own echo is refused with `409 NOT_ELIGIBLE` and reason `OWN_REPLY_EVENT`, `POSSIBLE_OWN_ECHO` or `POSSIBLE_OWN_ECHO_GUARD_ERROR`.

`GET /admin/api/health` (session): ERROR 1 h / 24 h / total, recoverable ERROR and stale RECEIVED, stale RECEIVED (+ oldest), LIVE GENERATED / outcome-unknown / send-in-progress (+ oldest), LIVE FAILED 4xx / total (+ oldest), LIVE SENT, LIVE SENT with unreadable reply id (`live_sent_id_unparseable`), DRY_RUN GENERATED, totals. Suppressed echoes are not stored, so they are not counted here — they appear only as `event_ignored` log lines (`POSSIBLE_OWN_ECHO`, `POSSIBLE_OWN_ECHO_GUARD_ERROR`). Counts and timestamps only — no text, URLs or secrets. Alerting is **not** implemented yet (channel is an operator decision); this endpoint is its data source.

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
3. Expect `comment_received → product_resolved → reply_drafted` (or
   `ai_action_skip` if the model chooses not to reply). A Page-authored
   comment shows `event_ignored` / `SELF_AUTHORED` instead. Full event list:
   `docs/ARCHITECTURE.md` → "Observability".
4. Dashboard → กิจกรรมคอมเมนต์: status `PROCESSED`, reply `GENERATED`,
   mode `DRY_RUN`, draft ending with the product's affiliate URL.
5. Confirm **no reply appears on Facebook**.

## Controlled LIVE test (deliberate evidence collection only)

Controlled LIVE is for deliberate evidence collection only. Permanent LIVE
enablement is a separate operational decision (next section). This is the
procedure used in Phases 8.41, 8.42, 8.48 and 8.55:

1. Get explicit authorization for **exactly one** controlled LIVE test.
2. Define the target post and the test account. Check the duplicate-link guard
   window (same author + post + link within 24 h is suppressed), and that no
   unresolved ambiguous row is involved.
3. Deploy the **existing** bundle with only the mode overridden:
   `npx wrangler deploy --var REPLY_MODE:LIVE --message "<phase> controlled LIVE test"`.
4. Verify: `npx wrangler deployments status` shows the new version at 100%, and
   `npx wrangler versions view <id>` shows `REPLY_MODE=LIVE` with every other
   var and secret name unchanged.
5. Allow **exactly one** new test comment (posted by a person, never as the
   Page; no replay, no forged webhook).
6. Observe with `npx wrangler tail`: `comment_received`, `reply_sent` (or
   `reply_send_ambiguous` / `graph_late_*`), Graph `status_code`,
   `headers_ms`, `graph_elapsed_ms`, `fb_trace_id` / `fb_request_id`, the
   `SELF_AUTHORED` echo, and the new D1 rows (read-only SELECTs).
7. Restore DRY_RUN: `npx wrangler rollback <previous DRY_RUN version id> -m "<phase> end LIVE window -> DRY_RUN" -y`.
8. Verify DRY_RUN again (`deployments status` + `versions view`).

Never retry an ambiguous result, never post a second comment to "try again",
and never change `GRAPH_TIMEOUT_MS` / `GRAPH_LATE_OBSERVE_MS` or induce
latency to force the late path.

## Switching DRY_RUN → LIVE permanently (separate decision, two-person-rule recommended)

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

## Post discovery (Phase AM-2 — read-only, manual)

Lists the Page's posts and reels in the Dashboard tab **โพสต์ที่ค้นพบ** so
they can be mapped to products. **AM-2 does not create, change or
deactivate any mapping, does not change comment replies, does not call
Hermes, and performs no Facebook write.** Nothing runs automatically: there
is no cron, queue or webhook trigger for discovery.

**Run it.** Dashboard → โพสต์ที่ค้นพบ → ค้นหาโพสต์ใหม่ (equivalent to an
authenticated `POST /admin/api/discovery/run` with a same-origin JSON body).
It reads two edges with `GET` only, using the existing `PAGE_ACCESS_TOKEN`
in the `Authorization` header: `/{page}/published_posts` (fields
`id,message,created_time,permalink_url,status_type`) and `/{page}/video_reels`
(`id,description,created_time,permalink_url`). Nothing else is fetched: no
comments, no author data, no media.

**Limits.** 25 items per page, at most 2 pages and 50 items per edge. Time
budget (AM-2.2): **each edge has its own 20 s deadline** (a slow edge cannot
starve the other; in AM-2.1 a shared 20 s deadline made the posts edge time
out after one page), and the whole run is bounded by a hard 45 s total. A run
that stops at a limit is reported `truncated` (older posts may exist; not an
error). No automatic retry. Only one run at a time: a second request answers
`409 ALREADY_RUNNING`; a `RUNNING` row older than 300 s is treated as
abandoned (`RUN_ABANDONED`). Worst case is roughly 190 D1 queries per run
(the first run after migration 0005 also backfills canonical ids); this needs
the Workers Paid D1 query limit (1000 per invocation).

**Logical Reels and canonical identity (AM-2.2).** The same Reel is listed
by Facebook under two ids: the posts edge gives `<page>_<n>` and the reels
edge a bare video id (observed: 25 of 75 rows in the first production run).
The numeric parts are unrelated, so the link is the permalink. Source rows are
kept exactly as read (`post_id` is never changed and nothing is deleted);
`post_candidates.canonical_reel_id` (migration `0005`, nullable, not unique)
holds the reel id taken **only** from a permalink of exactly
`https://www.facebook.com/reel/<digits>` (host `www.facebook.com` or
`facebook.com`; trailing slash, query and fragment tolerated; anything else —
other hosts, http, other paths, malformed — gives NULL). Nothing is inferred
from text, timestamps or id strings.

The Dashboard/API list shows one item per *logical* content: same page and
same non-null `canonical_reel_id`; with a NULL canonical id the row stands
alone. The shown row (the **representative**) is chosen by: 1) a row whose
`post_id` matches an existing `content_mappings` row (an active mapping before
an inactive one); 2) otherwise the posts-edge row (its `<page>_<n>` id is what
comment webhooks and therefore mappings use); 3) otherwise the reels-edge row;
ties: lowest id. Mapping state (`ACTIVE`/`INACTIVE`/`NONE`) is read from the
representative's `post_id`. `content_mappings` is only read, never written, and
its keys are unchanged. Each item reports `source_count`, `source_post_ids`,
`representative_post_id`, `canonical_reel_id`. Pagination and filters apply to
the logical list.

**Backfill.** Rows discovered before migration 0005 have a NULL
`canonical_reel_id`. `backfillCanonicalReelIds` (src/discovery.js) fills only
NULL values from the stored permalink, is idempotent, never changes `post_id`
or mappings and never deletes. It runs automatically at the end of every
discovery run, so the first discovery after deploying 0005 groups the old
rows; until then the old duplicates still show.

**Run result** (`status`): `OK` all edges read; `PARTIAL` one edge failed or
some rows could not be written (what was read is kept); `FAILED` nothing could
be read — HTTP 502, never presented as an empty success. Counters:
`discovered`, `inserted`, `updated` (text edited), `unchanged`, `skipped`
(malformed id or the same post under both edges), `failed` (D1 write errors).
`503 TOKEN_MISSING` = no `PAGE_ACCESS_TOKEN` (no run is recorded).

**Candidate status** (`post_candidates.status`): `DISCOVERED` — first seen,
text unchanged since; `UPDATED` — text changed after first discovery
(`revision` increments, `content_changed_at` set). Posts removed on Facebook
are **not** detected in AM-2 (absence from a bounded listing proves nothing).
Mapping state shown per row: `ACTIVE`, `INACTIVE`, `NONE`, read from
`content_mappings`; a candidate is "unmapped" only when no active mapping row
exists.

**Inspect errors.** Dashboard → โพสต์ที่ค้นพบ → ประวัติการค้นหา, or
`GET /admin/api/discovery/runs`, or D1:
`SELECT id,status,error_code,detail FROM discovery_runs ORDER BY id DESC LIMIT 5;`.
`detail` holds per-edge `{source, ok, error_code, graph_code, http_status,
pages, items, complete, truncated}` only — never a token, a Graph error
message or post text. Error codes: `TOKEN_INVALID` (Graph 190/463/467 or HTTP
401 — token expired/revoked), `PERMISSION_DENIED` (Graph 10, 200–299, HTTP
403 — the token lacks a read permission), `RATE_LIMITED` (4/17/32/613 or 429),
`TRANSIENT` (5xx), `GRAPH_REJECTED` (other 4xx), `NETWORK`, `TIMEOUT`,
`MALFORMED`, `RUN_ABANDONED`, `ITEM_WRITE_FAILED`, `INTERNAL_ERROR`.

**Meta permissions — status.** Reading a Page's posts needs a Page token with
`pages_read_engagement` (and, for reels/videos, `pages_show_list`/the Page
task that can read videos). **UNVERIFIED:** no live Graph request was made
in AM-2 (no Page token is reachable from the build environment), so these
are unconfirmed against the real Page and v21.0:

- that the current token can read `published_posts` and `video_reels`;
- that the field names above are accepted by v21.0;
- that a reel's `id` from `video_reels` equals the `post_id` Meta sends in a
  comment webhook (needed for the mapping join to match);
- that `permalink_url` for reels is returned;
- webhook delivery of post create/edit events (not used by AM-2).

If a read is refused the run reports the failure; nothing is faked. First
live check (read-only, operator): run discovery once and read the result; a
`PERMISSION_DENIED`/`TOKEN_INVALID` result is the exact blocker to resolve in
the Meta app.

**Deploy / migrate (not executed by AM-2).** 1) `git pull` on the Pi. 2)
`cd facebook-feed-webhook && npm test`. 3) Apply the pending migrations (`0004_post_candidates.sql`, and from AM-2.2
`0005_post_candidates_canonical_reel.sql`) with
`npx wrangler d1 migrations apply tipsuselife-ai --remote` (additive: two new
tables, nothing existing is altered; older Worker versions ignore them). 4)
`npx wrangler deploy`. No `wrangler.jsonc` change is needed. Rollback: the
previous Worker version still works with the tables present.

## Product mapping suggestions (Phase AM-2.3 — review only, manual)

AI **suggests** which catalog product an unmapped discovered post/Reel
promotes. **The AI run never creates or changes a mapping** (only an explicit, confirmed
human approval does — see below), never calls Facebook,
is not connected to the webhook or the reply pipeline, and runs only when an
operator presses the button. Mapping stays the existing manual action.

**Run it.** Dashboard → สินค้าแนะนำ → สร้างคำแนะนำ (= authenticated
`POST /admin/api/suggestions/generate`, same-origin JSON). One run:
1. lists logical items (AM-2.2 identity `r:<canonical_reel_id>` / `p:<post_id>`)
   whose representative has **no** mapping row (an inactive mapping counts as
   mapped);
2. marks stale `PENDING` suggestions `SUPERSEDED` (the item got mapped, or its
   text hash changed);
3. runs the deterministic prefilter (`src/suggestion-prefilter.js`) against
   active, non-deleted products: full name (10) > Latin brand word (5) >
   keyword ≥ 3 chars (2) > keyword shared by several products (1); NFC, lower
   case, URLs/whitespace/punctuation removed; description is not used. Zero
   hits → no AI call. At most 5 candidates;
4. calls Hermes (`hermes.js requestAgentReply`, unchanged) **serially**, at most
   **5 calls per run**, **15 s per call**, **60 s per run**, no retry (a 429
   skips the item); the caption (URLs replaced by `[link]`, ≤ 1,500 chars) and
   the candidates `{id,name,keywords,description}` are sent as JSON data —
   never an affiliate/shopee/image URL, token or secret;
5. validates the answer strictly: exactly `{product_id, confidence, reason}`;
   `product_id` must be one of the candidate ids sent for that call (or
   `null` = no match); confidence `HIGH|MEDIUM|LOW`; reason ≤ 200 chars, no
   URL. Anything else fails closed and stores nothing;
6. stores a `PENDING` row in `product_suggestions` (no-match rows keep
   `product_id` NULL). The same item + text is never sent to the AI twice; a
   rejected suggestion is not regenerated until the text changes.

Only one run at a time (`409 ALREADY_RUNNING`; a run older than 300 s is
`RUN_ABANDONED`). `503 HERMES_NOT_CONFIGURED` without `HERMES_API_KEY`.
Result: `status` OK / PARTIAL / FAILED and counters `eligible`, `processed`,
`suggested`, `no_match`, `skipped` (no prefilter signal, already suggested,
over the 5-call cap, budget exhausted, Hermes busy), `failed`, `superseded`;
`error_code` is a safe category (`HERMES_TIMEOUT`, `HERMES_BUSY`,
`AI_OUTPUT_PRODUCT_NOT_CANDIDATE`, …). History: `GET /admin/api/suggestions/runs`
or `SELECT * FROM suggestion_runs ORDER BY id DESC LIMIT 5;`.

**Review.** Each row shows post text, suggested product, confidence, reason,
prefilter score and status. **ปฏิเสธ** sets `REJECTED`
(`POST /admin/api/suggestions/:id/reject`). **แก้ไขในฟอร์ม** opens the existing
"โพสต์ / Reel" mapping form pre-filled; the operator saves it there.

**Human approval (AM-2.4).** **ผูกสินค้านี้** asks for confirmation, then calls
`POST /admin/api/suggestions/:id/approve` (session + same-origin JSON). The
server ignores the request body and uses only the stored suggestion:
- it must be `PENDING`, with a non-NULL product that exists, is active and not
  deleted;
- the logical subject must still exist and its AM-2.2 representative must be a
  posts-edge `<page>_<n>` row of this Page (a bare reel id is never mapped;
  nothing is fabricated), with content type POST or REEL;
- the representative's current text hash must equal the suggestion's
  (otherwise `SUGGESTION_STALE` — generate again);
- **no mapping row, active or inactive, may exist for any source id of the
  subject** (`MAPPING_EXISTS`). This is stricter than the manual form, which
  replaces: an approval never overwrites or re-activates a mapping.
The write is one D1 batch (transaction): a conditional INSERT into
`content_mappings` (`active = 1`, note `จากสินค้าแนะนำ #<id>`), the suggestion
`PENDING → APPROVED` (`decided_at` set), and the other `PENDING` suggestions of
the same subject `→ SUPERSEDED`. If any part fails nothing is applied. A double
click or retry returns `200` with `idempotent: true` and never creates a second
mapping. No Facebook, Hermes or other network call. From the next comment on
that post the reply pipeline resolves the product through its existing mapping
lookup — the reply path itself is unchanged. Errors (409 unless noted):
`NOT_FOUND` (404), `NOT_PENDING`, `NO_PRODUCT`, `PRODUCT_UNAVAILABLE`,
`SUBJECT_NOT_FOUND`, `MAPPING_EXISTS`, `NO_SAFE_REPRESENTATIVE`,
`CONTENT_TYPE_UNKNOWN`, `SUGGESTION_STALE`, `CONFLICT`, `MAPPING_WRITE_FAILED`.
There is no automatic approval of any kind.

**Hermes contention.** Suggestions share Hermes' concurrency cap with live
comment replies. Runs are serial and capped at 5 calls; run them at a quiet
time and check `GET /admin/api/health` afterwards. A suggestion failure never
affects replies, discovery or Graph sends.

**Deploy / migrate (not executed by AM-2.3).** Apply
`database/migrations/0006_product_suggestions.sql` (two new tables, nothing
existing altered) with `npx wrangler d1 migrations apply tipsuselife-ai --remote`,
then `npx wrangler deploy`. No `wrangler.jsonc` change.

## Routine operations

- New product: Dashboard → สินค้า Affiliate → เพิ่มสินค้า (https link on an
  allowed host; description is the only product truth the AI gets).
- New post/reel: after its first comment it appears under
  "โพสต์ที่มีคอมเมนต์แต่ยังไม่ผูกสินค้า" → ผูกสินค้า. Or paste its id.
- Product sold out / link dead: toggle it off — mapped posts stop getting a
  link immediately (replies degrade to text-only or SKIP).
- Graph API version: bump `GRAPH_API_VERSION` before 2027-01-21.
