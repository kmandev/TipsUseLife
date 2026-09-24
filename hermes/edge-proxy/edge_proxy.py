"""
Hermes edge proxy -- the only listener the Cloudflare Tunnel reaches.

Why it exists
-------------
The Cloudflare Tunnel's public hostnames (feed / hermes-feed.cloudnext.icu)
point at http://localhost:8644. Hermes' api_server exposes far more than the
Facebook agent needs (sessions, jobs, runs, browser control, artifact upload,
...). Publishing it directly would put all of that on the internet behind a
single bearer key.

This proxy binds 127.0.0.1:8644 and [::1]:8644 (never the LAN) and forwards
an explicit allow-list only:

    POST /v1/chat/completions   -> Hermes api_server  127.0.0.1:8642
    GET  /health                -> Hermes api_server  127.0.0.1:8642/health

The retired Hermes webhook route (/webhooks/*) is deliberately NOT
forwarded: the Worker no longer uses it, and its agent runs with the
webhook platform's default toolsets, so it must not be internet-reachable.

Everything else is a 404 answered here, without touching Hermes.

Authentication stays end-to-end: the proxy forwards the caller's
`Authorization: Bearer ...` header unchanged and Hermes validates it
(constant-time) -- the proxy never holds or logs the key. Only a fixed
set of request headers is forwarded; bodies are size-capped.

Runtime: the Hermes virtualenv's Python (aiohttp is already a Hermes
dependency). Installed as the systemd user unit hermes-edge-proxy.service.
"""

import asyncio
import logging
import os

from aiohttp import ClientSession, ClientTimeout, web

LISTEN_HOSTS = [h for h in os.environ.get("EDGE_LISTEN_HOSTS", "127.0.0.1,::1").split(",") if h]
LISTEN_PORT = int(os.environ.get("EDGE_LISTEN_PORT", "8644"))
API_UPSTREAM = os.environ.get("EDGE_API_UPSTREAM", "http://127.0.0.1:8642")

MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
UPSTREAM_TIMEOUT = ClientTimeout(total=float(os.environ.get("EDGE_TIMEOUT_SECONDS", "90")))

CHAT_HEADERS = ("authorization", "content-type", "idempotency-key")

log = logging.getLogger("hermes-edge-proxy")


def _json_error(status, code):
    return web.json_response({"error": {"code": code}}, status=status)


async def _forward(request, url, allowed_headers):
    body = await request.read()
    if len(body) > MAX_REQUEST_BYTES:
        return _json_error(413, "request_too_large")
    headers = {k: request.headers[k] for k in allowed_headers if k in request.headers}
    session: ClientSession = request.app["session"]
    try:
        async with session.request(request.method, url, data=body or None, headers=headers) as upstream:
            payload = await upstream.content.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                return _json_error(502, "upstream_response_too_large")
            content_type = upstream.headers.get("content-type", "application/json")
            out = web.Response(status=upstream.status, body=payload)
            out.headers["content-type"] = content_type
            if "retry-after" in upstream.headers:
                out.headers["retry-after"] = upstream.headers["retry-after"]
            return out
    except asyncio.TimeoutError:
        return _json_error(504, "upstream_timeout")
    except Exception:  # never echo upstream exception text
        log.warning("upstream request failed path=%s", request.path)
        return _json_error(502, "upstream_unavailable")


async def chat_completions(request):
    return await _forward(request, f"{API_UPSTREAM}/v1/chat/completions", CHAT_HEADERS)


async def health(request):
    return await _forward(request, f"{API_UPSTREAM}/health", ())


async def not_found(request):
    return _json_error(404, "not_found")


async def _on_startup(app):
    app["session"] = ClientSession(timeout=UPSTREAM_TIMEOUT, auto_decompress=True)


async def _on_cleanup(app):
    await app["session"].close()


def build_app():
    app = web.Application(client_max_size=MAX_REQUEST_BYTES)
    app.router.add_post("/v1/chat/completions", chat_completions)
    app.router.add_get("/health", health)
    app.router.add_route("*", "/{tail:.*}", not_found)
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    return app


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # access_log=None: request lines are not logged (they would include
    # client paths only, but there is nothing useful and no need to keep them).
    web.run_app(build_app(), host=LISTEN_HOSTS, port=LISTEN_PORT, access_log=None, print=None)


if __name__ == "__main__":
    main()
