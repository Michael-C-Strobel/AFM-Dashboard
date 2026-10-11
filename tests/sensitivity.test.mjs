import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSensitivityRequest,
  sensitivityWork,
  summarizeSensitivity,
} from "../web/sensitivity.js";
const request = () => ({
  baseline_recipe: {
    schema_version: 1,
    operations: [],
    selection: {},
    ordered: "preserved",
  },
  variants: [{ id: "v1", label: "Alternative", operations: [], selection: {} }],
  assumptions: { calibration_note: "", model_note: "" },
});
const result = (n = 2) => ({
  recipe: {
    selection: {},
    output: { geometry: { shape: [2, 2], xreal: 2, yreal: 2 } },
  },
  channel: { z_unit: "m" },
  statistics: {
    sa: n,
    sq: n,
    mean: n,
    min: 0,
    max: 4,
    peak_to_valley: 4,
    area: 4,
    valid_count: 4,
    excluded_count: 0,
    z_unit: "m",
    area_unit: "(m)²",
  },
  step: { height: n, z_unit: "m" },
  comparison: { rmse: n },
});
const variant = (r, id = "v1") => ({
  id,
  label: id,
  status: "succeeded",
  result: r,
  error: null,
});
const metric = (s, key) => s.metrics.find((m) => m.key === key);
test("known metric changes include baseline and preserve nanometre variation", () => {
  const b = result(2e-9),
    v = result(3e-9),
    s = summarizeSensitivity(b, [variant(v)]),
    m = metric(s, "statistics.sa");
  assert.equal(m.unit, "m");
  assert.equal(m.baseline, 2e-9);
  assert.ok(Math.abs(m.values[1].delta - 1e-9) < 1e-24);
  assert.ok(Math.abs(m.values[1].relative_delta - 0.5) < 1e-15);
  assert.deepEqual(m.range.member_ids, ["baseline", "v1"]);
  assert.equal(m.range.count, 2);
  assert.equal(m.range.minimum, 2e-9);
  assert.equal(m.range.maximum, 3e-9);
  assert.deepEqual(
    s.metrics.map((m) => m.key),
    [
      "statistics.sa",
      "statistics.sq",
      "statistics.mean",
      "statistics.min",
      "statistics.max",
      "statistics.peak_to_valley",
      "statistics.area",
      "statistics.valid_count",
      "statistics.excluded_count",
      "step.height",
      "comparison.rmse",
    ],
  );
  assert.equal(metric(s, "statistics.valid_count").unit, "count");
  assert.equal(metric(s, "statistics.area").unit, "(m)²");
});
test("zero baseline retains signed delta and explicit unavailable relative change", () => {
  const m = metric(
    summarizeSensitivity(result(0), [variant(result(-2))]),
    "statistics.mean",
  );
  assert.equal(m.values[1].delta, -2);
  assert.equal(m.values[1].relative_delta, null);
  assert.match(m.values[1].reason, /zero baseline/);
  assert.equal(m.range.max_abs_delta, 2);
});
test("failed missing and nonfinite measurements remain explicit without range membership", () => {
  const absent = result();
  delete absent.statistics.sa;
  const s = summarizeSensitivity(result(), [
    variant(absent),
    {
      id: "bad",
      label: "Bad",
      status: "failed",
      result: null,
      error: "No selected pixels",
    },
    variant(result(NaN), "nan"),
  ]);
  const m = metric(s, "statistics.sa");
  assert.equal(m.values.length, 4);
  assert.deepEqual(m.range.member_ids, ["baseline"]);
  assert.match(m.values[1].reason, /missing/);
  assert.match(m.values[2].reason, /No selected pixels/);
  assert.equal(m.values[3].value, null);
  const b = result();
  b.step = null;
  b.comparison = null;
  b.statistics.z_unit = null;
  b.channel.z_unit = null;
  assert.equal(summarizeSensitivity(b, []).metrics.length, 9);
  assert.equal(summarizeSensitivity(b, []).metrics[0].unit, null);
});
test("arithmetic overflow produces nulls and reasons rather than nonfinite JSON", () => {
  const s = summarizeSensitivity(result(-1e308), [variant(result(1e308))]),
    m = metric(s, "statistics.mean");
  assert.equal(m.values[1].delta, null);
  assert.match(m.values[1].reason, /finite numeric range/);
  assert.equal(m.range.span, null);
  assert.equal(m.range.max_abs_delta, null);
  assert.match(m.range.reason, /range/);
  assert.equal(JSON.stringify(s).includes("Infinity"), false);
  const tiny = metric(
    summarizeSensitivity(result(1e-308), [variant(result(1e308))]),
    "statistics.sa",
  );
  assert.equal(tiny.values[1].relative_delta, null);
  assert.match(tiny.values[1].reason, /Relative delta/);
});
test("same raster hashes do not collapse different populations or measurements", () => {
  const b = result(),
    v = result(7);
  b.recipe.output.sha256 = v.recipe.output.sha256 = "a".repeat(64);
  v.recipe.selection = { roi: [0, 0, 1, 1] };
  v.statistics.valid_count = 1;
  const before = structuredClone([b, v]);
  const s = summarizeSensitivity(b, [variant(v)]);
  assert.equal(s.metrics[0].values[1].value, 7);
  assert.ok(s.warnings.some((w) => w.includes("selection differs")));
  assert.ok(s.warnings.some((w) => w.includes("pixel population")));
  assert.deepEqual([b, v], before);
  const changed = result();
  changed.recipe.output.geometry.shape = [1, 4];
  assert.ok(
    summarizeSensitivity(b, [variant(changed)]).warnings.some((w) =>
      w.includes("geometry differs"),
    ),
  );
});
test("normalization clones recipe order and uses engine defaults without analysis", () => {
  const r = request();
  r.variants[0].operations = [{ name: "plane" }];
  const snapshot = structuredClone(r),
    n = normalizeSensitivityRequest(r);
  assert.deepEqual(r, snapshot);
  assert.equal(
    JSON.stringify(n.baseline_recipe),
    JSON.stringify(r.baseline_recipe),
  );
  assert.deepEqual(n.variants[0].selection, {
    roi: null,
    exclude_polygons: [],
  });
  assert.ok(n.variants[0].operations[0].params);
  n.baseline_recipe.ordered = "changed";
  assert.equal(r.baseline_recipe.ordered, "preserved");
});
test("strict request shape variant identity and bounded options reject", () => {
  for (const mutate of [
    (r) => (r.extra = 1),
    (r) => delete r.assumptions.model_note,
    (r) => (r.variants = []),
    (r) =>
      (r.variants = Array.from({ length: 17 }, (_, i) => ({
        ...r.variants[0],
        id: "v" + i,
      }))),
    (r) => r.variants.push({ ...r.variants[0] }),
    (r) => (r.variants[0].id = "baseline"),
    (r) => (r.variants[0].id = "a\n"),
    (r) => (r.variants[0].label = ""),
    (r) => (r.variants[0].source = "x"),
    (r) =>
      (r.variants[0].operations = Array.from({ length: 33 }, () => ({
        name: "plane",
      }))),
    (r) => (r.variants[0].operations = [{ name: "unknown" }]),
    (r) => (r.variants[0].selection = { roi: [0, 0, 0, 1] }),
    (r) => (r.assumptions.model_note = "x".repeat(2001)),
    (r) => (r.baseline_recipe.data = "x".repeat(262144)),
  ]) {
    const r = request();
    mutate(r);
    assert.throws(() => normalizeSensitivityRequest(r));
  }
});
test("nonfinite prototype accessors cycles sparse arrays and depth reject safely", () => {
  for (const value of [NaN, Infinity, undefined, () => 1, new Date(), 1n]) {
    const r = request();
    r.baseline_recipe.value = value;
    assert.throws(() => normalizeSensitivityRequest(r));
  }
  const r = request();
  let called = false;
  Object.defineProperty(r, "evil", {
    enumerable: true,
    get() {
      called = true;
      return 0;
    },
  });
  assert.throws(() => normalizeSensitivityRequest(r));
  assert.equal(called, false);
  const proto = request();
  proto.baseline_recipe = JSON.parse('{"__proto__":1}');
  assert.throws(() => normalizeSensitivityRequest(proto));
  const cycle = request();
  cycle.baseline_recipe.self = cycle;
  assert.throws(() => normalizeSensitivityRequest(cycle));
  const sparse = request();
  sparse.variants = new Array(1);
  assert.throws(() => normalizeSensitivityRequest(sparse));
});
test("work estimate counts baseline and every variant with minimum one pass", () => {
  const r = request();
  r.baseline_recipe.operations = [{ name: "plane" }, { name: "mean" }];
  assert.deepEqual(sensitivityWork(r, 100), {
    source_pixels: 100,
    estimated_pixel_passes: 300,
    limit: 134217728,
  });
  for (const count of [0, 1.5, 4194305])
    assert.throws(() => sensitivityWork(r, count));
  r.baseline_recipe.operations = Array.from({ length: 32 }, () => ({
    name: "plane",
  }));
  assert.throws(() => sensitivityWork(r, 4194304), /work limit/);
});

test("unknown declared units stay null and channel statistics are not geometry", () => {
  const a = result(),
    b = result(3);
  delete a.recipe.output;
  delete b.recipe.output;
  a.channel.min = 0;
  b.channel.min = -1;
  a.statistics.z_unit = null;
  b.statistics.z_unit = null;
  const s = summarizeSensitivity(a, [variant(b)]);
  assert.equal(s.metrics[0].unit, null);
  assert.ok(!s.warnings.some((w) => w.includes("geometry differs")));
});
