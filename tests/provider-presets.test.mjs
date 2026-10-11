import test from "node:test";
import assert from "node:assert/strict";
import { providerPresets, resolveProvider } from "../web/provider-presets.js";

test("presets contain immutable documented endpoints and descriptive hints without model defaults", () => {
  assert.deepEqual(
    providerPresets.map((p) => [p.id, p.endpoint]),
    [
      ["openai", "https://api.openai.com/v1/chat/completions"],
      [
        "gemini",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      ],
      ["groq", "https://api.groq.com/openai/v1/chat/completions"],
      ["custom", ""],
    ],
  );
  assert.ok(Object.isFrozen(providerPresets));
  for (const p of providerPresets) {
    assert.ok(Object.isFrozen(p));
    assert.deepEqual(Object.keys(p), ["id", "label", "endpoint", "modelHint"]);
    assert.ok(p.modelHint.length > 20);
    assert.throws(() => {
      p.endpoint = "https://other.example/";
    }, TypeError);
  }
  assert.throws(() => providerPresets.push({}), TypeError);
});
test("explicit models are trimmed, endpoint overrides fail, results are detached", () => {
  for (const p of providerPresets.filter((p) => p.id !== "custom")) {
    const result = resolveProvider(p.id, { model: "  chosen-model  " });
    assert.deepEqual(result, { endpoint: p.endpoint, model: "chosen-model" });
    assert.deepEqual(
      resolveProvider(p.id, { endpoint: p.endpoint, model: " chosen-model " }),
      result,
    );
    result.endpoint = "modified";
    assert.equal(
      resolveProvider(p.id, { model: "chosen-model" }).endpoint,
      p.endpoint,
    );
    assert.throws(
      () =>
        resolveProvider(p.id, {
          model: "x",
          endpoint: "https://other.example/chat/completions",
        }),
      /cannot be overridden/,
    );
    assert.throws(() => resolveProvider(p.id), /model ID/);
  }
});
test("custom accepts complete HTTPS and explicit IPv4/IPv6/localhost loopback HTTP URLs", () => {
  for (const endpoint of [
    "https://provider.example/chat/completions",
    "http://localhost:8000/v1/chat/completions",
    "http://127.0.0.1:8000/v1/chat/completions",
    "http://127.3.4.5:8000/chat/completions",
    "http://[::1]:8000/v1/chat/completions",
  ])
    assert.deepEqual(
      resolveProvider("custom", {
        endpoint: " " + endpoint + " ",
        model: " local-model ",
      }),
      { endpoint, model: "local-model" },
    );
});
test("custom rejects credentials, query/fragment including empty delimiters, remote HTTP and malformed URLs", () => {
  for (const endpoint of [
    "",
    "/v1/chat/completions",
    "provider.example/v1/chat/completions",
    "https:provider.example/chat/completions",
    "https://user:pass@example.com/api",
    "https://example.com/api?",
    "https://example.com/api?key=x",
    "https://example.com/api#",
    "https://example.com/api#fragment",
    "http://example.com/api",
    "http://192.168.0.1/api",
    "http://localhost.example.com/api",
    "http://[::2]/api",
    "file:///tmp/model",
    "javascript:alert(1)",
    "https://bad host/api",
    "https://example.com\\api",
    "https://example.com/\napi",
  ])
    assert.throws(
      () => resolveProvider("custom", { endpoint, model: "x" }),
      undefined,
      endpoint,
    );
});
test("unknown IDs, missing or oversized models, unknown fields and nonplain options reject", () => {
  for (const id of ["OpenAI", "unknown", "", null, {}, "anthropic"])
    assert.throws(() => resolveProvider(id, { model: "x" }), /Unknown/);
  for (const model of ["", "   ", null, 12, "x\ny", "x\0y", "a".repeat(201)])
    assert.throws(() => resolveProvider("openai", { model }));
  for (const options of [
    null,
    [],
    new Date(),
    { model: "x", apiKey: "never-accepted" },
    { model: "x", [Symbol("extra")]: true },
    { model: "x", endpoint: 23 },
  ])
    assert.throws(() => resolveProvider("openai", options));
  let touched = false;
  const accessor = {};
  Object.defineProperty(accessor, "model", {
    enumerable: true,
    get() {
      touched = true;
      return "x";
    },
  });
  assert.throws(() => resolveProvider("openai", accessor));
  assert.equal(touched, false);
  assert.throws(() =>
    resolveProvider("custom", {
      model: "x",
      endpoint: "https://example.com/" + "a".repeat(2048),
    }),
  );
});
