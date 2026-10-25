import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";
import { createGate } from "../src/index";
import type { Gate } from "../src/index";
import { startFakeNtfy } from "./fakeNtfy";
import type { FakeNtfy } from "./fakeNtfy";

let ntfy: FakeNtfy;
let server: http.Server;
let base: string;

beforeEach(async () => {
  ntfy = await startFakeNtfy();
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await ntfy.close();
});

async function listen(handler: http.RequestListener): Promise<void> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const makeGate = (overrides: Partial<Parameters<typeof createGate>[0]> = {}): Gate =>
  createGate({ topic: "gatetest", server: ntfy.url, ...overrides });

describe("raw http wrap", () => {
  it("runs the handler after approval", async () => {
    const gate = makeGate();
    await listen(gate.wrap((_req, res) => void res.end("secret data")));
    const response = fetch(`${base}/thing?x=1`, { headers: { "user-agent": "curl/test" } });
    const published = await ntfy.waitForPublished(1);
    assert.match(published.message, /^GET \/thing\?x=1\nfrom .+\ncurl\/test$/);
    await ntfy.tap(0, "Approve");
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "secret data");
  });

  it("returns 403 when denied and never runs the handler", async () => {
    let ran = false;
    const gate = makeGate();
    await listen(
      gate.wrap((_req, res) => {
        ran = true;
        res.end("nope");
      }),
    );
    const response = fetch(base);
    await ntfy.waitForPublished(1);
    await ntfy.tap(0, "Deny");
    const result = await response;
    assert.equal(result.status, 403);
    assert.deepEqual(await result.json(), { error: "denied" });
    assert.equal(ran, false);
  });

  it("returns 408 on timeout", async () => {
    const gate = makeGate({ timeoutMs: 150 });
    await listen(gate.wrap((_req, res) => void res.end("nope")));
    const result = await fetch(base);
    assert.equal(result.status, 408);
    assert.deepEqual(await result.json(), { error: "timeout" });
  });

  it("returns 429 when too many approvals are pending", async () => {
    const gate = makeGate({ maxPending: 1, timeoutMs: 400 });
    await listen(gate.wrap((_req, res) => void res.end("ok")));
    const first = fetch(base);
    await ntfy.waitForPublished(1);
    const second = await fetch(base);
    assert.equal(second.status, 429);
    assert.equal((await first).status, 408);
  });

  it("fails closed with 502 when ntfy is down", async () => {
    ntfy.state.failPublish = true;
    const gate = makeGate();
    await listen(gate.wrap((_req, res) => void res.end("nope")));
    const result = await fetch(base);
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: "unavailable" });
  });

  it("stops waiting when the client disconnects", async () => {
    const gate = makeGate();
    await listen(gate.wrap((_req, res) => void res.end("nope")));
    const controller = new AbortController();
    const request = fetch(base, { signal: controller.signal }).catch(() => undefined);
    await ntfy.waitForPublished(1);
    assert.equal(gate.pending, 1);
    controller.abort();
    await request;
    const deadline = Date.now() + 2000;
    while (gate.pending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(gate.pending, 0);
  });
});

describe("express", () => {
  it("guards only the mounted route", async () => {
    const gate = makeGate();
    const app = express();
    app.get("/open", (_req, res) => void res.send("open"));
    app.get("/token", gate.middleware, (_req, res) => void res.json({ token: "abc" }));
    await listen(app);

    assert.equal(await (await fetch(`${base}/open`)).text(), "open");
    assert.equal(ntfy.published.length, 0);

    const response = fetch(`${base}/token`);
    const published = await ntfy.waitForPublished(1);
    assert.match(published.message, /^GET \/token/);
    await ntfy.tap(0, "Approve");
    const result = await response;
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { token: "abc" });
  });

  it("reports the original url when mounted under a prefix", async () => {
    const gate = makeGate();
    const app = express();
    const router = express.Router();
    router.get("/inner", gate.middleware, (_req, res) => void res.send("ok"));
    app.use("/api", router);
    await listen(app);

    const response = fetch(`${base}/api/inner`);
    const published = await ntfy.waitForPublished(1);
    assert.match(published.message, /^GET \/api\/inner/);
    await ntfy.tap(0, "Deny");
    assert.equal((await response).status, 403);
  });

  it("uses a custom describe function", async () => {
    const gate = makeGate({
      describe: (subject) => ({ title: "custom", message: `${subject.method} ${subject.url}!` }),
    });
    const app = express();
    app.get("/x", gate.middleware, (_req, res) => void res.send("ok"));
    await listen(app);

    const response = fetch(`${base}/x`);
    const published = await ntfy.waitForPublished(1);
    assert.equal(published.title, "custom");
    assert.equal(published.message, "GET /x!");
    await ntfy.tap(0, "Approve");
    assert.equal((await response).status, 200);
  });
});

describe("notification content", () => {
  it("flattens newlines and truncates long input", async () => {
    const gate = makeGate({ timeoutMs: 100 });
    await listen(gate.wrap((_req, res) => void res.end("x")));
    const longPath = `/a%0Ab${"c".repeat(400)}`;
    const request = fetch(`${base}${longPath}`, { headers: { "user-agent": "agent" } });
    const published = await ntfy.waitForPublished(1);
    assert.equal(published.message.split("\n").length, 3);
    assert.ok(published.message.split("\n")[0]!.length < 240);
    await request;
  });
});

describe("guardFetch", () => {
  it("runs the handler after approval and forwards extra arguments", async () => {
    const gate = makeGate();
    const guarded = gate.guardFetch(
      (request: Request, env: { name: string }) => new Response(`${env.name} ${new URL(request.url).pathname}`),
    );
    const response = guarded(new Request("http://example.test/hello", { headers: { "user-agent": "ua" } }), {
      name: "worker",
    });
    const published = await ntfy.waitForPublished(1);
    assert.equal(published.message, "GET /hello\nua");
    await ntfy.tap(0, "Approve");
    const result = await response;
    assert.equal(await result.text(), "worker /hello");
  });

  it("returns 403 when denied", async () => {
    const gate = makeGate();
    const guarded = gate.guardFetch(() => new Response("nope"));
    const response = guarded(new Request("http://example.test/"));
    await ntfy.waitForPublished(1);
    await ntfy.tap(0, "Deny");
    const result = await response;
    assert.equal(result.status, 403);
    assert.deepEqual(await result.json(), { error: "denied" });
  });

  it("returns 408 on timeout", async () => {
    const gate = makeGate({ timeoutMs: 100 });
    const guarded = gate.guardFetch(() => new Response("nope"));
    const result = await guarded(new Request("http://example.test/"));
    assert.equal(result.status, 408);
  });

  it("returns 502 when ntfy is down", async () => {
    ntfy.state.failPublish = true;
    const gate = makeGate();
    const guarded = gate.guardFetch(() => new Response("nope"));
    const result = await guarded(new Request("http://example.test/"));
    assert.equal(result.status, 502);
  });
});
