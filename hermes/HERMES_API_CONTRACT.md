# Hermes API Contract — Worker ↔ Hermes

Replaces the former `/webhooks/facebook-comments` contract. That endpoint
answers `202 Accepted` before the agent runs and can never return the
agent's answer to the caller, so the Worker no longer uses it (see
`docs/ARCHITECTURE.md`).

## Request

```
POST https://hermes-feed.cloudnext.icu/v1/chat/completions
Authorization: Bearer <HERMES_API_KEY>
Content-Type: application/json
Idempotency-Key: fbc:<facebook comment id>
```

```json
{
  "stream": false,
  "messages": [
    { "role": "system", "content": "<SYSTEM_PROMPT from src/agent-prompt.js>" },
    { "role": "user", "content": "{\"comment_text\":\"ขอพิกัดครับ\",\"author_name\":\"…\",\"content_type\":\"POST\",\"product\":{\"id\":1,\"name\":\"…\",\"description\":\"…\",\"keywords\":\"…\"},\"affiliate_link_available\":true}" }
  ]
}
```

The user message is untrusted **data** (JSON-encoded). It never contains an
affiliate URL, the author's id, tokens or the Meta envelope.

## Response (200)

```json
{ "object": "chat.completion",
  "choices": [ { "message": { "role": "assistant",
    "content": "{\"action\":\"REPLY\",\"reply_text\":\"ได้เลยครับ 👇 กดดูสินค้าได้ที่นี่ครับ\",\"include_affiliate_cta\":true}" } } ] }
```

`content` must be one JSON object: `REPLY` + `reply_text` +
`include_affiliate_cta`, or `SKIP` (+ optional `reason`). Fenced / embedded
JSON is tolerated; anything else is `SKIPPED` by the validator.

## Errors

| Hermes | Worker category | Outcome |
|---|---|---|
| 401/403 | `HERMES_UNAUTHORIZED` | `ERROR`, nothing posted |
| 429 | `HERMES_BUSY` | `ERROR` |
| other non-2xx | `HERMES_HTTP_ERROR` | `ERROR` |
| body not JSON / no `choices` / empty content | `HERMES_RESPONSE_*` | `ERROR` |
| `hermes.failed` or `completed:false` | `HERMES_RUN_INCOMPLETE` | `ERROR` |
| > `HERMES_TIMEOUT_MS` | `HERMES_TIMEOUT` | `ERROR`, no retry |

## Hermes-side requirements

`platforms.api_server.enabled: true` on `127.0.0.1:8642`,
`API_SERVER_KEY` set, `platform_toolsets.api_server: []`, reached only via
`hermes-edge-proxy` (`hermes/edge-proxy/`).
