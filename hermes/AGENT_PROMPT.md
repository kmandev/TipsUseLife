# Agent prompt

The Facebook comment agent's instructions now live in the repository at
[`facebook-feed-webhook/src/agent-prompt.js`](../facebook-feed-webhook/src/agent-prompt.js)
and are sent as the `system` message of every `/v1/chat/completions`
request. Nothing has to be pasted into Hermes.

**HISTORICAL / RETIRED:** the former `facebook-comments` webhook
subscription on the Pi is no longer used and is not reachable from the
internet. The current contract is `POST /v1/chat/completions`
(`hermes/HERMES_API_CONTRACT.md`).

Output contract, validation rules and prompt-injection posture:
`docs/ARCHITECTURE.md` → "AI contract". Tests asserting the prompt's rules:
`facebook-feed-webhook/tests/affiliate-and-hermes.test.js`.
