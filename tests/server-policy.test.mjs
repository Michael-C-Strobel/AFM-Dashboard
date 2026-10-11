import test from "node:test";
import assert from "node:assert/strict";
import {
  modelOrigin,
  modelOrigins,
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

test("multiple exact origins are normalized deduplicated and retained in CSP", () => {
  assert.deepEqual(modelOrigins(), []);
  assert.deepEqual(modelOrigins("  "), []);
  const origins = modelOrigins(
    "https://api.example.com/, http://localhost:11434,https://API.example.com",
  );
  assert.deepEqual(origins, [
    "https://api.example.com",
    "http://localhost:11434",
  ]);
  assert.match(
    contentSecurityPolicy(origins),
    /connect-src 'self' https:\/\/api.example.com http:\/\/localhost:11434;/,
  );
  assert.equal(
    contentSecurityPolicy([...origins, origins[0]]),
    contentSecurityPolicy(origins),
  );
  assert.equal(contentSecurityPolicy([]), contentSecurityPolicy(null));
  assert.equal(contentSecurityPolicy(""), contentSecurityPolicy(null));
});
test("invalid list members reject the complete configuration without permitting injection", () => {
  for (const entry of [
    "http://example.com",
    "https://x.example/path",
    "https://x.example; script-src *",
    "https://user:secret@x.example",
    "https://x.example/?key=secret",
    "*",
  ]) {
    assert.throws(() => modelOrigins("https://valid.example," + entry));
    assert.throws(() =>
      contentSecurityPolicy(["https://valid.example", entry]),
    );
  }
  for (const input of [
    ",https://valid.example",
    "https://valid.example,",
    "https://valid.example,,https://other.example",
    null,
    [],
    {},
  ])
    assert.throws(() => modelOrigins(input));
  for (const input of [[null], [""], [{}], [1]])
    assert.throws(() => contentSecurityPolicy(input));
});
