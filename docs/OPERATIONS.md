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
| `HERMES_TIMEOUT_MS` | var | `25000` (must stay below the 30 s `waitUntil` window) |
| `GRAPH_API_VERSION` | var | `v21.0` (available until 2027-01-21) |
| `MAX_REPLY_LENGTH` | var | `300` — max AI text length (link excluded) |
| `AFFILIATE_ALLOWED_HOSTS` | var, optional | comma list; default Shopee/Lazada/TikTok short-link hosts |
| `META_APP_SECRET` | secret | Meta webhook signature |
| `META_VERIFY_TOKEN` | secret | Meta subscription handshake |
| `HERMES_API_KEY` | secret | = `API_SERVER_KEY` in the Pi's `~/.hermes/.env` |
| `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` | secret | Dashboard login / session signing |
| `PAGE_ACCESS_TOKEN` | secret, **LIVE only** | Page token with `pages_manage_engagement`; absent = hard DRY_RUN lock |
| `HERMES_SECRET` | secret, legacy | only used by the retired webhook path; may be deleted later |

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
| Edge proxy | `systemctl --user disable --now hermes-edge-proxy`, then set webhook port back to 8644 and restart Hermes |
| D1 | migrations are additive; older Worker versions ignore the new columns/table |

## Routine operations

- New product: Dashboard → สินค้า Affiliate → เพิ่มสินค้า (https link on an
  allowed host; description is the only product truth the AI gets).
- New post/reel: after its first comment it appears under
  "โพสต์ที่มีคอมเมนต์แต่ยังไม่ผูกสินค้า" → ผูกสินค้า. Or paste its id.
- Product sold out / link dead: toggle it off — mapped posts stop getting a
  link immediately (replies degrade to text-only or SKIP).
- Graph API version: bump `GRAPH_API_VERSION` before 2027-01-21.
