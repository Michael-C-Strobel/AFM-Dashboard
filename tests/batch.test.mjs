import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { ENGINE_VERSION, geometry, sha256 } from "../web/engine.js";
import { makeBatchRequest, runBatch } from "../web/batch.js";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const channel = () => ({
  id: "0",
  title: "Height_Trace",
  width: 3,
  height: 2,
  xreal: 6e-6,
  yreal: 4e-6,
  xoff: 1e-6,
  yoff: -1e-6,
  xy_unit: "m",
  z_unit: "m",
});
const source = () => ({ channels: { 0: channel() } });
const recipe = () => ({
  schema_version: 1,
  engine: {
    name: "afm-dashboard-js",
    version: ENGINE_VERSION,
    sha256: "engine-sha",
  },
  source: {
    channel: "0",
    title: "Height_Trace",
    geometry: geometry(channel()),
  },
  operations: [{ name: "mean", params: {} }],
  selection: { roi: null, exclude_polygons: [] },
  profile: [
    [1, 2],
    [3, 4],
  ],
  plateaus: [
    [0, 0, 1, 1],
    [2, 2, 3, 3],
  ],
  reference: null,
});
const request = (t = recipe(), s = source(), engine = "engine-sha") =>
  makeBatchRequest(t, s, engine, "input.gwy");

test("compatible template returns detached exact parameters independent of geometry key order", () => {
  const t = recipe();
  t.source.geometry = Object.fromEntries(
    Object.entries(t.source.geometry).reverse(),
  );
  const output = request(t);
  assert.deepEqual(output, {
    file: "input.gwy",
    channel: "0",
    operations: t.operations,
    selection: t.selection,
    profile: t.profile,
    plateaus: t.plateaus,
  });
  output.operations[0].params.changed = true;
  output.selection.roi = [0, 0, 1, 1];
  output.profile[0][0] = 99;
  assert.deepEqual(t.operations, [{ name: "mean", params: {} }]);
  assert.equal(t.selection.roi, null);
  assert.equal(t.profile[0][0], 1);
});

test("schema and exact engine name version hash compatibility are required", () => {
  for (const patch of [
    { schema_version: 2 },
    { engine: { ...recipe().engine, name: "other" } },
    { engine: { ...recipe().engine, version: "9" } },
    { engine: { ...recipe().engine, sha256: "other" } },
  ])
    assert.throws(() => request({ ...recipe(), ...patch }), /schema|engine/);
  assert.throws(() => request(recipe(), source(), ""), /engine/);
});

test("channel ID title dimensions extents offsets and units must match exactly", () => {
  for (const patch of [
    { id: "1" },
    { title: "Height_Retrace" },
    { width: 4 },
    { height: 3 },
    { xreal: 7e-6 },
    { yreal: 5e-6 },
    { xoff: 0 },
    { yoff: 0 },
    { xy_unit: "nm" },
    { z_unit: "V" },
  ])
    assert.throws(
      () => request(recipe(), { channels: { 0: { ...channel(), ...patch } } }),
      /channel/,
    );
  assert.throws(
    () => request(recipe(), { channels: { 1: channel() } }),
    /channel/,
  );
  const t = recipe();
  t.source.channel = 0;
  assert.throws(() => request(t), /channel/);
});

test("explicit operations selection required and all nonnull references rejected", () => {
  for (const key of ["operations", "selection"]) {
    const t = recipe();
    delete t[key];
    assert.throws(() => request(t), /explicit/);
  }
  for (const reference of [{}, false, 0, "ref.gwy"])
    assert.throws(
      () => request({ ...recipe(), reference }),
      /Batch templates must not contain a reference comparison/,
    );
  assert.doesNotThrow(() =>
    request({
      ...recipe(),
      operations: [{ name: "defer validation", params: { custom: 1 } }],
    }),
  );
});

test("empty duplicate or nonstring filenames reject before any execution", async () => {
  for (const files of [[], ["a", "a"], [""], [2], null])
    await assert.rejects(
      runBatch({
        template: recipe(),
        files,
        execute: () => assert.fail("must not execute"),
      }),
      /filename/,
    );
});

test("batch snapshots before await and isolates execute updates and returned provenance", async () => {
  const t = recipe(),
    original = structuredClone(t),
    files = ["a", "b"],
    updates = [],
    metadata = {
      recipe: { source: { sha256: "source-hash" } },
      statistics: { mean: 2 },
      support: { status: "unverified" },
      warnings: ["review"],
      output_sha256: "out-hash",
    };
  const running = runBatch({
    template: t,
    files,
    execute: async (file, copy) => {
      assert.deepEqual(copy, original);
      copy.operations[0].params.changed = true;
      return metadata;
    },
    onUpdate: async (update) => {
      updates.push(structuredClone(update));
      update.template.operations = [];
      update.records[0].file = "mutated";
    },
  });
  t.operations = [];
  files[0] = "changed";
  const report = await running;
  assert.deepEqual(report.template, original);
  assert.deepEqual(
    report.records.map((r) => r.file),
    ["a", "b"],
  );
  assert.equal(
    report.template_sha256,
    await sha256(new TextEncoder().encode(JSON.stringify(original))),
  );
  assert.deepEqual(report.records[0].result, metadata);
  metadata.statistics.mean = 999;
  assert.equal(report.records[0].result.statistics.mean, 2);
  assert.deepEqual(
    updates.map((u) => u.records.map((r) => r.status)),
    [
      ["pending", "pending"],
      ["running", "pending"],
      ["complete", "pending"],
      ["complete", "running"],
      ["complete", "complete"],
    ],
  );
});

test("execution is sequential and continues after per-file failures", async () => {
  let active = 0,
    max = 0;
  const order = [];
  const report = await runBatch({
    template: recipe(),
    files: ["a", "bad", "c"],
    execute: async (file) => {
      active++;
      max = Math.max(max, active);
      order.push(file);
      await Promise.resolve();
      active--;
      if (file === "bad") throw new Error("bad calibration");
      return { file_hash: file };
    },
  });
  assert.equal(max, 1);
  assert.deepEqual(order, ["a", "bad", "c"]);
  assert.deepEqual(
    report.records.map((r) => r.status),
    ["complete", "failed", "complete"],
  );
  assert.equal(report.records[1].error, "bad calibration");
  assert.equal(report.canceled, false);
});

test("cancellation before execution marks all files not_run", async () => {
  const report = await runBatch({
    template: recipe(),
    files: ["a", "b"],
    shouldCancel: () => true,
    execute: () => assert.fail("must not run"),
  });
  assert.equal(report.canceled, true);
  assert.deepEqual(
    report.records.map((r) => r.status),
    ["not_run", "not_run"],
  );
});

test("cancellation during current file finishes it and skips remaining files", async () => {
  let canceled = false;
  const report = await runBatch({
    template: recipe(),
    files: ["a", "b", "c"],
    shouldCancel: () => canceled,
    execute: async (file) => {
      assert.equal(file, "a");
      canceled = true;
      await Promise.resolve();
      return { output_sha256: "retained" };
    },
  });
  assert.equal(report.canceled, true);
  assert.deepEqual(
    report.records.map((r) => r.status),
    ["complete", "not_run", "not_run"],
  );
  assert.equal(report.records[0].result.output_sha256, "retained");
});

test("asynchronous updates finish before the next execution begins", async () => {
  let updating = false;
  await runBatch({
    template: recipe(),
    files: ["a", "b"],
    onUpdate: async () => {
      updating = true;
      await Promise.resolve();
      updating = false;
    },
    execute: async () => {
      assert.equal(updating, false);
      return {};
    },
  });
});
