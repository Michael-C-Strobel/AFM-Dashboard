import test from "node:test";
import assert from "node:assert/strict";
import { analyze, replay, CHEMIST_PRESET } from "../web/service.js";
import { tar, exportBundle } from "../web/archive.js";
import { sha256 } from "../web/engine.js";
const channel = {
  id: "0",
  title: "Synthetic",
  width: 4,
  height: 3,
  shape: [3, 4],
  xreal: 4,
  yreal: 3,
  xoff: 0,
  yoff: 0,
  xy_unit: "m",
  z_unit: "m",
  metadata: {},
  log: [],
  warnings: [],
  selections: {},
  data: Float64Array.from(
    { length: 12 },
    (_, i) => 7 + (i % 4) + 2 * Math.floor(i / 4),
  ),
  mask: null,
};
const source = {
  channels: { 0: channel },
  sha256: "test-source",
  unsupported: [],
  warnings: [],
};
test("JSON recipe roundtrip reproduces output hash and rejects source or engine changes", async () => {
  const result = await analyze(
    { file: "test.gwy", channel: 0, operations: [{ name: "plane" }] },
    source,
    null,
    "engine-test",
  );
  const recipe = JSON.parse(JSON.stringify(result.recipe));
  const again = await replay(recipe, source, null, "engine-test");
  assert.equal(again.replay_verified, true);
  assert.deepEqual(again.data, result.data);
  await assert.rejects(
    replay(recipe, { ...source, sha256: "different" }, null, "engine-test"),
    /Source SHA/,
  );
  await assert.rejects(
    replay(recipe, source, null, "different-engine"),
    /engine differs/,
  );
  const changed = structuredClone(recipe);
  changed.operations = [{ name: "mean", params: {} }];
  await assert.rejects(
    replay(changed, source, null, "engine-test"),
    /output differs/,
  );
});
test("replay binds masks and calibration, not only height values", async () => {
  const masked = {
    ...source,
    channels: {
      0: { ...channel, mask: Uint8Array.from([1, ...Array(11).fill(0)]) },
    },
  };
  const { recipe } = await analyze(
    { file: "test.gwy", channel: 0 },
    masked,
    null,
    "engine-test",
  );
  await assert.rejects(
    replay(recipe, source, null, "engine-test"),
    /output differs/,
  );
  const modified = { ...source, channels: { 0: { ...channel, xreal: 5 } } };
  await assert.rejects(
    replay(recipe, modified, null, "engine-test"),
    /calibration mismatch/,
  );
});
test("reference comparisons and profiles survive recipe replay", async () => {
  const result = await analyze(
    {
      file: "test.gwy",
      channel: 0,
      profile: [
        [0.5, 0.5],
        [3.5, 2.5],
      ],
      reference: { file: "ref.gwy", channel: 0 },
    },
    source,
    source,
    "engine-test",
  );
  assert.equal(result.comparison.rmse, 0);
  assert.equal(result.profile.height[0], 7);
  await assert.rejects(
    replay(
      result.recipe,
      source,
      { ...source, sha256: "wrong" },
      "engine-test",
    ),
    /Reference SHA/,
  );
  assert.equal(
    (await replay(result.recipe, source, source, "engine-test")).comparison
      .rmse,
    0,
  );
});
test("cropped original stays aligned with derived geometry", async () => {
  const r = await analyze(
    {
      file: "test.gwy",
      channel: 0,
      operations: [{ name: "crop", params: { bounds: [1, 1, 3, 3] } }],
    },
    source,
    null,
    "engine-test",
  );
  assert.deepEqual(r.channel.shape, [2, 2]);
  assert.deepEqual(r.original, r.data);
  assert.deepEqual(r.data, [
    [10, 11],
    [12, 13],
  ]);
});
test("export archive contains recipe, data, and records with safe names", async () => {
  const r = await analyze(
      { file: "test.gwy", channel: 0 },
      source,
      null,
      "engine-test",
    ),
    archive = await exportBundle(r),
    decoder = new TextDecoder();
  const entries = {};
  let offset = 0;
  while (archive[offset]) {
    const header = archive.subarray(offset, offset + 512),
      name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, ""),
      size = parseInt(decoder.decode(header.subarray(124, 136)), 8);
    entries[name] = decoder.decode(
      archive.subarray(offset + 512, offset + 512 + size),
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(JSON.parse(entries["recipe.json"]).source.file, "test.gwy");
  assert.ok(entries["surface.tsv"].includes("7\t8\t9\t10"));
  assert.ok(entries["analysis.json"]);
  assert.throws(() => tar({ "../escape": "bad" }), /Unsafe/);
});
test("SHA-256 matches known independent test vector", async () => {
  assert.equal(
    await sha256(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("replay verifies profile measurements and output geometry, not just surface pixels", async () => {
  const result = await analyze(
    {
      file: "test.gwy",
      channel: 0,
      profile: [
        [0.5, 0.5],
        [3.5, 2.5],
      ],
    },
    source,
    null,
    "engine-test",
  );
  const modified = structuredClone(result.recipe);
  modified.profile = [
    [0.5, 0.5],
    [3.5, 0.5],
  ];
  await assert.rejects(
    replay(modified, source, null, "engine-test"),
    /output differs/,
  );
  const wrongGeometry = structuredClone(result.recipe);
  wrongGeometry.output.geometry.xoff = 1;
  await assert.rejects(
    replay(wrongGeometry, source, null, "engine-test"),
    /output differs/,
  );
});

// Removed laboratory settings must never turn into a silently accepted no-op.
test("private preset cannot process an imported source without reviewed fit points", async () => {
  await assert.rejects(
    analyze(
      { file: "synthetic.gwy", channel: 0, operations: CHEMIST_PRESET },
      source,
      null,
      "engine-test",
    ),
    /point/i,
  );
});
