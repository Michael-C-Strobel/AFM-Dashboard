import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { sha256 } from "../web/engine.js";
import { validatePlan, runPlan } from "../web/tool-plans.js";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const id = "artifact:" + "a".repeat(64);
const step = (
  name = "first",
  call = { name: "list_sources", arguments: {} },
) => ({ id: name, call });
const plan = () => ({
  schema_version: 1,
  title: "Inspect data",
  steps: [
    step(),
    step("second", {
      name: "get_artifact",
      arguments: { artifact_id: "$step:first" },
    }),
  ],
});
const success = () => ({
  record: { status: "succeeded", source_sha256: "b".repeat(64) },
  artifact: { id, kind: "sources" },
});

test("validation normalizes rationale and supports only prior artifact references", () => {
  const p = validatePlan(plan());
  assert.equal(p.steps[0].rationale, "");
  assert.equal(p.steps[1].call.arguments.artifact_id, "$step:first");
  const replay = plan();
  replay.steps[1].call = {
    name: "replay_recipe",
    arguments: {
      file: "a.gwy",
      source_sha256: "b".repeat(64),
      recipe_artifact: "$step:first",
    },
  };
  assert.equal(
    validatePlan(replay).steps[1].call.arguments.recipe_artifact,
    "$step:first",
  );
  p.steps[0].call.name = "mutated";
  assert.equal(validatePlan(plan()).steps[0].call.name, "list_sources");
});

test("invalid schema IDs bounds forward references and unknown tools reject", () => {
  for (const p of [
    { ...plan(), schema_version: 2 },
    { ...plan(), title: "" },
    { ...plan(), steps: [] },
    { ...plan(), steps: Array.from({ length: 17 }, (_, i) => step("s" + i)) },
    { ...plan(), extra: 1 },
    { ...plan(), steps: [step("same"), step("same")] },
    { ...plan(), steps: [step("Bad")] },
    { ...plan(), steps: [{ ...step(), rationale: "x".repeat(2001) }] },
    {
      ...plan(),
      steps: [
        step("first", {
          name: "get_artifact",
          arguments: { artifact_id: "$step:later" },
        }),
      ],
    },
    { ...plan(), steps: [step("first", { name: "eval", arguments: {} })] },
  ])
    assert.throws(() => validatePlan(p));
  const p = plan();
  p.steps[1].call = {
    name: "inspect_source",
    arguments: { file: "$step:first" },
  };
  assert.throws(() => validatePlan(p), /only/);
});

test("all calls are validated before any execution", async () => {
  const p = plan();
  p.steps[1].call = { name: "inspect_source", arguments: { file: "../a" } };
  let executions = 0;
  await assert.rejects(
    runPlan(p, {
      execute: async () => {
        executions++;
        return success();
      },
    }),
  );
  assert.equal(executions, 0);
});

test("plain finite JSON guard rejects getters symbols prototypes cycles and depth", () => {
  let invoked = false;
  const p = {
    ...plan(),
    get surprise() {
      invoked = true;
      return 1;
    },
  };
  assert.throws(() => validatePlan(p));
  assert.equal(invoked, false);
  for (const value of [NaN, Infinity, undefined, 1n, () => {}, new Date()])
    assert.throws(() => validatePlan({ ...plan(), title: value }));
  assert.throws(() => validatePlan({ ...plan(), [Symbol("x")]: 1 }));
  assert.throws(() =>
    validatePlan(JSON.parse('{"schema_version":1,"__proto__":{}}')),
  );
  const cyclic = plan();
  cyclic.loop = cyclic;
  assert.throws(() => validatePlan(cyclic));
  const deep = plan();
  let cursor = deep;
  for (let n = 0; n < 66; n++) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  assert.throws(() => validatePlan(deep), /depth/);
  assert.throws(
    () => validatePlan({ ...plan(), title: "x".repeat(1048577) }),
    /1048576/,
  );
});

test("snapshots and detached updates preserve plan provenance and resolved calls", async () => {
  const input = plan(),
    original = validatePlan(input),
    calls = [],
    updates = [];
  const running = runPlan(input, {
    execute: async (call) => {
      calls.push(structuredClone(call));
      call.name = "mutated";
      return success();
    },
    onUpdate: async (m) => {
      updates.push(structuredClone(m));
      m.plan.steps = [];
      m.steps[0].id = "mutated";
    },
  });
  input.title = "changed";
  input.steps = [];
  const manifest = await running;
  assert.deepEqual(manifest.plan, original);
  assert.equal(
    manifest.plan_sha256,
    await sha256(new TextEncoder().encode(JSON.stringify(original))),
  );
  assert.equal(calls[1].arguments.artifact_id, id);
  assert.equal(manifest.steps[1].resolved_call.arguments.artifact_id, id);
  assert.equal(
    manifest.plan.steps[1].call.arguments.artifact_id,
    "$step:first",
  );
  assert.equal(manifest.steps[0].resolved_call.name, "list_sources");
  assert.equal(manifest.status, "complete");
  assert.deepEqual(
    manifest.steps.map((s) => s.status),
    ["complete", "complete"],
  );
  assert.equal(updates[0].steps[0].status, "pending");
});

