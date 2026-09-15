# Deployment Runbook — TipsUseLife Facebook Comment AI

All commands run **on the Raspberry Pi**, where the Cloudflare credentials
live. The Mac is source + git only.

Working directory for every command below:

```bash
cd ~/TipsUseLife/facebook-feed-webhook   # adjust to the Pi's checkout path
```

---

## 0. Get the code

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
npm install
```

## 1. Run the tests (no network or credentials needed)

```bash
npm test
```

Expected: `pass 46`, `fail 0`.

## 2. Inspect the remote D1 **before** touching it

Never assume the state of the database.

```bash
npx wrangler d1 execute tipsuselife-ai --remote \
  --command "SELECT type, name FROM sqlite_master ORDER BY type, name;"
```

Then decide from what you see:

### Case A — the database is empty (no `comments` table)

Neither migration has run. Apply both through wrangler's migration tracker:

```bash
npx wrangler d1 migrations list tipsuselife-ai --remote
npx wrangler d1 migrations apply tipsuselife-ai --remote
```

### Case B — `0001` tables exist, but `d1_migrations` does not

0001 was applied by hand, so wrangler does not know about it. Running
`migrations apply` now would try to re-create existing tables and fail.
Register 0001 as already-applied, then apply 0002 only:

```bash
npx wrangler d1 execute tipsuselife-ai --remote --command \
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);"

npx wrangler d1 execute tipsuselife-ai --remote --command \
  "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql');"

npx wrangler d1 migrations apply tipsuselife-ai --remote
```

### Case C — the tables exist and `d1_migrations` already lists `0001`

```bash
npx wrangler d1 migrations apply tipsuselife-ai --remote
```

### Case D — the schema differs from `0001_initial.sql`

**Stop.** Do not run anything destructive. Report the actual schema and
write an additive `0003` migration instead.

> `0002_comment_metadata.sql` is additive only: two `ALTER TABLE ... ADD
> COLUMN` statements and two `CREATE INDEX IF NOT EXISTS`. It contains no
> `DROP` and rewrites no data.

### Verify the schema afterwards

```bash
npx wrangler d1 execute tipsuselife-ai --remote \
  --command "PRAGMA table_info(comments);"
```

`facebook_parent_id` and `facebook_created_time` must be present.

## 3. Set the secrets (interactive — values are never typed on a command line)

```bash
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put HERMES_SECRET
```

`META_VERIFY_TOKEN` must match what the Meta app dashboard has.
`HERMES_SECRET` must match the Hermes gateway's — **do not rotate it.**

Do **not** set `PAGE_ACCESS_TOKEN`. It is not needed for DRY_RUN, and its
absence is a second lock on live replies.

Confirm the names (values are never displayed):

```bash
npx wrangler secret list
```

## 4. Validate the config without deploying

```bash
npx wrangler deploy --dry-run --outdir /tmp/fbwh-dryrun
```

Check the printed bindings: `DB` (tipsuselife-ai) and the vars, with
`REPLY_MODE = DRY_RUN`.

## 5. Deploy

```bash
npx wrangler deploy
```

## 6. Verify the deployment

Webhook handshake (replace `<VERIFY_TOKEN>` — do not paste it into chat or logs):

```bash
curl -s "https://facebook-feed-webhook.farkram.workers.dev/?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=ping123"
# expected: ping123
```

Unsigned POST must be rejected:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://facebook-feed-webhook.farkram.workers.dev/ \
  -H 'content-type: application/json' -d '{}'
# expected: 401
```

Tail the logs in a second terminal for the end-to-end test:

```bash
npx wrangler tail --format pretty
```

## 7. Update the Hermes agent

Apply `hermes/AGENT_PROMPT.md` to the `facebook-comments` agent and
reload the gateway on port 8644. See `hermes/WEBHOOK_CONTRACT.md` for
what the request body now looks like.

## 8. Real end-to-end DRY-RUN test

1. Post a comment on a TipsUseLife post **from a personal account**, not
   as the Page (a Page-authored comment is dropped by design).
   Suggested text: `สนใจครับ`
2. Watch `wrangler tail` for `comment_received` then `reply_drafted`.
3. Check the database:

```bash
npx wrangler d1 execute tipsuselife-ai --remote --command \
  "SELECT id, facebook_comment_id, status, matched_product_id, substr(ai_response,1,60) AS draft FROM comments ORDER BY id DESC LIMIT 5;"

npx wrangler d1 execute tipsuselife-ai --remote --command \
  "SELECT id, comment_id, mode, status, facebook_reply_id, substr(response_text,1,60) AS draft FROM replies ORDER BY id DESC LIMIT 5;"
```

**Pass criteria**

| Check | Expected |
|---|---|
| `comments.status` | `PROCESSED` (or `SKIPPED` if the agent's draft was rejected) |
| `replies.mode` | `DRY_RUN` |
| `replies.status` | `GENERATED` |
| `replies.facebook_reply_id` | `NULL` |
| The Facebook post | **no automated reply appears** |

4. Post the *same* comment text again as a new comment to confirm a new
   row appears (different comment id), then confirm from `wrangler tail`
   that any Meta redelivery of the *same* comment id logs
   `comment_duplicate` and creates no second reply row.

**If a reply ever appears on Facebook, stop immediately**, set
`REPLY_MODE` back to `DRY_RUN` (it should already be), redeploy, and
investigate — that would mean a guard was bypassed.

---

## Enabling LIVE mode later (not part of this task)

Requires all of:

1. `npx wrangler secret put PAGE_ACCESS_TOKEN`
2. `REPLY_MODE` changed to exactly `LIVE` in `wrangler.jsonc`
3. Redeploy
4. Meta app permissions reviewed for `pages_manage_engagement`

Any one of these missing keeps the system in DRY_RUN.
