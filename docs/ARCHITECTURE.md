# TipsUseLife — Facebook Page AI Affiliate Comment Agent

Architecture of record. If another document disagrees with this one, this
one (and the source it cites) wins.

## Scope

Facebook **Page** comments on posts and reels of Page `853313081388711`
only. Not supported: Instagram, TikTok, YouTube, personal profiles,
Groups.

## Request flow

```text
Facebook Page comment
  │  Meta webhook (feed, item=comment, verb=add)
  ▼
Cloudflare Worker  facebook-feed-webhook.farkram.workers.dev
  │  1. verify X-Hub-Signature-256 (META_APP_SECRET), 401 otherwise
  │  2. drop non-comment / edit / Page-authored events
  │  3. INSERT comment ... ON CONFLICT DO NOTHING      (dedupe)
  │  4. resolve product: content mapping for this post/reel → else none
  │  5. POST /v1/chat/completions  ── Bearer HERMES_API_KEY ──┐
  │                                                           ▼
  │        Cloudflare Tunnel  hermes-feed.cloudnext.icu → localhost:8644
  │        Raspberry Pi: hermes-edge-proxy (127.0.0.1/::1:8644, allow-list)
  │                      → Hermes api_server 127.0.0.1:8642 (no tools)
  │                      ← {"choices":[{"message":{"content":"{...json...}"}}]}
  │  6. validate AI JSON deterministically (ai.js)
  │  7. compose reply = AI text [+ "\n" + trusted affiliate_url]  (affiliate.js)
  │  8. D1: comments/replies outcome
  ▼
DRY_RUN (default): stop — nothing is posted.
LIVE (explicit):   POST graph.facebook.com/{version}/{comment-id}/comments
                   ({comment-id} = the top-level comment; see replyTargetId)
```

The Meta request is acknowledged (`200 {"status":"accepted"}`) as soon as
the signature is verified and step 2 has filtered the events; steps 3–8 run
in `ctx.waitUntil()` *after* the response. The event is therefore not yet
durably recorded when Meta is acknowledged: if the Worker is evicted before
step 3, that event is lost (Meta does not redeliver after a 200).

## Why synchronous Hermes (`/v1/chat/completions`)

**Current contract:** `POST /v1/chat/completions` (Hermes `api_server`),
awaited in the same request. The paragraph below is **HISTORICAL / RETIRED**
background explaining why the webhook platform was abandoned; the Worker
does not use it.

Hermes' webhook platform (`POST /webhooks/{route}`) returns `202` *before*
the agent runs and only writes the answer to its log (`deliver: log`,
truncated to 200 chars); no identifier the Worker knows survives into any
completion callback. Its `api_server` platform awaits the agent and returns
`choices[0].message.content` on the same HTTP response — no correlation
problem exists. Evidence: `gateway/platforms/webhook.py:974–986`,
`gateway/platforms/api_server.py:5288, 5322, 5376, 5399` (Hermes v0.20.6).

