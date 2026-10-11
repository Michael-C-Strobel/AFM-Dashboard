import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOperation,
  compare,
  normalizeOperation,
  profile,
  runPipeline,
  statistics,
  validMask,
} from "../web/engine.js";

function channel(width = 7, height = 5, fn = (x, y) => 0, extra = {}) {
  const c = {
    id: "0",
    title: "Synthetic",
    width,
    height,
    shape: [height, width],
    xreal: width * 2,
    yreal: height * 3,
    xoff: 10,
    yoff: -8,
    xy_unit: "m",
    z_unit: "m",
    metadata: {},
    log: [],
    mask: null,
    warnings: [],
    ...extra,
  };
  c.data = Float64Array.from({ length: width * height }, (_, i) =>
    fn(i % width, Math.floor(i / width)),
  );
  return c;
}
const near = (a, b, tol = 1e-11) =>
  assert.ok(
    Math.abs(a - b) <= tol,
    `${a} differs from ${b} by ${Math.abs(a - b)} > ${tol}`,
  );
const maxAbs = (a) => Math.max(...a.map(Math.abs));
const center = (c, x, y) => [
  c.xoff + ((x + 0.5) * c.xreal) / c.width,
  c.yoff + ((y + 0.5) * c.yreal) / c.height,
];
const process = (c, name, params = {}, selection = {}) =>
  applyOperation(c, { name, params }, selection).channel;

test("plane leveling removes tilted non-square surface and constant offset", () => {
  const c = channel(9, 5, (x, y) => 123 + 2 * x - 3 * y);
  const result = process(c, "plane");
  assert.ok(maxAbs(result.data) < 1e-11);
  assert.equal(result.xoff, 10);
  assert.equal(result.yoff, -8);
  assert.deepEqual(result.shape, [5, 9]);
});

test("quadratic surface fit removes all six polynomial basis terms", () => {
  const c = channel(
    8,
    5,
    (x, y) => 7 + 2 * x - 3 * y + 0.3 * x * x + 0.7 * x * y - 0.2 * y * y,
  );
  const result = process(c, "polynomial", { degree: 2 });
  assert.ok(
    maxAbs(result.data) < 1e-10,
    `quadratic residual ${maxAbs(result.data)}`,
  );
});

test("radius-one three-point leveling fits synthetic plane at pixel centers", () => {
  const c = channel(7, 5, (x, y) => 100 + 3 * x - 2 * y);
  const points = [
    [0, 0],
    [6, 0],
    [0, 4],
  ].map(([x, y]) => center(c, x, y));
  assert.ok(
    maxAbs(process(c, "three_point", { points, radius: 1 }).data) < 1e-11,
  );
});

test("three-point leveling rejects collinear selections", () => {
  const c = channel(7, 5, (x, y) => x + y);
  assert.throws(
    () =>
      process(c, "three_point", {
        points: [
          [0, 0],
          [1, 1],
          [2, 2],
        ].map(([x, y]) => center(c, x, y)),
        radius: 1,
      }),
    /underdetermined/,
  );
});

test("mean and minimum reference use explicit ROI and apply shift to full image", () => {
  const c = channel(4, 2, (x) => [100, 2, 4, 200][x]);
  const selection = { roi: [12, -8, 16, -2] };
  const mean = process(c, "mean", {}, selection),
    zero = process(c, "zero_min", {}, selection);
  assert.deepEqual([...mean.data], [97, -1, 1, 197, 97, -1, 1, 197]);
  assert.deepEqual([...zero.data], [98, 0, 2, 198, 98, 0, 2, 198]);
});

test("areal roughness of alternating zero and two equals one", () => {
  const c = channel(2, 2, (x) => 2 * x),
    s = statistics(c);
  assert.equal(s.sa, 1);
  assert.equal(s.sq, 1);
  assert.equal(s.mean, 1);
  assert.equal(s.valid_count, 4);
  assert.equal(s.area, 24);
  assert.equal(s.peak_to_valley, 2);
});

