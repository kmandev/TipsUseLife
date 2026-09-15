import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { hmacSha256Hex } from "../src/crypto.js";
import {
  TEST_PAGE_ID,
  TEST_VERIFY_TOKEN,
  TEST_HERMES_SECRET,
  createFakeD1,
  createEnv,
  createCtx,
  commentPayload,
  signedRequest,
  installFetchMock,
  jsonResponse,
} from "./helpers.js";

function getRequest(params) {
  const url = new URL("https://worker.example/webhook");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { method: "GET" });
}

// ---------------------------------------------------------------- 1
test("GET webhook verification succeeds with the correct token", async () => {
  const response = await worker.fetch(
    getRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": TEST_VERIFY_TOKEN,
      "hub.challenge": "challenge-123",
    }),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "challenge-123");
});

// ---------------------------------------------------------------- 2
test("GET webhook verification fails with a wrong token", async () => {
  const response = await worker.fetch(
    getRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "challenge-123",
    }),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 403);
  assert.notEqual(await response.text(), "challenge-123");
});

test("GET verification fails when the verify token is not configured", async () => {
  const response = await worker.fetch(
    getRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": "",
      "hub.challenge": "c",
    }),
    createEnv({ META_VERIFY_TOKEN: undefined }),
    createCtx()
  );

  assert.equal(response.status, 403);
});

// ---------------------------------------------------------------- 3
test("invalid Meta signature is rejected with 401", async () => {
  const request = await signedRequest(commentPayload(), {
    signature: "sha256=" + "0".repeat(64),
  });

  const response = await worker.fetch(request, createEnv({ DB: createFakeD1() }), createCtx());
  assert.equal(response.status, 401);
});

