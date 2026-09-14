export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Meta Webhook Verification
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (
        mode === "subscribe" &&
        token &&
        challenge &&
        token === env.META_VERIFY_TOKEN
      ) {
        return new Response(challenge, {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        });
      }

      return new Response("Forbidden", { status: 403 });
    }

    // Only accept POST
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, POST",
        },
      });
    }

    // Read raw body exactly once
    const body = await request.text();

    // Verify Meta X-Hub-Signature-256
    const signature = request.headers.get("x-hub-signature-256");

    if (!signature || !signature.startsWith("sha256=")) {
      return new Response("Missing signature", { status: 401 });
    }

    const expected = await hmacSha256(env.META_APP_SECRET, body);
    const received = signature.slice("sha256=".length);

    if (!timingSafeEqual(expected, received)) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Parse Facebook payload
    let payload;

    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Debug: log the important parts of every Page feed event
    if (payload.object === "page" && Array.isArray(payload.entry)) {
      for (const entry of payload.entry) {
        for (const change of entry.changes || []) {
          console.log(
            JSON.stringify({
              DEBUG: "FACEBOOK_FEED_EVENT",
              entry_id: entry.id,
              field: change.field,
              item: change.value?.item,
              verb: change.value?.verb,
              comment_id: change.value?.comment_id,
              post_id: change.value?.post_id,
              parent_id: change.value?.parent_id,
              message: change.value?.message,
              from: change.value?.from,
              created_time: change.value?.created_time,
            })
          );
        }
      }
    }

    // Ignore non-Page events
    if (payload.object !== "page") {
      return json({
        status: "ignored",
        reason: "not_page_event",
      });
    }

    // Forward to Hermes
    const hermesUrl =
      "https://hermes-feed.cloudnext.icu/webhooks/facebook-comments";

    const hermesSignature = await hmacSha256(
      env.HERMES_SECRET,
      body
    );

    const response = await fetch(hermesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${hermesSignature}`,
      },
      body,
    });

    if (!response.ok) {
      return new Response("Hermes rejected webhook", {
        status: 502,
      });
    }

    return json({
      status: "accepted",
    });
  },
};

async function hmacSha256(secret, message) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message)
  );

  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}