test("statistics and fit omit imported masks and nonfinite pixels", () => {
  const c = channel(3, 2, (x, y) => [0, 2, 100, NaN, Infinity, 2][y * 3 + x], {
    mask: Uint8Array.from([0, 0, 1, 0, 0, 0]),
  });
  assert.deepEqual([...validMask(c)], [1, 1, 0, 0, 0, 1]);
  const s = statistics(c);
  assert.equal(s.valid_count, 3);
  assert.equal(s.excluded_count, 3);
  near(s.mean, 4 / 3);
  const plane = channel(7, 5, (x, y) => 50 + 2 * x - y, {
    mask: new Uint8Array(35),
  });
  plane.data[0] = 1e6;
  plane.mask[0] = 1;
  plane.data[1] = NaN;
  const result = process(plane, "plane");
  for (let i = 2; i < result.data.length; i++) near(result.data[i], 0);
  assert.ok(Number.isNaN(result.data[1]));
  assert.throws(
    () => statistics({ ...c, mask: new Uint8Array(6).fill(1) }),
    /no valid pixels/,
  );
});

test("crop updates physical extent and offsets while preserving pitch and mask", () => {
  const c = channel(5, 4, (x, y) => y * 10 + x, {
    mask: Uint8Array.from({ length: 20 }, (_, i) => (i === 7 ? 1 : 0)),
  });
  const out = process(c, "crop", { bounds: [12, -5, 18, 1] });
  assert.deepEqual(out.shape, [2, 3]);
  assert.equal(out.xreal, 6);
  assert.equal(out.yreal, 6);
  assert.equal(out.xoff, 12);
  assert.equal(out.yoff, -5);
  assert.deepEqual([...out.data], [11, 12, 13, 21, 22, 23]);
  assert.deepEqual([...out.mask], [0, 1, 0, 0, 0, 0]);
});

test("bilinear profile reproduces analytic ramp at pixel centers and respects masks", () => {
  const c = channel(5, 3, (x, y) => 2 * x + 3 * y);
  const points = [center(c, 0, 1), center(c, 4, 1)];
  let out = profile(c, points);
  assert.deepEqual(out.distance, [0, 2, 4, 6, 8]);
  assert.deepEqual(out.height, [3, 5, 7, 9, 11]);
  c.mask = new Uint8Array(15);
  c.mask[7] = 1;
  out = profile(c, points);
  assert.deepEqual(out.height, [3, 5, null, 9, 11]);
  const diagonal = profile(
    channel(5, 3, (x, y) => 2 * x + 3 * y),
    [center(c, 0, 0), center(c, 4, 2)],
  );
  diagonal.height.forEach((h, i) =>
    near(h, (14 * i) / (diagonal.height.length - 1)),
  );
});

test("comparison requires matching geometry and units and uses common valid pixels", () => {
  const a = channel(4, 3, (x, y) => x + y),
    b = channel(4, 3, (x, y) => x + y - 2);
  const result = compare(a, b);
  assert.equal(result.rmse, 2);
  assert.equal(result.mean_difference, 2);
  for (const change of [
    { width: 3 },
    { z_unit: "V" },
    { xy_unit: "nm" },
    { xreal: 9 },
    { xoff: 11 },
    { yoff: -7 },
  ])
    assert.throws(() => compare(a, { ...b, ...change }), /matching/);
  a.mask = new Uint8Array(12);
  a.mask[0] = 1;
  b.data[1] = NaN;
  assert.equal(compare(a, b).valid_count, 10);
});

test("line matching removes row offsets without flattening lateral step", () => {
  const offsets = [0, 4, -3, 8, -1],
    c = channel(8, 5, (x, y) => (x < 4 ? 0 : 10) + offsets[y]);
  const out = process(c, "line_match", { axis: "rows" });
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 8; x++) near(out.data[y * 8 + x], x < 4 ? 0 : 10);
});

test("Gaussian normalized convolution preserves a constant image", () => {
  const c = channel(7, 4, () => 17),
    out = process(c, "gaussian", { sigma: 1.3 });
  for (const v of out.data) near(v, 17);
  c.mask = new Uint8Array(28);
  c.mask[10] = 1;
  const masked = process(c, "gaussian", { sigma: 1.3 });
  assert.ok(Number.isNaN(masked.data[10]));
  for (let i = 0; i < 28; i++) if (i !== 10) near(masked.data[i], 17);
});

