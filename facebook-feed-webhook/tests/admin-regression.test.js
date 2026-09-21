/**
 * NEXT-02 regression guard.
 *
 * The admin route branch sits in front of the Meta webhook handling, so
 * these tests prove the pre-existing behaviour on every non-admin path
 * is byte-for-byte unchanged. They reuse the ORIGINAL webhook test
 * harness (tests/helpers.js), which was not modified by NEXT-02.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  TEST_VERIFY_TOKEN,
  createFakeD1,
  createEnv,
  createCtx,
  commentPayload,
  signedRequest,
  installFetchMock,
  jsonResponse,
} from "./helpers.js";
import { createAdminEnv } from "./admin-helpers.js";

function getRequest(params, path = "/webhook") {
  const url = new URL(`https://worker.example${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { method: "GET" });
}

/* ---------------------------------------------------------------- 32 */
test("32. Meta GET verification still works after the admin branch", async () => {
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

test("32b. Meta GET verification still rejects a bad token", async () => {
  const response = await worker.fetch(
    getRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong",
      "hub.challenge": "challenge-123",
    }),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 403);
});

test("32c. Meta verification works even with the admin secrets configured", async () => {
  const response = await worker.fetch(
    getRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": "unit-test-verify-token",
      "hub.challenge": "still-works",
    }),
    createAdminEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "still-works");
});

/* ---------------------------------------------------------------- 33 */
test("33. the signed Facebook webhook POST still processes normally", async () => {
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
    assert.equal((await response.json()).status, "accepted");
    assert.equal(db._state.comments.length, 1);
    assert.equal(db._state.replies[0].mode, "DRY_RUN");
    assert.equal(db._state.replies[0].facebook_reply_id, null);
    assert.equal(mock.graphCalls().length, 0, "still no Facebook mutation");
  } finally {
    mock.restore();
  }
});

test("33b. an invalid webhook signature is still rejected with 401", async () => {
  const response = await worker.fetch(
    await signedRequest(commentPayload(), { signature: "sha256=" + "0".repeat(64) }),
    createEnv({ DB: createFakeD1() }),
    createCtx()
  );

  assert.equal(response.status, 401);
});

/* ---------------------------------------------------------------- 34 */
test("34. unsupported methods on non-admin paths still return 405", async () => {
  for (const method of ["DELETE", "PUT", "PATCH"]) {
    const response = await worker.fetch(
      new Request("https://worker.example/webhook", { method }),
      createEnv(),
      createCtx()
    );

    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "GET, POST");
    assert.equal(await response.text(), "Method Not Allowed");
  }
});

test("34b. unknown /admin-prefixed paths fall through to the old behaviour", async () => {
  // Only the two exact admin paths are claimed; anything else keeps the
  // behaviour it had before NEXT-02.
  const getOther = await worker.fetch(
    new Request("https://worker.example/admin/unknown", { method: "GET" }),
    createEnv(),
    createCtx()
  );
  assert.equal(getOther.status, 403, "falls through to Meta verification");

  const deleteOther = await worker.fetch(
    new Request("https://worker.example/admin", { method: "DELETE" }),
    createEnv(),
    createCtx()
  );
  assert.equal(deleteOther.status, 405);
  assert.equal(deleteOther.headers.get("Allow"), "GET, POST");
});

test("34c. the admin routes do not require the webhook secrets, and vice versa", async () => {
  // An env with no admin secrets still serves the webhook; the admin
  // route just fails closed rather than breaking anything.
  const response = await worker.fetch(
    new Request("https://worker.example/admin/comments", { method: "GET" }),
    createEnv({ DB: createFakeD1() }),
    createCtx()
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: { code: "UNAUTHENTICATED", message: "Authentication required" },
  });
});
