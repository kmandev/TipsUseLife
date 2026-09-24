import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { resolveReplyMode, MODE_DRY_RUN, MODE_LIVE } from "../src/config.js";
import { sendFacebookReply, LiveModeViolationError } from "../src/facebook-reply.js";
import {
  TEST_META_SECRET,
  TEST_VERIFY_TOKEN,
  TEST_HERMES_API_KEY,
  createFakeD1,
  createEnv,
  createCtx,
  commentPayload,
  signedRequest,
  installFetchMock,
  hermesChat,
  captureConsole,
} from "./helpers.js";

// --------------------------------------------------------------- 17
test("DRY_RUN never calls the Facebook mutation API", async () => {
  const db = createFakeD1();
  const ctx = createCtx();

  const mock = installFetchMock((url) => {
    if (/graph\.facebook\.com/i.test(url)) {
      throw new Error("FACEBOOK MUTATION ATTEMPTED IN DRY_RUN");
    }
    return hermesChat({
      action: "REPLY",
      reply_text: "ขอบคุณที่สนใจครับ 😊",
      mode: "DRY_RUN",
    });
  });

  try {
    await worker.fetch(await signedRequest(commentPayload()), createEnv({ DB: db }), ctx);
    await ctx.settle();

    assert.equal(mock.graphCalls().length, 0, "no Graph API call was made");
    assert.equal(db._state.replies[0].mode, "DRY_RUN");
    assert.equal(db._state.replies[0].facebook_reply_id, null);
  } finally {
    mock.restore();
  }
});

test("DRY_RUN holds even when a PAGE_ACCESS_TOKEN is present", async () => {
  const db = createFakeD1();
  const ctx = createCtx();

  const mock = installFetchMock((url) => {
    if (/graph\.facebook\.com/i.test(url)) throw new Error("MUTATION ATTEMPTED");
    return hermesChat({ action: "REPLY", reply_text: "ขอบคุณครับ", mode: "DRY_RUN" });
  });

  try {
    await worker.fetch(
      await signedRequest(commentPayload()),
      createEnv({ DB: db, PAGE_ACCESS_TOKEN: "unit-test-token-value" }),
      ctx
    );
    await ctx.settle();

    assert.equal(mock.graphCalls().length, 0);
    assert.equal(db._state.replies[0].mode, "DRY_RUN");
  } finally {
    mock.restore();
  }
});

test("resolveReplyMode fails safe for every non-exact value", async () => {
  const token = { PAGE_ACCESS_TOKEN: "t" };

  for (const value of [
    undefined, null, "", " ", "live", "Live", "LIVE ", " LIVE", "live_mode",
    "TRUE", "1", "DRY_RUN", "dry_run", 0, 1, true,
  ]) {
    assert.equal(
      resolveReplyMode({ REPLY_MODE: value, ...token }),
      MODE_DRY_RUN,
      `REPLY_MODE=${JSON.stringify(value)} must resolve to DRY_RUN`
    );
  }

  // Exact "LIVE" without a token is still DRY_RUN.
  assert.equal(resolveReplyMode({ REPLY_MODE: "LIVE" }), MODE_DRY_RUN);
  assert.equal(resolveReplyMode({ REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "" }), MODE_DRY_RUN);

  // Only the exact opt-in with credentials enables LIVE.
  assert.equal(resolveReplyMode({ REPLY_MODE: "LIVE", PAGE_ACCESS_TOKEN: "t" }), MODE_LIVE);
});

test("an entirely empty env still resolves to DRY_RUN", () => {
  assert.equal(resolveReplyMode({}), MODE_DRY_RUN);
  assert.equal(resolveReplyMode(undefined), MODE_DRY_RUN);
});