test("operations and pipeline do not mutate input arrays or masks", () => {
  const c = channel(7, 5, (x, y) => 7 + 2 * x - y, {
    mask: new Uint8Array(35),
  });
  c.mask[0] = 1;
  const saved = c.data.slice(),
    mask = c.mask.slice();
  for (const op of ["plane", "mean", "zero_min", "line_match", "gaussian"])
    process(c, op);
  const result = runPipeline(c, [{ name: "plane" }, { name: "zero_min" }]);
  assert.deepEqual(c.data, saved);
  assert.deepEqual(c.mask, mask);
  assert.notEqual(result.channel.data, c.data);
  assert.notEqual(result.channel.mask, c.mask);
});

test("unknown operations and parameters fail before execution", () => {
  for (const op of [
    { name: "mystery" },
    { name: "plane", params: { sigma: 1 } },
    { name: "mean", silent: true },
    { name: "gaussian", params: { sigma: 0 } },
    { name: "polynomial", params: { degree: 3 } },
  ])
    assert.throws(() => normalizeOperation(op));
});

test("robust plane resists sparse positive outliers better than ordinary fit", () => {
  const c = channel(21, 13, (x, y) => 5 + 0.3 * x - 0.2 * y);
  const bad = [0, 1, 2, 21, 22, 42, 250];
  for (const i of bad) c.data[i] += 100;
  const ordinary = process(c, "plane"),
    robust = process(c, "robust_plane");
  const good = [...c.data.keys()].filter((i) => !bad.includes(i));
  const rms = (a) =>
    Math.sqrt(good.reduce((sum, i) => sum + a[i] ** 2, 0) / good.length);
  assert.ok(
    rms(ordinary.data) > 1,
    `ordinary baseline unexpectedly ${rms(ordinary.data)}`,
  );
  assert.ok(rms(robust.data) < 1e-10, `robust inlier RMSE ${rms(robust.data)}`);
});

test("nanometre steps survive leveling fitted to an explicit background region", () => {
  const c = channel(
    12,
    8,
    (x, y) => 7.7e-6 + 2e-11 * x - 3e-11 * y + (x >= 6 ? 20e-9 : 0),
  );
  const result = process(c, "plane", {}, { roi: [10, -8, 22, 16] });
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 12; x++)
      near(result.data[y * 12 + x], x >= 6 ? 20e-9 : 0, 1e-20);
});

test("excluded polygon does not bleed an extreme pixel into Gaussian neighbors", () => {
  const c = channel(5, 5, () => 2);
  c.data[12] = 1e9;
  const [x, y] = center(c, 2, 2),
    selection = {
      exclude_polygons: [
        [
          [x - 0.9, y - 1.4],
          [x + 0.9, y - 1.4],
          [x + 0.9, y + 1.4],
          [x - 0.9, y + 1.4],
        ],
      ],
    };
  const result = process(c, "gaussian", { sigma: 1 }, selection);
  assert.ok(Number.isNaN(result.data[12]));
  for (let i = 0; i < 25; i++) if (i !== 12) near(result.data[i], 2);
});

test("histogram accounts for every valid pixel, including its maximum edge", () => {
  const c = channel(4, 2, (x) => x),
    s = statistics(c);
  assert.equal(
    s.histogram.counts.reduce((a, b) => a + b, 0),
    8,
  );
  assert.equal(s.histogram.edges[0], 0);
  assert.equal(s.histogram.edges.at(-1), 3);
  assert.equal(s.histogram.counts.at(-1), 2);
  assert.deepEqual(statistics(channel(4, 2, () => 5)).histogram, {
    edges: [5, 5],
    counts: [8],
  });
});

test("two plateaus recover known step and report descriptive spreads", async () => {
  const { stepHeight } = await import("../web/engine.js");
  const c = channel(8, 6, (x) => (x < 4 ? 3e-9 : 28e-9));
  const plateaus = [
    [10, -8, 18, 10],
    [18, -8, 26, 10],
  ];
  const result = stepHeight(c, plateaus, { roi: [10, -8, 18, 10] });
  near(result.height, 25e-9, 1e-22);
  assert.equal(result.plateau_a.count, 24);
  assert.equal(result.plateau_b.count, 24);
  near(result.plateau_a.sd, 0, 1e-22);
  assert.throws(() => stepHeight(c, [plateaus[0], plateaus[0]]), /overlap/);
});
