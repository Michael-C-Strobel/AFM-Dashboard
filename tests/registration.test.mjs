import test from "node:test";
import assert from "node:assert/strict";
import { registerSurfaces } from "../web/registration.js";
const channel = (w, h, fn = (x, y) => x + 7 * y, extra = {}) => ({
  width: w,
  height: h,
  xreal: w,
  yreal: h,
  xoff: 0,
  yoff: 0,
  xy_unit: "m",
  z_unit: "m",
  data: Float64Array.from({ length: w * h }, (_, i) =>
    fn(i % w, Math.floor(i / w)),
  ),
  mask: null,
  warnings: [],
  ...extra,
});
const close = (a, b, tol = 1e-12) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const noise = (x, y) => Math.sin(x * 13 + y * 53) * Math.cos(x * 7 - y * 19);
test("manual default identity, immutable inputs, calibrated bounds and units", () => {
  const a = channel(4, 3, undefined, {
    xreal: 8,
    yreal: 9,
    xoff: 11,
    yoff: -4,
  });
  const saved = structuredClone(a);
  const r = registerSurfaces(a, a);
  assert.deepEqual(a, saved);
  assert.deepEqual(r.aligned, a.data);
  assert.equal(r.metrics.rmse, 0);
  assert.equal(r.metrics.area, 72);
  assert.equal(r.metrics.area_unit, "(m)²");
  assert.deepEqual(r.metrics.bounds, [0, 0, 4, 3]);
  assert.equal(r.before.rmse, 0);
  assert.equal(r.search, null);
});
test("fractional bilinear interpolation samples an analytic ramp on unequal grids", () => {
  const f = channel(
    3,
    2,
    (x, y) => 2 * (2 + (x + 0.5) * 2 - 0.25) + 3 * (3 + (y + 0.5) * 3 - 0.5),
    { xreal: 6, yreal: 6, xoff: 2, yoff: 3 },
  );
  const m = channel(12, 12, (x, y) => 2 * (x + 0.5) + 3 * (y + 0.5));
  const r = registerSurfaces(f, m, { tx: 0.25, ty: 0.5 });
  close(r.metrics.rmse, 0);
  assert.equal(r.metrics.valid_count, 6);
  assert.ok(r.before.rmse > 0);
});
test("physical offset sign and nonoverlapping baseline are explicit", () => {
  const f = channel(3, 2, undefined, { xoff: 20, yoff: -10 });
  const m = channel(3, 2);
  const r = registerSurfaces(f, m, { tx: 20, ty: -10 });
  assert.equal(r.metrics.rmse, 0);
  assert.equal(r.before.available, false);
  assert.throws(() => registerSurfaces(f, m, { tx: -20, ty: 10 }), /overlap/);
});
test("nearest half ties go to higher index and bilinear requires positive contributors only", () => {
  const m = channel(3, 1, (x) => 10 * x);
  const f = channel(2, 1, (x) => 10 * (x + 1));
  assert.equal(
    registerSurfaces(f, m, { tx: -0.5, interpolation: "nearest" }).metrics.rmse,
    0,
  );
  const same = channel(3, 1, (x) => 10 * x, { mask: Uint8Array.of(0, 1, 0) });
  const r = registerSurfaces(same, same);
  assert.deepEqual(Array.from(r.valid), [1, 0, 1]);
  assert.ok(Number.isNaN(r.aligned[1]));
  assert.ok(Number.isNaN(r.difference[1]));
  assert.throws(
    () => registerSurfaces(channel(1, 1), same, { tx: -0.5 }),
    /overlap/,
  );
});
test("selections nonfinite and masks restrict common overlap", () => {
  const a = channel(4, 2);
  const b = channel(4, 2);
  b.data[2] = NaN;
  b.mask = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0);
  const r = registerSurfaces(a, b, {
    fixed_selection: { roi: [1, 0, 4, 2] },
    moving_selection: { roi: [0, 0, 4, 1] },
  });
  assert.equal(r.metrics.valid_count, 2);
  assert.deepEqual(r.metrics.bounds, [1, 0, 4, 1]);
  assert.equal(r.metrics.overlap_fraction, 1 / 3);
});
test("automatic finds known signed shift at nanometre amplitudes with unequal dimensions", () => {
  const m = channel(7, 6, (x, y) => noise(x, y) * 1e-9, {
    xreal: 14,
    yreal: 18,
    xoff: -3,
    yoff: 9,
  });
  const f = channel(8, 7, (x, y) => noise(x - 1, y + 1) * 1e-9, {
    xreal: 16,
    yreal: 21,
    xoff: 5,
    yoff: 2,
  });
  const r = registerSurfaces(f, m, {
    mode: "automatic",
    radius_x: 2,
    radius_y: 2,
    min_overlap_fraction: 0.5,
  });
  assert.deepEqual(r.transform.pixel_shift, [1, -1]);
  assert.equal(r.transform.tx, 10);
  assert.equal(r.transform.ty, -10);
  assert.equal(r.metrics.rmse, 0);
  assert.equal(r.search.candidates.length, 25);
  assert.equal(r.search.boundary_peak, false);
});
test("signed NCC does not maximize anticorrelation; periodic ties prefer smallest displacement", () => {
  const a = channel(9, 4, (x) => x % 2);
  const r = registerSurfaces(a, a, {
    mode: "automatic",
    radius_x: 2,
    radius_y: 0,
  });
  assert.deepEqual(r.transform.pixel_shift, [0, 0]);
  assert.ok(r.search.tied_candidates.length >= 3);
  close(r.search.candidates.find((c) => c.sx === 1).ncc, -1, 1e-14);
  assert.ok(r.warnings.some((s) => s.includes("ambiguous")));
});
test("boundary winner and candidate counts retain excluded missing pixels", () => {
  const a = channel(8, 6, (x, y) => noise(x - 2, y));
  const b = channel(8, 6, noise);
  b.mask = new Uint8Array(48);
  b.mask[0] = 1;
  const r = registerSurfaces(a, b, {
    mode: "automatic",
    radius_x: 2,
    radius_y: 1,
  });
  assert.deepEqual(r.transform.pixel_shift, [2, 0]);
  assert.equal(r.search.boundary_peak, true);
  assert.equal(r.metrics.valid_count, 35);
});
test("constant automatic and insufficient overlap have no scores", () => {
  assert.throws(
    () =>
      registerSurfaces(
        channel(5, 5, () => 3),
        channel(5, 5, () => 3),
        { mode: "automatic" },
      ),
    /No valid.*score/,
  );
  assert.throws(
    () =>
      registerSurfaces(channel(2, 1), channel(2, 1), {
        mode: "automatic",
        radius_x: 0,
        radius_y: 0,
      }),
    /No valid.*score/,
  );
});
test("calibration units dimensions options and resource limits reject explicitly", () => {
  const a = channel(3, 2);
  for (const patch of [
    { xy_unit: null },
    { z_unit: "V" },
    { xreal: 0 },
    { xoff: Infinity },
    { width: 0 },
    { data: new Float64Array(2) },
    { mask: new Uint8Array(1) },
  ])
    assert.throws(() => registerSurfaces(a, { ...a, ...patch }));
  assert.throws(() => registerSurfaces({ ...a, width: 4194305 }, a), /4194304/);
  assert.throws(
    () => registerSurfaces(a, { ...a, xreal: 4 }, { mode: "automatic" }),
    /pitches/,
  );
  for (const o of [
    { tx: null },
    { tx: NaN },
    { mode: "automatic", tx: 0 },
    { mode: "automatic", interpolation: "integer" },
    { mode: "automatic", radius_x: 65 },
    { mode: "automatic", min_overlap_fraction: 0 },
    { foo: 1 },
    { interpolation: "cubic" },
  ])
    assert.throws(() => registerSurfaces(a, a, o));
  let invoked = false;
  const o = {};
  Object.defineProperty(o, "tx", {
    get() {
      invoked = true;
      return 0;
    },
    enumerable: true,
  });
  assert.throws(() => registerSurfaces(a, a, o));
  assert.equal(invoked, false);
  const big = channel(512, 512);
  assert.throws(
    () =>
      registerSurfaces(big, big, {
        mode: "automatic",
        radius_x: 64,
        radius_y: 64,
      }),
    /crop.*reduce/,
  );
  assert.throws(
    () =>
      registerSurfaces(
        channel(2, 2, () => 1e308),
        channel(2, 2, () => -1e308),
      ),
    RangeError,
  );
});