test("sendFacebookReply refuses to run outside LIVE mode", async () => {
  const mock = installFetchMock(() => {
    throw new Error("must not reach the network");
  });

  try {
    for (const mode of [MODE_DRY_RUN, undefined, "live", "LIVE_MODE"]) {
      await assert.rejects(
        () =>
          sendFacebookReply(
            { commentId: "123", message: "hi" },
            { mode, accessToken: "t", graphApiVersion: "v21.0" }
          ),
        LiveModeViolationError
      );
    }
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("sendFacebookReply refuses LIVE mode without an access token", async () => {
  const mock = installFetchMock(() => {
    throw new Error("must not reach the network");
  });

  try {
    await assert.rejects(
      () => sendFacebookReply({ commentId: "1", message: "x" }, { mode: MODE_LIVE, accessToken: "" }),
      LiveModeViolationError
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

// --------------------------------------------------------------- 18
test("secrets never appear in logs", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const capture = captureConsole();

  const mock = installFetchMock(() =>
    hermesChat({ action: "REPLY", reply_text: "ขอบคุณครับ", mode: "DRY_RUN" })
  );

  try {
    await worker.fetch(
      await signedRequest(commentPayload()),
      createEnv({ DB: db, PAGE_ACCESS_TOKEN: "unit-test-page-access-token" }),
      ctx
    );
    await ctx.settle();

    // also exercise the rejection paths, which log the most
    await worker.fetch(
      await signedRequest(commentPayload(), { signature: "sha256=" + "0".repeat(64) }),
      createEnv({ DB: db }),
      createCtx()
    );
  } finally {
    mock.restore();
    capture.restore();
  }

  const logged = capture.text();
  assert.ok(logged.length > 0, "something was logged");

  for (const secret of [
    TEST_META_SECRET,
    TEST_VERIFY_TOKEN,
    TEST_HERMES_API_KEY,
    "unit-test-page-access-token",
  ]) {
    assert.ok(!logged.includes(secret), `secret leaked into logs: ${secret}`);
  }

  // No signature material either.
  assert.ok(!/sha256=[0-9a-f]{64}/.test(logged), "a signature was logged");
  assert.ok(!/authorization/i.test(logged), "an authorization header was logged");
});

test("comment text is truncated in logs rather than logged in full", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const longText = "ก".repeat(400) + "SECRET_TAIL_MARKER";
  const capture = captureConsole();

  const mock = installFetchMock(() =>
    hermesChat({ action: "REPLY", reply_text: "ขอบคุณครับ", mode: "DRY_RUN" })
  );

  try {
    await worker.fetch(
      await signedRequest(commentPayload({ value: { message: longText } })),
      createEnv({ DB: db }),
      ctx
    );
    await ctx.settle();
  } finally {
    mock.restore();
    capture.restore();
  }

  const logged = capture.text();
  assert.ok(!logged.includes("SECRET_TAIL_MARKER"), "full comment text was logged");
  // ...but the full text is still stored in the database.
  assert.equal(db._state.comments[0].comment_text, longText);
});

test("ai_response_rejected diagnostic metadata carries no content, only shape (NEXT-05)", async () => {
  const db = createFakeD1();
  const ctx = createCtx();
  const secretishText = "PRIVATE_UPSTREAM_FIELD_VALUE_MARKER";
  const capture = captureConsole();

  // An unrecognized, foreign-keyed envelope -- exactly the class of shape
  // this diagnostic logging exists to characterize without exposing it.
  const mock = installFetchMock(() =>
    hermesChat({ unexpected_upstream_field: secretishText, nested: { x: 1 } })
  );

  try {
    await worker.fetch(await signedRequest(commentPayload()), createEnv({ DB: db }), ctx);
    await ctx.settle();
  } finally {
    mock.restore();
    capture.restore();
  }

  const logged = capture.text();
  assert.ok(logged.includes("ai_response_rejected"), "rejection was logged");
  assert.ok(logged.includes("AI_RESPONSE_UNKNOWN_ACTION"));

  // Only structural metadata: the assistant content is a string.
  assert.ok(logged.includes('"raw_type":"string"'));
  assert.ok(logged.includes('"is_array":false'));

  // ...never the content itself, nor any nested value.
  assert.ok(!logged.includes(secretishText), "an upstream field VALUE leaked into logs");
  assert.ok(!logged.includes("unexpected_upstream_field"), "assistant content leaked into logs");
  assert.ok(!logged.includes('"x":1'), "a nested object's inner value was inlined into the log");
});
