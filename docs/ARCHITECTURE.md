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
  │  4. resolve product: content mapping → keyword → none   (trusted D1 data)
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
```

The Meta request is acknowledged (`200 {"status":"accepted"}`) as soon as
the signature is verified; steps 3–8 run in `ctx.waitUntil()`.

## Why synchronous Hermes (`/v1/chat/completions`)

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
| Graph version | Project uses `v21.0` (released 2024-10-02, available until **2027-01-21**). Configurable via `GRAPH_API_VERSION`; newest at time of writing is v26.0. |

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
2. **Keyword fallback.** Unmapped posts use the existing conservative
   matcher (`products.js`: name/keyword score, refuses ambiguity) over
   active products.
3. **None.** No link.

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
- any URL, bare domain, e-mail or phone number in the AI text
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
if a link is attached, comment not previously `SENT`, and
`sendFacebookReply()` re-checks the mode itself. Our own replies come back
as Page-authored webhook events and are dropped (self-loop protection).

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
| Double Facebook post | LIVE gate `hasSentReply` + partial `UNIQUE INDEX replies(comment_id) WHERE status='SENT'` |
| Graph API failure | recorded `FAILED`, never retried automatically |
| D1 unavailable at insert | model never invoked |

## Data model (D1 `tipsuselife-ai`)

Migrations are additive (`database/migrations`): `0001` initial, `0002`
comment metadata, `0003` affiliate catalog:

- `products` + `affiliate_url`, `platform`, `image_url`, `deleted_at`
  (soft delete). `shopee_url` kept in sync for backward compatibility.
- `content_mappings(facebook_page_id, facebook_post_id UNIQUE per page,
  facebook_content_type POST|REEL, product_id FK, active, note)`.
- `comments` + `facebook_post_permalink`, `product_source`
  (MAPPING|KEYWORD|NONE), `ai_action`.
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

Structured JSON logs (`log.js`) with ids and categories only:
`comment_received → product_resolved → reply_drafted | ai_action_skip |
ai_response_rejected | reply_composition_rejected | hermes_call_failed →
reply_sent | reply_send_failed`. Comment text is truncated in logs; tokens,
keys, signatures and authorization headers are never logged (tested).
