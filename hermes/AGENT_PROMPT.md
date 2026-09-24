# Agent prompt

The Facebook comment agent's instructions now live in the repository at
[`facebook-feed-webhook/src/agent-prompt.js`](../facebook-feed-webhook/src/agent-prompt.js)
and are sent as the `system` message of every `/v1/chat/completions`
request. Nothing has to be pasted into Hermes.

The former `facebook-comments` webhook subscription prompt on the Pi is no
longer used by the Worker; it only serves the legacy rollback path.

Output contract, validation rules and prompt-injection posture:
`docs/ARCHITECTURE.md` → "AI contract". Tests asserting the prompt's rules:
`facebook-feed-webhook/tests/affiliate-and-hermes.test.js`.
