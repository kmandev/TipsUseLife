# Design mocks (historical)

`TipsUseLife AI Dashboard.dc.html` (+ `support.js`) is the **original design
mock** for the admin dashboard, kept as a visual reference only. It is not
served by the Worker and is not the source of truth.

The live dashboard is `facebook-feed-webhook/dashboard/*`, bundled into
`facebook-feed-webhook/src/dashboard.js` and served at `/admin`.

Phase 6 updated the two config values the mock displays so they match
production (`HERMES_URL = …/v1/chat/completions`, `MAX_REPLY_LENGTH = 300`).
Any other copy or data in the mock may be out of date; architecture and
behaviour are documented in `docs/ARCHITECTURE.md` and `docs/OPERATIONS.md`.
In particular, affiliate products come **only** from a Post/Reel ↔ product
mapping; comment keywords never select a product.