test("execution and asynchronous updates are strictly sequential", async () => {
  let active = 0,
    updating = false;
  await runPlan(plan(), {
    execute: async () => {
      assert.equal(updating, false);
      assert.equal(active, 0);
      active++;
      await Promise.resolve();
      active--;
      return success();
    },
    onUpdate: async () => {
      assert.equal(active, 0);
      updating = true;
      await Promise.resolve();
      updating = false;
    },
  });
});

test("cancellation before a step skips all pending work", async () => {
  const result = await runPlan(plan(), {
    shouldCancel: () => true,
    execute: () => assert.fail("no execute"),
  });
  assert.equal(result.status, "canceled");
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["not_run", "not_run"],
  );
});

test("cancellation during execution finishes current step and stops remaining work", async () => {
  let cancel = false;
  const result = await runPlan(plan(), {
    shouldCancel: () => cancel,
    execute: async () => {
      cancel = true;
      await Promise.resolve();
      return success();
    },
  });
  assert.equal(result.status, "canceled");
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["complete", "not_run"],
  );
});

test("failed envelopes and thrown errors fail fast preserving valid returned evidence", async () => {
  for (const throws of [false, true]) {
    let executed = 0;
    const result = await runPlan(plan(), {
      execute: async () => {
        executed++;
        if (throws) throw new Error("bad import");
        return {
          record: { status: "failed", error: "bad calibration" },
          artifact: null,
        };
      },
    });
    assert.equal(executed, 1);
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.steps.map((s) => s.status),
      ["failed", "not_run"],
    );
    assert.match(result.steps[0].error, /bad/);
    if (!throws) {
      assert.equal(result.steps[0].result.artifact, null);
      assert.equal(result.steps[0].result.record.error, "bad calibration");
    }
  }
});

test("malformed envelopes and absent prerequisite artifacts fail without executing dependents", async () => {
  for (const value of [
    { record: { status: "complete" }, artifact: { id } },
    { record: { status: "succeeded" }, artifact: { id: "bad" } },
    { record: { status: "succeeded" } },
  ]) {
    const result = await runPlan(plan(), { execute: async () => value });
    assert.equal(result.status, "failed");
    assert.equal(result.steps[1].status, "not_run");
  }
  for (const value of [
    { record: { status: "succeeded" }, artifact: null },
    { record: { status: "failed", error: "failure" }, artifact: { id } },
  ]) {
    let count = 0;
    const result = await runPlan(plan(), {
      execute: async () => {
        count++;
        return value;
      },
    });
    assert.equal(count, 1);
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.steps.map((s) => s.status),
      ["failed", "not_run"],
    );
    assert.match(result.steps[0].error, /inconsistent/);
    assert.equal(result.steps[0].result, undefined);
  }
});

test("callback rejection aborts without continuing execution", async () => {
  let count = 0;
  await assert.rejects(
    runPlan(plan(), {
      execute: async () => {
        count++;
        return success();
      },
      onUpdate: async () => {
        throw new Error("observer failed");
      },
    }),
    /observer failed/,
  );
  assert.equal(count, 0);
});

test("explicit null rationale and trailing-newline IDs are invalid", () => {
  assert.throws(() =>
    validatePlan({ ...plan(), steps: [{ ...step(), rationale: null }] }),
  );
  assert.throws(() => validatePlan({ ...plan(), steps: [step("first\n")] }));
});

test("unserializable thrown values still produce a failed manifest", async () => {
  const error = {};
  error.self = error;
  const result = await runPlan(plan(), {
    execute: async () => {
      throw error;
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.steps[1].status, "not_run");
  assert.equal(typeof result.steps[0].error, "string");
});

test("segmentation plans resolve only prior recipe artifact dependencies", () => {
  const result = validatePlan({
    schema_version: 1,
    title: "Segment measured surface",
    steps: [
      {
        id: "measure",
        call: {
          name: "analyze_surface",
          arguments: {
            file: "source.gwy",
            source_sha256: "a".repeat(64),
            channel: "0",
            operations: [],
          },
        },
      },
      {
        id: "segment",
        call: {
          name: "segment_surface",
          arguments: {
            file: "source.gwy",
            source_sha256: "a".repeat(64),
            recipe_artifact: "$step:measure",
            parameters: { threshold: 1 },
          },
        },
      },
    ],
  });
  assert.equal(result.steps[1].call.arguments.recipe_artifact, "$step:measure");
  result.steps.reverse();
  assert.throws(() => validatePlan(result), /earlier step/);
});