The Hermes webhook platform still runs, but only on `127.0.0.1:8645`; the edge
proxy does **not** forward `/webhooks/*`, so it is not internet-reachable (its
agent runs with the webhook platform's default toolsets).

## Facebook Graph API findings (product / link data)

| Question | Finding |
|---|---|
| Product tags on a Page **post** readable? | **No.** The Page Post reference documents `attachments`, `message`, `message_tags`, `story_tags`, `call_to_action`, `permalink_url` — no field for tagged Shop products. |
| Product tags on a Page **reel/video**? | **No.** Meta's product-tagging API for reels is an **Instagram** Platform API, not Facebook Page video. |
| Link data readable? | Links in `message` / `attachments` of a Page post are readable with a Page access token, but they are arbitrary URLs, not a verified affiliate product. |
| Webhook comment payload | `from{id,name}`, `comment_id`, `post_id`, `parent_id`, `message`, `created_time`, `post{status_type, permalink_url, …}`. No product data. |
| Permissions | Read post: Page access token (`pages_read_engagement` / `pages_manage_posts`). Reply: Page token with the MODERATE task + `pages_manage_engagement`. |
| Graph version | Project uses `v21.0` (released 2024-10-02, available until **2027-01-21**). Configurable via `GRAPH_API_VERSION`. *Historical note:* when this table was written the newest version was v26.0; that has not been re-verified since and is **not** what production uses. |

No Page access token is configured (DRY_RUN), so post content was not
queried empirically; the decision below does not depend on it.

## Product link decision — Dashboard mapping (Option B)

Automatic extraction is not possible from documented APIs, and appending a
URL scraped from post text would let any link in a caption become a
"trusted" affiliate link. So:

1. **Content mapping (authoritative).** In the Dashboard, a post/reel id is
   mapped to one product. The Dashboard lists posts that have received
   comments but have no mapping yet, so ids never have to be looked up by
   hand. If the mapped product is inactive/deleted/invalid, the reply gets
   **no link** — it never falls back to another product.
2. **No mapping → no product, no link.** The AI may still answer in plain
   text. Comment keywords are **never** used to pick a product (the old
   keyword matcher `products.js` was removed in Phase 6): a matcher only sees
   the comment and the catalog, never what the post is about, so it could
   attach product B's link to a post about product A. A product's
   `keywords` field is only background context for the AI on a post that
   is already mapped to that product.

Invariant (tested in `tests/high-blockers.test.js`): every affiliate URL
that can reach Facebook comes from an active, non-deleted product that is
explicitly mapped to the current post/reel.

The AI never chooses, sees or writes a URL. It only sets
`include_affiliate_cta`. `affiliate.js` appends the URL from D1 after
validating it again (https, no credentials/whitespace, host allow-list).

## AI contract

System prompt: `facebook-feed-webhook/src/agent-prompt.js` (versioned with
the code). User message: one JSON object of **untrusted data**
(`comment_text`, `author_name`, `content_type`, `product{id,name,description,keywords}`,
`affiliate_link_available`) — never the URL, never the author id.

Output:

```json
{"action":"REPLY","reply_text":"ได้เลยครับ 👇 กดดูสินค้าได้ที่นี่ครับ","include_affiliate_cta":true}
{"action":"SKIP","reason":"not_relevant"}
```

Deterministic gate (`ai.js`, `affiliate.js`) — any failure ⇒ `SKIPPED`,
nothing posted:

- action ∉ {REPLY, SKIP}; missing/empty text; text > `MAX_REPLY_LENGTH` (300)
- any URL, domain-shaped token (any TLD or script, incl. IDN/punycode and
  dot look-alikes), link scheme, IP, e-mail or phone number in the AI text
- price / discount / promotion / free shipping / stock / warranty claims
- prompt or secret leakage ("system prompt", "instructions", "api key", …)
- CTA requested but no usable product (`CTA_WITHOUT_PRODUCT`)
- text promising a link while `include_affiliate_cta=false` (`CTA_TEXT_WITHOUT_LINK`)
- same author already received the same link on the same post in 24 h
  (`DUPLICATE_LINK_SUPPRESSED`, link-spam guard)

## Hermes security

- `api_server` bound to `127.0.0.1:8642`; webhook to `127.0.0.1:8645`; edge
  proxy to `127.0.0.1:8644` and `[::1]:8644`. Nothing listens on the LAN.
- Tunnel ingress unchanged (both hostnames → `localhost:8644`). No router
  port, no public IP.
- Edge proxy allow-list: `POST /v1/chat/completions` and `GET /health`
  only. Everything else → 404 at the proxy (sessions, jobs, runs, browser
  control, uploads and the retired `/webhooks/*` are not reachable from the
  internet).
- `API_SERVER_KEY` (64 hex chars) lives only in `~/.hermes/.env` (0600) and
  the Worker secret `HERMES_API_KEY`; Hermes refuses to start the API
  without a strong key and compares it in constant time.
- `platform_toolsets.api_server: []` — the comment agent has **no tools**
  (verified: `GET /v1/toolsets` → 27 toolsets, 0 enabled), so a malicious
  comment cannot reach terminal, browser, file or memory tools.
- `Idempotency-Key: fbc:<comment_id>` — Hermes returns the cached result for
  5 minutes instead of re-running the model.

## Facebook reply (LIVE only)

`POST https://graph.facebook.com/{GRAPH_API_VERSION}/{target}/comments`
with form field `message` and `Authorization: Bearer <PAGE_ACCESS_TOKEN>`
(never in the URL). `target` is the comment itself for a top-level comment,
or its top-level parent for a nested reply (Facebook threads are one level
deep). Requires a Page token of someone with the MODERATE task and the
`pages_manage_engagement` permission. Gates, all mandatory: `REPLY_MODE ===
"LIVE"` and token present (`config.js`), validated AI output, usable product
if a link is attached, no earlier LIVE send attempt for this comment
(`db.js hasLiveSendAttempt`: any LIVE reply row in `GENERATED`, `SENT` or
`FAILED` blocks; a read error blocks too), enough of the pipeline budget
left for the send (else `SEND_BUDGET_EXHAUSTED`), and a send-started row
(`GENERATED` + `GRAPH_SEND_IN_PROGRESS`) written **before** the request (if
it cannot be written, nothing is sent). `sendFacebookReply()` re-checks the
mode itself. Graph sends are never retried.

If finalizing the reply row in D1 fails after the Graph send attempt, the
row can remain `GENERATED` + `GRAPH_SEND_IN_PROGRESS`, so the actual
Facebook outcome cannot be established from that row alone. The Worker logs
`reply_outcome_unrecorded` (`D1_UPDATE_FAILED`, with `intended_status`) and
does not retry; `hasLiveSendAttempt` and the recovery protections prevent
another LIVE send. The comment status is written by a separate D1 update,
so in this case the comment status and the reply row status are not
guaranteed to represent the same final outcome (for example the comment can
be `REPLIED` while the reply row is still `GRAPH_SEND_IN_PROGRESS`).

Our own replies can come back as webhook events; see "Self-reply
protection" below.

## Self-reply protection (three layers)

A reply the Worker posts may come back from Meta as a new comment event (an
*echo*). Processing it would make the AI answer itself. Three independent
layers drop such events; none of them sends anything, and LIVE stays
separately gated (`REPLY_MODE === "LIVE"` + token + all LIVE gates).

| Layer | Where | Drops an event when | On lookup error |
|---|---|---|---|
| 1 | `index.js` → `facebook.js isSelfEvent` | `from.id` equals `PAGE_ID` (or `PAGE_ID` is unknown) | n/a (no lookup) |
| 2 | `pipeline.js isOwnReplyEventFailClosed` → `db.js isOwnReplyEvent` | its comment id or parent id equals a **stored** `replies.facebook_reply_id` | drop (fail closed) |
| 2.5 | `pipeline.js isPossibleOwnEchoFailClosed` → `db.js findUnattributedLiveAttemptInThread` (Phase 8.9) | it has **no author** (`from.id` absent/empty) **and** its thread received a LIVE send attempt whose reply id is unknown, within the echo-guard window | drop (fail closed) |

**Why layer 2.5 exists.** Layer 1 needs `from.id`; layer 2 needs the reply
id Graph returned. Three LIVE states leave `facebook_reply_id` NULL:
`GENERATED`+`GRAPH_SEND_IN_PROGRESS` (send started, outcome not yet recorded
— or recording failed), `GENERATED`+`GRAPH_OUTCOME_UNKNOWN:*` (timeout /
network / 5xx; the reply may exist) and `SENT`+`SENT_ID_UNPARSEABLE` (the
reply exists, its id was unreadable). An echo of such a reply that also
arrives without `from` would pass layers 1 and 2 and be answered again
(demonstrated by tests in Phases 8.6/8.7). Layer 2.5 closes that path.

**Scope (policy P1).** Only events with **no author** are ever examined.
An event with a real `from.id` is never suppressed by layer 2.5, even in a
thread that just received a LIVE send. A missing `from.id` on its own is not
treated as "self" — the event is dropped only when the thread condition
below also holds.

**Thread identity (deterministic ids only).** The thread is where a reply is
posted (`facebook.js replyTargetId`): the parent comment when the parent is
not the post itself (nested reply), otherwise the comment's own id
(top-level; parent = post or NULL). The stored side is derived the same way
from `comments.facebook_parent_id` / `facebook_post_id` /
`facebook_comment_id` in SQL. Matching is thread-level on purpose: a nested
customer reply N under T is answered **under T**, so its echo carries parent
T, not N — a comment-level match would miss it. The lookup is also scoped to
`comments.page_id`. **No message text, no similarity, no timestamps as
identity.**

**Window.** `ECHO_GUARD_WINDOW_SECONDS`, default **600 s**, inclusive on both
ends: `now − window ≤ replies.created_at ≤ now`. An attempt exactly 600 s old
still matches; 601 s does not; a row in the future does not. In production
`now` is D1's own `datetime('now')` — the same clock that wrote
`created_at` — so Worker/D1 clock skew cannot hide a fresh row. The value is
a policy default, not derived from measured echo timing (no such timing was
available; Phase 8.8.1).

**Placement.** After layer 2 and **before** `insertCommentIfNew`: a
suppressed event is never stored, never reaches Hermes, never reaches any
LIVE gate or Graph. Operator recovery (`recovery.js recoverComment`) runs the
same helper after its layer-2 check and refuses with `NOT_ELIGIBLE`.

**Evidence limits.** Production evidence could **not** verify the raw shape
of a real Page-reply echo (whether Meta includes `from.id`, and exactly
which comment `parent_id` points to): the Worker does not store raw
payloads, historical Workers Logs are not reachable through a documented
path, and production D1 held no LIVE rows (Phase 8.8.1). Nothing here
assumes Meta always sends or always omits `from.id`. The parent-id
assumption rests on the repository's one-level threading model
(`replyTargetId`).

No schema change: layer 2.5 reads existing `comments` + `replies` rows.

Link-spam guard: if the same author already received the same affiliate URL
on the same post in the last 24 h, the new reply is skipped
(`DUPLICATE_LINK_SUPPRESSED`). Two comments from one author processed at the
same instant can both pass this check; it is a spam limiter, not a hard
constraint.

## Idempotency and failure behaviour

| Risk | Control |
|---|---|
| Meta redelivers the same comment | `UNIQUE(facebook_comment_id)` + `ON CONFLICT DO NOTHING RETURNING id`; the loser logs `comment_duplicate` and stops before Hermes |
| Hermes timeout (model may still have run) | recorded `ERROR`; **no automatic retry** (avoids double billing / double reply) |
| Accidental re-request to Hermes | `Idempotency-Key` cache (5 min) |
| Double Facebook post | LIVE gate `hasLiveSendAttempt` (any LIVE `GENERATED`/`SENT`/`FAILED` row for the comment blocks a new send) + send-started row written before the Graph request + partial `UNIQUE INDEX replies(comment_id) WHERE status='SENT'`. (`db.js` still exports an older `hasSentReply` helper; the pipeline does not use it.) |
| Graph API failure | Never retried automatically, in any case. A confirmed Graph 4xx rejection (`GRAPH_REJECTED_<status>`) is recorded `FAILED` (confirmed not sent). A 5xx / other non-2xx status (`GRAPH_UNCERTAIN_<status>`), a timeout (`GRAPH_TIMEOUT`) or a network exception (`GRAPH_NETWORK_ERROR`) is ambiguous: recorded `GENERATED` + `GRAPH_OUTCOME_UNKNOWN:<category>`; the reply may already exist on Facebook |
| D1 cannot record the send outcome | The reply row can stay `GENERATED` + `GRAPH_SEND_IN_PROGRESS`; `reply_outcome_unrecorded` is logged. Never retried; `hasLiveSendAttempt` and recovery protections block another send |
| Echo of our own reply answered again | self-reply layers 1, 2 and 2.5 (see "Self-reply protection") |
| D1 unavailable at insert | model never invoked |

## Data model (D1 `tipsuselife-ai`)

Migrations are additive (`database/migrations`): `0001` initial, `0002`
comment metadata, `0003` affiliate catalog:

- `products` + `affiliate_url`, `platform`, `image_url`, `deleted_at`
  (soft delete). `shopee_url` kept in sync for backward compatibility.
- `content_mappings(facebook_page_id, facebook_post_id UNIQUE per page,
  facebook_content_type POST|REEL, product_id FK, active, note)`.
- `comments` + `facebook_post_permalink`, `product_source`
  (MAPPING|NONE; KEYWORD only on historical rows), `ai_action`.
- `replies` + `affiliate_url`; one `SENT` per comment enforced by index.

D1 has no row-level security. It is reachable only through the Worker's
`DB` binding; every Dashboard route is session-authenticated.

## Dashboard

Served by the same Worker at `/admin` (vanilla JS, no framework, strict
CSP, data rendered via `textContent` only). Screens: Overview, Products
(search, filter, create, edit, enable/disable, soft delete, test link),
Posts/Reels (mapping CRUD + unmapped posts), Comment Activity, Settings
(read-only; secret presence only). Auth: `ADMIN_PASSWORD` → HMAC-signed
HttpOnly `SameSite=Strict` cookie (24 h). Writes additionally require a
same-origin `Origin` and a JSON body. REPLY_MODE cannot be changed from the
Dashboard.

## Observability

Structured JSON logs (`log.js`) with ids and categories only. `logEvent`
writes `{event, …}`; `logError` writes `{event, error_category, …}`. Comment
text is truncated in logs; tokens, keys, signatures and authorization
headers are never logged (tested).

Normal path: `comment_received → product_resolved → reply_drafted |
ai_action_skip | ai_response_rejected | reply_composition_rejected |
hermes_call_failed`, and in LIVE `→ reply_sent | reply_send_failed |
reply_send_ambiguous`.

| Event | Source | Meaning / values |
|---|---|---|
| `event_ignored` | `index.js`, `pipeline.js` | Event dropped before processing. `reason`: `NOT_PAGE_EVENT`, `NO_ACTIONABLE_COMMENT`, `PAGE_ID_MISMATCH` (+`count`), `SELF_AUTHORED` (+`count`, layer 1), `OWN_REPLY_EVENT` (layer 2), `POSSIBLE_OWN_ECHO` (layer 2.5, +`thread_id`, `guard_state`), `POSSIBLE_OWN_ECHO_GUARD_ERROR` (layer 2.5 lookup failed, fail closed) |
| `comment_duplicate` | `pipeline.js` | Redelivery of an already stored comment; stops before Hermes |
| `hermes_busy_backoff` | `pipeline.js` | Hermes answered 429; `attempt`, `delay_ms` before the next bounded retry |
| `hermes_call_failed` | `pipeline.js` | `error_category`: `HERMES_*` (e.g. `HERMES_TIMEOUT`, `HERMES_BUSY`, `HERMES_HTTP_ERROR`, `HERMES_RESPONSE_NO_CHOICES`); comment → `ERROR` |
| `ai_response_rejected` / `reply_composition_rejected` | `pipeline.js` | `error_category` is the validator reason from `ai.js` / `affiliate.js`; recorded as `SKIPPED` |
| `live_gate_blocked` | `pipeline.js` (LIVE only) | `error_category`: `LIVE_SEND_ALREADY_ATTEMPTED_OR_UNKNOWN`, `PRODUCT_CONTEXT_INVALID`, `SEND_BUDGET_EXHAUSTED` (+`remaining_ms`), `SEND_MARKER_NOT_WRITTEN`; nothing is sent |
| `reply_sent` | `pipeline.js` (LIVE only) | Graph 2xx; `has_reply_id: false` means `SENT_ID_UNPARSEABLE` |
| `reply_send_failed` | `pipeline.js` (LIVE only) | Graph 4xx, `error_category` `GRAPH_REJECTED_<status>`; confirmed not sent |
| `reply_send_ambiguous` | `pipeline.js` (LIVE only) | Timeout / network / 5xx (`GRAPH_TIMEOUT`, `GRAPH_NETWORK_ERROR`, `GRAPH_UNCERTAIN_<status>`, or a non-Graph error category); the reply may exist on Facebook; never retried |
| `reply_outcome_unrecorded` | `pipeline.js` (LIVE only) | The send outcome could not be written (`D1_UPDATE_FAILED`, +`intended_status`); the row stays `GRAPH_SEND_IN_PROGRESS` |
| `comment_persist_failed`, `comment_result_update_failed`, `reply_persist_failed`, `product_lookup_failed` | `pipeline.js` | D1 failures (`D1_INSERT_FAILED` / `D1_UPDATE_FAILED` / `D1_SELECT_FAILED`) |
| `pipeline_unhandled` | `index.js` | Unexpected exception in background processing |
| `recovery_started`, `recovery_finished`, `recovery_failed` | `recovery.js` | Operator retry of one comment (`finished` carries `outcome`, `reason`); `admin_retry` / `admin_retry_failed` from `admin-api.js` record the request |
| `meta_signature_missing`, `meta_signature_invalid`, `meta_secret_missing`, `payload_parse_failed`, `webhook_verification_rejected`, `d1_binding_missing` | `index.js` | Request rejected before any processing |

Admin/dashboard events (`admin_*`) are emitted by `admin.js` / `admin-api.js`
for logins, rejected requests and product/mapping changes.

Suppressed events are never stored, so they are visible only in these
logs, not in `GET /admin/api/health`. There is no alerting; logs and the
health endpoint are read by an operator.