test("missing Meta signature header is rejected with 401", async () => {
  const request = new Request("https://worker.example/webhook", {
    method: "POST",
    body: JSON.stringify(commentPayload()),
  });

  const response = await worker.fetch(request, createEnv({ DB: createFakeD1() }), createCtx());
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------- 4
test("valid Meta signature is accepted", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const mock = installFetchMock(() =>
    jsonResponse({ action: "REPLY", reply_text: "ขอบคุณครับ", mode: "DRY_RUN" })
  );

  try {
    const response = await worker.fetch(
      await signedRequest(commentPayload()),
      createEnv({ DB: db }),
      ctx
    );
    await ctx.settle();

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "accepted");
    assert.equal(body.mode, "DRY_RUN");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- 5
test("malformed JSON is rejected with 400", async () => {
  const request = await signedRequest("{not json");
  const response = await worker.fetch(request, createEnv({ DB: createFakeD1() }), createCtx());
  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------- 6
test("non-page event is ignored", async () => {
  const mock = installFetchMock(() => {
    throw new Error("must not be called");
  });

  try {
    const request = await signedRequest({ object: "instagram", entry: [] });
    const response = await worker.fetch(request, createEnv({ DB: createFakeD1() }), createCtx());

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ignored",
      reason: "not_page_event",
    });
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- 7
test("non-comment page event is ignored", async () => {
  const db = createFakeD1();
  const mock = installFetchMock(() => {
    throw new Error("must not be called");
  });

  try {
    const payload = commentPayload({ value: { item: "status", verb: "add" } });
    const response = await worker.fetch(
      await signedRequest(payload),
      createEnv({ DB: db }),
      createCtx()
    );

    const body = await response.json();
    assert.equal(body.status, "ignored");
    assert.equal(body.reason, "no_actionable_comment");
    assert.equal(db._state.comments.length, 0);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("comment edits and removals are ignored (verb is not 'add')", async () => {
  const db = createFakeD1();
  for (const verb of ["edited", "remove", "hide"]) {
    const response = await worker.fetch(
      await signedRequest(commentPayload({ value: { verb } })),
      createEnv({ DB: db }),
      createCtx()
    );
    const body = await response.json();
    assert.equal(body.status, "ignored", `verb=${verb}`);
  }
  assert.equal(db._state.comments.length, 0);
});

// ---------------------------------------------------------------- 8
test("valid comment event is persisted and drafted in DRY_RUN", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const mock = installFetchMock(() =>
    jsonResponse({
      action: "REPLY",
      reply_text: "ขอบคุณที่สนใจครับ 😊 เดี๋ยวทางเพจแนะนำรายละเอียดให้ครับ",
      matched_product_id: null,
      mode: "DRY_RUN",
    })
  );

  try {
    await worker.fetch(await signedRequest(commentPayload()), createEnv({ DB: db }), ctx);
    await ctx.settle();

    assert.equal(db._state.comments.length, 1);
    const comment = db._state.comments[0];
    assert.equal(comment.facebook_comment_id, "853313081388711_1001");
    assert.equal(comment.facebook_post_id, "853313081388711_900");
    assert.equal(comment.page_id, TEST_PAGE_ID);
    assert.equal(comment.author_id, "7777777777");
    assert.equal(comment.status, "PROCESSED");
    assert.ok(comment.ai_response.length > 0);

    assert.equal(db._state.replies.length, 1);
    const reply = db._state.replies[0];
    assert.equal(reply.mode, "DRY_RUN");
    assert.equal(reply.status, "GENERATED");
    assert.equal(reply.facebook_reply_id, null);
    assert.equal(reply.comment_id, comment.id);
  } finally {
    mock.restore();
  }
});

test("the payload forwarded to Hermes is normalized and correctly signed", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  let seen = null;

  const mock = installFetchMock((url, init) => {
    seen = { url, init };
    return jsonResponse({ action: "REPLY", reply_text: "ขอบคุณครับ", mode: "DRY_RUN" });
  });

  try {
    await worker.fetch(await signedRequest(commentPayload()), createEnv({ DB: db }), ctx);
    await ctx.settle();

    assert.ok(seen, "Hermes was called");
    const body = JSON.parse(seen.init.body);

    assert.deepEqual(Object.keys(body).sort(), [
      "author_id",
      "author_name",
      "comment_id",
      "comment_text",
      "created_time",
      "event",
      "mode",
      "page_id",
      "parent_id",
      "post_id",
      "product",
      "source",
    ]);
    assert.equal(body.source, "facebook");
    assert.equal(body.event, "page_comment");
    assert.equal(body.mode, "DRY_RUN");
    assert.equal(body.product, null);

    // No Meta envelope, no secrets leaked into the forwarded body.
    assert.equal(body.entry, undefined);
    assert.equal(body.object, undefined);
    assert.ok(!seen.init.body.includes(TEST_HERMES_SECRET));

    const expected = "sha256=" + (await hmacSha256Hex(TEST_HERMES_SECRET, seen.init.body));
    assert.equal(seen.init.headers["x-hub-signature-256"], expected);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- 9
test("duplicate comment delivery is deduplicated and never re-invokes the agent", async () => {
  const db = createFakeD1();
  const mock = installFetchMock(() =>
    jsonResponse({ action: "REPLY", reply_text: "ขอบคุณครับ", mode: "DRY_RUN" })
  );

  try {
    const ctx1 = createCtx();
    await worker.fetch(await signedRequest(commentPayload()), createEnv({ DB: db }), ctx1);
    await ctx1.settle();

    const hermesCallsAfterFirst = mock.calls.length;

    const ctx2 = createCtx();
    const response = await worker.fetch(
      await signedRequest(commentPayload()),
      createEnv({ DB: db }),
      ctx2
    );
    await ctx2.settle();

    assert.equal(response.status, 200);
    assert.equal(db._state.comments.length, 1, "no duplicate comment row");
    assert.equal(db._state.replies.length, 1, "no duplicate reply row");
    assert.equal(mock.calls.length, hermesCallsAfterFirst, "agent not called again");
  } finally {
    mock.restore();
  }
});

// --------------------------------------------------------------- 10
test("comment authored by our own Page is ignored (self-reply loop protection)", async () => {
  const db = createFakeD1();
  const mock = installFetchMock(() => {
    throw new Error("must not be called");
  });

  try {
    const payload = commentPayload({
      value: { from: { id: TEST_PAGE_ID, name: "TipsUseLife" } },
    });

    const response = await worker.fetch(
      await signedRequest(payload),
      createEnv({ DB: db }),
      createCtx()
    );

    assert.deepEqual(await response.json(), { status: "ignored", reason: "self_authored" });
    assert.equal(db._state.comments.length, 0);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

// --------------------------------------------------------------- 11
test("comment with a missing comment_id is ignored", async () => {
  const db = createFakeD1();
  const payload = commentPayload({ value: { comment_id: undefined } });

  const response = await worker.fetch(
    await signedRequest(payload),
    createEnv({ DB: db }),
    createCtx()
  );

  const body = await response.json();
  assert.equal(body.reason, "no_actionable_comment");
  assert.equal(db._state.comments.length, 0);
});

// --------------------------------------------------------------- 12
test("comment with a missing or blank message is ignored", async () => {
  const db = createFakeD1();

  for (const message of [undefined, "", "   "]) {
    const response = await worker.fetch(
      await signedRequest(commentPayload({ value: { message } })),
      createEnv({ DB: db }),
      createCtx()
    );
    const body = await response.json();
    assert.equal(body.reason, "no_actionable_comment");
  }

  assert.equal(db._state.comments.length, 0);
});

// --------------------------------------------------------------- extra
test("unsupported HTTP method returns 405", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/webhook", { method: "DELETE" }),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, POST");
});

test("missing D1 binding fails closed without invoking the agent", async () => {
  const mock = installFetchMock(() => {
    throw new Error("must not be called");
  });

  try {
    const response = await worker.fetch(
      await signedRequest(commentPayload()),
      createEnv({ DB: undefined }),
      createCtx()
    );

    assert.equal(response.status, 500);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});