test("automatic baseline requires integer lattice alignment at zero translation", () => {
  const a = channel(5, 4, noise, { xoff: 0.25 });
  const b = channel(5, 4, noise);
  const r = registerSurfaces(a, b, {
    mode: "automatic",
    radius_x: 0,
    radius_y: 0,
  });
  assert.equal(r.metrics.rmse, 0);
  assert.equal(r.transform.tx, 0.25);
  assert.equal(r.before.available, false);
  assert.match(r.before.reason, /lattices/);
  const integer = registerSurfaces({ ...a, xoff: 1 }, b, {
    mode: "automatic",
    radius_x: 0,
    radius_y: 0,
  });
  assert.equal(integer.before.valid_count, 16);
});
test("tiny calibrated exact samples do not require masked zero-weight neighbors", () => {
  const a = channel(4, 2, noise, {
    xreal: 4e-9,
    yreal: 2e-9,
    mask: Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 0),
  });
  assert.equal(registerSurfaces(a, a).metrics.valid_count, 7);
  const sparse = new Array(4);
  sparse[0] = 0;
  sparse[3] = 1;
  assert.throws(() =>
    registerSurfaces(a, a, { fixed_selection: { roi: sparse } }),
  );
  assert.throws(() =>
    registerSurfaces(a, a, { mode: "automatic", min_overlap_fraction: true }),
  );
});

test("manual finer output grid reports overlap against valid fixed pixels", () => {
  const fixed = channel(6, 6, () => 2, { xreal: 3, yreal: 3 });
  const moving = channel(3, 3, () => 2);
  const r = registerSurfaces(fixed, moving, { interpolation: "nearest" });
  assert.equal(r.metrics.valid_count, 36);
  assert.equal(r.metrics.overlap_fraction, 1);
  assert.equal(r.metrics.fixed_valid_count, 36);
  assert.equal(r.metrics.moving_valid_count, 9);
  assert.equal(
    r.metrics.overlap_fraction_definition,
    "common-valid fixed pixels / valid fixed pixels",
  );
});

test("large offsets and nanometre pitches preserve exact zero-transform grids", () => {
  const a = channel(7, 5, noise, {
    xoff: 7,
    yoff: -5,
    xreal: 7e-9,
    yreal: 5e-9,
  });
  const r = registerSurfaces(a, a);
  assert.equal(r.metrics.valid_count, 35);
  assert.deepEqual(r.aligned, a.data);
  assert.equal(r.metrics.rmse, 0);
});
