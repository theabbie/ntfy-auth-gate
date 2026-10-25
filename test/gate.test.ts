import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GateError, createGate } from "../src/index";
import { startFakeNtfy } from "./fakeNtfy";
import type { FakeNtfy } from "./fakeNtfy";

let ntfy: FakeNtfy;

beforeEach(async () => {
  ntfy = await startFakeNtfy();
});

afterEach(async () => {
  await ntfy.close();
});

const prompt = { title: "Approve", message: "please" };

describe("approve", () => {
  it("resolves approved when approve is tapped", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url });
    const decision = gate.approve(prompt);
    await ntfy.waitForPublished(1);
    await ntfy.tap(0, "Approve");
    assert.deepEqual(await decision, { approved: true, reason: "approved" });
    assert.equal(gate.pending, 0);
  });

  it("resolves denied when deny is tapped", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url });
    const decision = gate.approve(prompt);
    await ntfy.waitForPublished(1);
    await ntfy.tap(0, "Deny");
    assert.deepEqual(await decision, { approved: false, reason: "denied" });
  });

  it("resolves timeout when nobody answers", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url, timeoutMs: 150 });
    assert.deepEqual(await gate.approve(prompt), { approved: false, reason: "timeout" });
    assert.equal(gate.pending, 0);
  });

  it("resolves aborted when the signal fires", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url });
    const controller = new AbortController();
    const decision = gate.approve(prompt, controller.signal);
    await ntfy.waitForPublished(1);
    controller.abort();
    assert.deepEqual(await decision, { approved: false, reason: "aborted" });
    assert.equal(gate.pending, 0);
  });

  it("resolves aborted when the signal is already aborted", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url });
    const decision = await gate.approve(prompt, AbortSignal.abort());
    assert.deepEqual(decision, { approved: false, reason: "aborted" });
    assert.equal(gate.pending, 0);
  });

  it("ignores unrelated replies", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url });
    const decision = gate.approve(prompt);
    const published = await ntfy.waitForPublished(1);
    const [approve] = published.actions;
    await ntfy.post(approve!.url, "maybe");
    await ntfy.tap(0, "Approve");
    assert.equal((await decision).approved, true);
  });

  it("uses a unique response topic per request", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url });
    const first = gate.approve(prompt);
    const second = gate.approve(prompt);
    await ntfy.waitForPublished(2);
    const urls = ntfy.published.map((entry) => entry.actions[0]!.url);
    assert.notEqual(urls[0], urls[1]);
    assert.ok(urls.every((url) => url.startsWith(`${ntfy.url}/gatetest-`)));
    await ntfy.tap(0, "Approve");
    await ntfy.tap(1, "Deny");
    assert.equal((await first).approved, true);
    assert.equal((await second).approved, false);
  });

  it("does not let an answer to one request approve another", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url, timeoutMs: 300 });
    const first = gate.approve(prompt);
    const second = gate.approve(prompt);
    await ntfy.waitForPublished(2);
    await ntfy.tap(0, "Approve");
    assert.equal((await first).approved, true);
    assert.deepEqual(await second, { approved: false, reason: "timeout" });
  });

  it("rejects with tooManyPending past the limit", async () => {
    const gate = createGate({ topic: "gatetest", server: ntfy.url, maxPending: 1, timeoutMs: 300 });
    const first = gate.approve(prompt);
    await ntfy.waitForPublished(1);
    await assert.rejects(gate.approve(prompt), (error: unknown) => {
      return error instanceof GateError && error.code === "tooManyPending";
    });
    await first;
  });

  it("rejects with publishFailed when ntfy refuses the notification", async () => {
    ntfy.state.failPublish = true;
    const gate = createGate({ topic: "gatetest", server: ntfy.url });
    await assert.rejects(gate.approve(prompt), (error: unknown) => {
      return error instanceof GateError && error.code === "publishFailed";
    });
    assert.equal(gate.pending, 0);
  });

  it("rejects with subscribeFailed when the stream cannot open", async () => {
    ntfy.state.failSubscribe = true;
    const gate = createGate({ topic: "gatetest", server: ntfy.url });
    await assert.rejects(gate.approve(prompt), (error: unknown) => {
      return error instanceof GateError && error.code === "subscribeFailed";
    });
    assert.equal(ntfy.published.length, 0);
  });

  it("sends the bearer token and action headers", async () => {
    const gate = createGate({
      topic: "gatetest",
      server: ntfy.url,
      token: "secret",
      actionHeaders: { authorization: "Bearer writeonly" },
      priority: 5,
    });
    const decision = gate.approve(prompt);
    const published = await ntfy.waitForPublished(1);
    assert.equal(published.authorization, "Bearer secret");
    assert.equal(published.priority, 5);
    assert.deepEqual(published.actions[0]!.headers, { authorization: "Bearer writeonly" });
    assert.deepEqual(ntfy.subscribeAuthorizations, ["Bearer secret"]);
    await ntfy.tap(0, "Approve");
    await decision;
  });
});

describe("options", () => {
  it("rejects invalid topics", () => {
    assert.throws(() => createGate({ topic: "has space" }), TypeError);
    assert.throws(() => createGate({ topic: "" }), TypeError);
    assert.throws(() => createGate({ topic: "a".repeat(41) }), TypeError);
  });

  it("rejects invalid limits", () => {
    assert.throws(() => createGate({ topic: "ok", timeoutMs: 0 }), TypeError);
    assert.throws(() => createGate({ topic: "ok", maxPending: 0 }), TypeError);
  });

  it("rejects an invalid server url", () => {
    assert.throws(() => createGate({ topic: "ok", server: "not a url" }));
  });
});
