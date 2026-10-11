import test from "node:test";
import assert from "node:assert/strict";
import { applyOperation, normalizeOperation } from "../web/engine.js";
import { analyze, replay } from "../web/service.js";
import { migrateRecipe, replayRecipeInput } from "../web/recipe-interchange.js";
const engine = "e".repeat(64);
const near = (a, b, t = 1e-22) =>
  assert.ok(Math.abs(a - b) <= t, `${a} differs from ${b}`);
function source() {
  return {
    sha256: "a".repeat(64),
    warnings: [],
    unsupported: [],
    channels: {
      0: {
        id: "0",
        title: "Synthetic tilted step",
        width: 8,
        height: 6,
        shape: [6, 8],
        xreal: 8,
        yreal: 6,
        xoff: 0,
        yoff: 0,
        xy_unit: "m",
        z_unit: "m",
        data: Float64Array.from(
          { length: 48 },
          (_, i) =>
            (10 + 2 * (i % 8) + 3 * Math.floor(i / 8) + (i % 8 >= 4 ? 5 : 0)) *
            1e-9,
        ),
        mask: null,
        metadata: {},
        log: [],
        warnings: [],
        selections: {},
      },
    },
  };
}
const operations = () => [
  {
    name: "three_point",
    params: {
      points: [
        [0.5, 0.5],
        [2.5, 0.5],
        [0.5, 4.5],
      ],
      radius: 1,
    },
    selection: {},
  },
  { name: "zero_min", selection: {} },
];
const request = (selection = {}) => ({
  file: "synthetic.gwy",
  channel: "0",
  operations: operations(),
  selection,
  plateaus: [
    [1, 1, 3, 3],
    [5, 1, 7, 3],
  ],
});
test("fixed operation domains preserve three-point leveled surface while measurement ROI and two plateaus change", async () => {
  const input = source(),
    before = structuredClone(input),
    full = await analyze(request(), input, null, engine),
    tiny = await analyze(request({ roi: [1, 1, 2, 2] }), input, null, engine);
  near(tiny.step.height, 5e-9);
  assert.equal(tiny.step.plateau_a.count, 4);
  assert.equal(tiny.step.plateau_b.count, 4);
  assert.equal(full.recipe.output.sha256, tiny.recipe.output.sha256);
  assert.deepEqual(
    full.history.map((step) => step.artifact_id),
    tiny.history.map((step) => step.artifact_id),
  );
  assert.deepEqual(
    full.history.map((step) => step.selection),
    tiny.history.map((step) => step.selection),
  );
  assert.equal(full.recipe.output.mask_sha256, tiny.recipe.output.mask_sha256);
  assert.notEqual(
    full.recipe.output.measurement_sha256,
    tiny.recipe.output.measurement_sha256,
  );
  assert.equal(full.statistics.valid_count, 48);
  assert.equal(tiny.statistics.valid_count, 1);
  near(full.statistics.mean, 2.5e-9);
  near(tiny.statistics.mean, 0);
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 8; x++) near(tiny.data[y][x], x < 4 ? 0 : 5e-9);
  assert.deepEqual(input, before);
  for (const op of tiny.recipe.operations)
    assert.deepEqual(op.selection, { roi: null, exclude_polygons: [] });
});
test("legacy unscoped operations retain global-selection behavior and leveling error", async () => {
  const input = source(),
    r = request({ roi: [1, 1, 2, 2] });
  r.operations = r.operations.map(({ selection, ...op }) => op);
  await assert.rejects(
    analyze(r, input, null, engine),
    /leveling point has no valid pixels/i,
  );
  const full = await analyze({ ...r, selection: {} }, input, null, engine);
  near(full.step.height, 5e-9);
  assert.ok(
    full.recipe.operations.every((op) => !Object.hasOwn(op, "selection")),
  );
});
test("operation masks and exclusions remain effective independently of measurement ROI", () => {
  const c = source().channels[0],
    op = operations()[0];
  c.mask = new Uint8Array(48);
  c.mask[0] = 1;
  const before = structuredClone(c);
  assert.throws(
    () => applyOperation(c, op, { roi: [1, 1, 2, 2] }),
    /leveling point has no valid pixels/i,
  );
  assert.deepEqual(c, before);
  c.mask = null;
  op.selection = {
    exclude_polygons: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ],
  };
  assert.throws(
    () => applyOperation(c, op, {}),
    /leveling point has no valid pixels/i,
  );
  // Excluding the right plateau from an explicit mean fit retains its true step.
  const mean = applyOperation(
    {
      ...c,
      data: Float64Array.from({ length: 48 }, (_, i) =>
        i % 8 < 4 ? 2e-9 : 7e-9,
      ),
    },
    { name: "mean", selection: { roi: [0, 0, 4, 6] } },
    { roi: [5, 1, 6, 2] },
  );
  near(mean.channel.data[0], 0);
  near(mean.channel.data[7], 5e-9);
});
test("different explicit fit domains change the correction without changing the source", () => {
  const c = source().channels[0],
    before = c.data.slice();
  const all = applyOperation(
      c,
      { name: "mean", selection: {} },
      { roi: [0, 0, 1, 1] },
    ),
    left = applyOperation(
      c,
      { name: "mean", selection: { roi: [0, 0, 4, 6] } },
      { roi: [0, 0, 1, 1] },
    );
  // Right-half height exceeds left-half mean by 8 nm tilt + 5 nm step;
  // all-image mean is therefore 6.5 nm above the left-half mean.
  for (let i = 0; i < c.data.length; i++)
    near(left.channel.data[i] - all.channel.data[i], 6.5e-9);
  assert.deepEqual(c.data, before);
});
test("normalization copies scoped selections and rejects malformed operation or selection fields", () => {
  const raw = { name: "mean", selection: { roi: [0, 0, 2, 2] } },
    op = normalizeOperation(raw);
  raw.selection.roi[0] = -10;
  assert.deepEqual(op.selection, { roi: [0, 0, 2, 2], exclude_polygons: [] });
  for (const bad of [
    { name: "mean", unexpected: true },
    { name: "mean", selection: { unexpected: true } },
    { name: "mean", selection: { roi: [2, 0, 1, 1] } },
    { name: "mean", selection: { roi: [0, 0, Infinity, 1] } },
    {
      name: "mean",
      selection: {
        exclude_polygons: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
    },
  ])
    assert.throws(() => normalizeOperation(bad));
});
test("legacy and portable recipe replay retain scoped operations and reject changed scientific output", async () => {
  const input = source(),
    result = await analyze(request({ roi: [1, 1, 2, 2] }), input, null, engine),
    recipe = JSON.parse(JSON.stringify(result.recipe));
  const legacy = await replay(recipe, input, null, engine);
  assert.equal(legacy.replay_verified, true);
  assert.deepEqual(legacy.recipe.operations, recipe.operations);
  assert.deepEqual(legacy.recipe.output, recipe.output);
  const document = await migrateRecipe(recipe, input, null, engine),
    portable = await replayRecipeInput(document, input, null, engine);
  assert.equal(portable.replay_verified, true);
  assert.deepEqual(portable.recipe.operations, recipe.operations);
  assert.deepEqual(portable.recipe.output, recipe.output);
  const tampered = structuredClone(recipe);
  tampered.output.sha256 = "b".repeat(64);
  await assert.rejects(
    replay(tampered, input, null, engine),
    /Replay output differs/,
  );
  await assert.rejects(
    migrateRecipe(tampered, input, null, engine),
    /Replay output differs/,
  );
  const changed = structuredClone(recipe);
  changed.operations[1].selection.roi = [4, 0, 8, 6];
  await assert.rejects(
    replay(changed, input, null, engine),
    /Replay output differs/,
  );
  const unscoped = await analyze(
    {
      ...request(),
      operations: operations().map(({ selection, ...op }) => op),
    },
    input,
    null,
    engine,
  );
  const oldPortable = await migrateRecipe(unscoped.recipe, input, null, engine);
  assert.equal(
    (await replayRecipeInput(oldPortable, input, null, engine)).replay_verified,
    true,
  );
});
