import test from "node:test";
import assert from "node:assert/strict";
import {
  modelOrigin,
  contentSecurityPolicy,
} from "../scripts/server-policy.mjs";
test("demo stays local-only unless one exact provider origin is configured", () => {
  assert.equal(modelOrigin(), null);
  assert.match(contentSecurityPolicy(), /connect-src 'self';/);
  for (const origin of [
    "https://api.example.com",
    "http://127.0.0.1:11434",
    "http://localhost:8080",
    "http://[::1]:8080",
  ])
    assert.ok(
      contentSecurityPolicy(origin).includes(
        "connect-src 'self' " + origin + ";",
      ),
    );
  assert.equal(
    modelOrigin("https://api.example.com/"),
    "https://api.example.com",
  );
});
test("provider origin rejects credentials, arbitrary HTTP, paths and CSP injection", () => {
  for (const input of [
    "https:",
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/v1",
    "https://example.com/?key=secret",
    "https://example.com/#key",
    "https://example.com; connect-src *",
    "*",
    "data:text/html,test",
    "file:///tmp",
    "http://127.0.0.2:80",
  ])
    assert.throws(() => modelOrigin(input), /AFM_MODEL_ORIGIN/);
});
