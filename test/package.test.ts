import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

describe("built package", () => {
  it("loads as commonjs", () => {
    const require = createRequire(import.meta.url);
    const mod = require("../dist/index.cjs");
    assert.equal(typeof mod.createGate, "function");
    assert.equal(typeof mod.GateError, "function");
    const gate = mod.createGate({ topic: "pkgtest" });
    assert.equal(typeof gate.middleware, "function");
  });

  it("loads as esm", async () => {
    const mod = await import("../dist/index.js");
    assert.equal(typeof mod.createGate, "function");
    const gate = mod.createGate({ topic: "pkgtest" });
    assert.equal(typeof gate.wrap, "function");
    assert.equal(typeof gate.guardFetch, "function");
  });
});
