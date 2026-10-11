import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createToolSession } from "../web/tool-session.js";
import { TOOL_VERSION } from "../web/tool-contracts.js";

const call = () => ({ name: "list_sources", arguments: {} });
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const digest = (value) =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");
const clock = () => {
  let i = 0;
  return () => `2026-10-11T00:00:${String(i++).padStart(2, "0")}.000Z`;
};
const session = (options = {}) =>
  createToolSession({
    invoke: async () => ({ files: [] }),
    now: clock(),
    ...options,
  });

test("canonical artifact hashes and journal chain independently verify and reveal tampering", async () => {
  const s = session({ invoke: async () => ({ z: "µm", a: [2, 1] }) });
  const first = await s.execute(call()),
    second = await s.execute(call());
  assert.equal(first.artifact.content.tool_version, TOOL_VERSION);
  assert.equal(first.artifact.sha256, digest(first.artifact.content));
  assert.equal(first.artifact.id, "artifact:" + first.artifact.sha256);
  assert.equal(second.artifact.id, first.artifact.id);
  let previous = null;
  for (const r of s.journal().records) {
    const { sha256, ...unsigned } = r;
    assert.equal(r.previous_sha256, previous);
    assert.equal(sha256, digest(unsigned));
    previous = sha256;
  }
  assert.equal(s.journal().head_sha256, previous);
  const changed = structuredClone(first.artifact.content);
  changed.result.a.reverse();
  assert.notEqual(digest(changed), first.artifact.sha256);
  const { sha256, ...changedRecord } = first.record;
  changedRecord.finished_at = "modified";
  assert.notEqual(digest(changedRecord), sha256);
});
test("artifact content deduplicates across timestamps and object key insertion order", async () => {
  let n = 0;
  const s = session({
    invoke: async () => (++n === 1 ? { a: 1, z: 2 } : { z: 2, a: 1 }),
  });
  const a = await s.execute(call()),
    b = await s.execute(call());
  assert.notEqual(a.record.started_at, b.record.started_at);
  assert.equal(a.artifact.id, b.artifact.id);
  assert.equal(s.journal().artifact_count, 1);
  assert.equal(
    s.journal().artifact_bytes,
    Buffer.byteLength(canonical(a.artifact.content), "utf8"),
  );
});
test("concurrent calls are serialized, with unique ordered journal sequence numbers", async () => {
  let release;
  const barrier = new Promise((resolve) => {
      release = resolve;
    }),
    started = [];
  const s = session({
    invoke: async (name, args) => {
      started.push(args.file);
      if (args.file === "first.gwy") await barrier;
      return { file: args.file };
    },
  });
  const first = s.execute({
    name: "inspect_source",
    arguments: { file: "first.gwy" },
  });
  const second = s.execute({
    name: "inspect_source",
    arguments: { file: "second.gwy" },
  });
  await Promise.resolve();
  assert.deepEqual(started, ["first.gwy"]);
  assert.equal(s.journal().records.length, 0);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(started, ["first.gwy", "second.gwy"]);
  assert.deepEqual(
    results.map((x) => x.record.sequence),
    [1, 2],
  );
});
test("invalid calls log generic failures without argument or credential retention", async () => {
  let invoked = 0;
  const s = session({
    invoke: async () => {
      invoked++;
      return {};
    },
  });
  const result = await s.execute({
    name: "list_sources",
    arguments: { api_key: "do-not-retain" },
  });
  assert.equal(result.record.status, "failed");
  assert.equal(result.artifact, null);
  assert.deepEqual(result.record.call, {
    name: "list_sources",
    arguments: null,
  });
  assert.equal(result.record.error, "Invalid tool call");
  assert.equal(invoked, 0);
  const unknown = await s.execute({
    name: "arbitrary-secret-name",
    arguments: { password: "hidden" },
  });
  assert.equal(unknown.record.call.name, "invalid");
  assert.doesNotMatch(
    JSON.stringify(s.journal()),
    /do-not-retain|arbitrary-secret-name|hidden|api_key|password/,
  );
  assert.equal((await s.execute(call())).record.status, "succeeded");
});
test("invocation errors are journaled without artifacts and do not poison subsequent calls", async () => {
  let n = 0;
  const s = session({
    invoke: async () => {
      if (++n === 1) throw new Error("Source unavailable");
      return { ok: true };
    },
  });
  const a = await s.execute(call()),
    b = await s.execute(call());
  assert.equal(a.record.error, "Source unavailable");
  assert.equal(a.artifact, null);
  assert.equal(b.record.status, "succeeded");
  assert.equal(s.journal().artifact_count, 1);
});
test("journal, execute results, input calls and artifact retrieval are detached", async () => {
  const backendResult = { nested: { ok: true } };
  const s = session({
    invoke: async (name, args) => {
      args.file = "mutated";
      return backendResult;
    },
  });
  const input = { name: "inspect_source", arguments: { file: "original.gwy" } };
  const promise = s.execute(input);
  input.arguments.file = "caller-change";
  const result = await promise,
    id = result.artifact.id;
  backendResult.nested.ok = false;
  assert.equal(result.record.call.arguments.file, "original.gwy");
  assert.equal(s.artifact(id).content.result.nested.ok, true);
  result.artifact.content.result.nested.ok = false;
  result.record.call.arguments.file = "tamper";
  const copy = s.artifact(id);
  copy.content.result.nested.ok = false;
  const journal = s.journal();
  journal.records.length = 0;
  journal.head_sha256 = "bad";
  assert.equal(s.artifact(id).content.result.nested.ok, true);
  assert.equal(s.journal().records[0].call.arguments.file, "original.gwy");
  assert.throws(() => s.artifact("missing"), /not found/);
});
test("get_artifact is handled internally and produces its own auditable result", async () => {
  let invocations = 0;
  const s = session({
    invoke: async () => {
      invocations++;
      return { files: [] };
    },
  });
  const first = await s.execute(call());
  const second = await s.execute({
    name: "get_artifact",
    arguments: { artifact_id: first.artifact.id },
  });
  assert.equal(invocations, 1);
  assert.equal(second.record.status, "succeeded");
  assert.deepEqual(second.artifact.content.result, first.artifact);
  const missing = await s.execute({
    name: "get_artifact",
    arguments: { artifact_id: "artifact:" + "0".repeat(64) },
  });
  assert.equal(missing.record.status, "failed");
  assert.match(missing.record.error, /not found/);
  assert.equal(invocations, 1);
});
test("maxCalls includes queued calls and validation failures with no automatic pruning", async () => {
  const s = session({ maxCalls: 2 });
  const first = s.execute({ name: "bad", arguments: {} }),
    second = s.execute(call());
  assert.throws(() => s.execute(call()), /call budget/);
  await Promise.all([first, second]);
  assert.equal(s.journal().records.length, 2);
  assert.throws(() => s.execute(call()), /call budget/);
});
test("artifact budget measures canonical UTF-8 bytes, deduplicates, and logs capacity failures", async () => {
  const probe = session({ invoke: async () => ({ text: "🙂" }) });
  const result = await probe.execute(call());
  const bytes = probe.journal().artifact_bytes;
  assert.equal(
    bytes,
    Buffer.byteLength(canonical(result.artifact.content), "utf8"),
  );
  let n = 0;
  const s = session({
    maxArtifactBytes: bytes,
    invoke: async () => ({
      text: ++n === 2 ? "extra-large-content-to-exceed-the-budget" : "🙂",
    }),
  });
  const a = await s.execute(call()),
    b = await s.execute(call()),
    c = await s.execute(call());
  assert.equal(a.record.status, "succeeded");
  assert.equal(b.record.status, "failed");
  assert.equal(b.artifact, null);
  assert.match(b.record.error, /byte budget/);
  assert.equal(c.artifact.id, a.artifact.id);
  assert.equal(s.journal().artifact_count, 1);
  assert.equal(s.journal().artifact_bytes, bytes);
  const zero = session({ maxArtifactBytes: 0 });
  assert.equal((await zero.execute(call())).record.status, "failed");
  assert.equal(zero.journal().artifact_count, 0);
});
test("backend results reject non-JSON values, unsafe descriptors, credential fields and excessive nesting", async () => {
  const cycle = {};
  cycle.self = cycle;
  let deep = 0;
  for (let i = 0; i < 65; i++) deep = { child: deep };
  let getterCalls = 0;
  const getter = {
    get secretValue() {
      getterCalls++;
      return 1;
    },
  };
  const symbol = { [Symbol("hidden")]: 1 };
  const sparse = new Array(2);
  const expanded = [];
  expanded.extra = 1;
  const bad = [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    new Uint8Array([1]),
    new Date(),
    new Map(),
    cycle,
    deep,
    getter,
    symbol,
    sparse,
    expanded,
    { api_key: "secret-value" },
  ];
  const s = session({ invoke: async () => bad.shift() });
  const length = bad.length;
  for (let i = 0; i < length; i++) {
    const r = await s.execute(call());
    assert.equal(r.record.status, "failed");
    assert.equal(r.artifact, null);
  }
  assert.equal(getterCalls, 0);
  assert.equal(s.journal().artifact_count, 0);
  assert.doesNotMatch(JSON.stringify(s.journal()), /secret-value/);
});
test("depth limit accepts 64 nested objects and rejects 65 without counting artifact envelopes", async () => {
  let allowed = 0;
  for (let i = 0; i < 64; i++) allowed = { child: allowed };
  const s = session({ invoke: async () => allowed });
  assert.equal((await s.execute(call())).record.status, "succeeded");
});
test("constructor budgets are explicit and result failures preserve later availability", () => {
  assert.throws(() => createToolSession(), /invoke/);
  assert.throws(() => session({ maxCalls: -1 }), /budgets/);
  assert.throws(() => session({ maxArtifactBytes: 1.5 }), /budgets/);
  assert.throws(() => session({ now: 0 }), /now/);
  assert.throws(() => session({ maxCalls: 0 }).execute(call()), /call budget/);
});
