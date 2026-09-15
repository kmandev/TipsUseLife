# Hermes Webhook Contract — `/webhooks/facebook-comments`

## What changed on the Worker side

| | Before | After |
|---|---|---|
| Body | raw Meta envelope (`{object, entry:[...]}`) | normalized single-comment event |
| Requests per delivery | 1 per webhook | 1 per actionable comment |
| Signature | HMAC-SHA256 over the raw Meta body | HMAC-SHA256 over the exact normalized body |
| Header | `X-Hub-Signature-256: sha256=<hex>` | **unchanged** |
| Secret | `HERMES_SECRET` | **unchanged** |
| URL | `https://hermes-feed.cloudnext.icu/webhooks/facebook-comments` | **unchanged** |

The signing scheme, secret and endpoint are untouched. Hermes-side HMAC
verification keeps working as-is, because it verifies over the received
bytes — which are now the normalized JSON.

## Request

```
POST /webhooks/facebook-comments
Content-Type: application/json
X-Hub-Signature-256: sha256=<hmac_sha256(HERMES_SECRET, raw_body)>
```

```json
{
  "source": "facebook",
  "event": "page_comment",
  "page_id": "853313081388711",
  "comment_id": "853313081388711_123456",
  "post_id": "853313081388711_999",
  "parent_id": null,
  "author_id": "1234567890",
  "author_name": "Somchai",
  "comment_text": "สนใจครับ",
  "created_time": "2026-09-15T04:00:00.000Z",
  "mode": "DRY_RUN",
  "product": null
}
```

Guarantees from the Worker:

- Meta's signature is already verified — Hermes only ever sees authentic events.
- `item === "comment"` and `verb === "add"` only. No posts, edits, removals, hides or reactions.
- Never an event authored by the Page itself (`author_id === page_id` is dropped).
- Never a duplicate: the comment row is inserted with `ON CONFLICT DO NOTHING RETURNING id` **before** this request is made, so a redelivered webhook never reaches Hermes a second time.
- `comment_text` is always a non-empty string.
- No secrets, tokens, signatures or Meta envelope fields are forwarded.

## Response

The agent's JSON (see `AGENT_PROMPT.md`). The Worker accepts it raw, as a
fenced block, embedded in prose, or wrapped in a
`{result|data|output|response|message}` envelope.

```json
{ "action": "REPLY", "reply_text": "...", "matched_product_id": null, "mode": "DRY_RUN" }
```

Any non-2xx response, a timeout over 25 s, or an unparseable body marks
the comment `ERROR` / `SKIPPED` in D1. **Nothing is ever posted to
Facebook as a result of a Hermes response** while `REPLY_MODE` is not
`LIVE`.

## Deploying this prompt (manual, on the Raspberry Pi)

1. Open the Hermes agent configuration for the `facebook-comments` webhook.
2. Replace its instructions with the SYSTEM PROMPT section of `AGENT_PROMPT.md`.
3. Ensure the agent returns the agent's raw output as the HTTP response body.
4. Restart / reload the gateway on port 8644.
5. Confirm the endpoint still answers on `https://hermes-feed.cloudnext.icu/webhooks/facebook-comments`.

Do **not** rotate `HERMES_SECRET` as part of this change.
