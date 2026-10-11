import test from "node:test";
import assert from "node:assert/strict";
import { applyOperation, normalizeOperation } from "../web/engine.js";
import { analyze, replay } from "../web/service.js";
function channel(fn, width = 9, height = 6, extra = {}) {
  return {
    id: "0",
    title: "Synthetic line polynomials",
    width,
    height,
    shape: [height, width],
    xreal: width * 2e-9,
    yreal: height * 5e-9,
    xoff: 7e-6,
    yoff: -4e-6,
    xy_unit: "m",
    z_unit: "m",
    metadata: {},
    log: [],
    warnings: [],
    selections: {},
    mask: null,
    ...extra,
    data: Float64Array.from({ length: width * height }, (_, i) =>
      fn(i % width, Math.floor(i / width)),
    ),
  };
}
const near = (value, expected, tolerance) =>
  assert.ok(
    Math.abs(value - expected) <= tolerance,
    `${value} differs from ${expected} by ${Math.abs(value - expected)} (limit ${tolerance})`,
  );
const operate = (c, axis = "rows", degree = 1, selection = {}) =>
  applyOperation(
    c,
    { name: "line_polynomial", params: { axis, degree } },
    selection,
  );
for (const axis of ["rows", "columns"])
  for (const degree of [0, 1, 2, 3])
    test(`${axis} degree ${degree} removes known independent polynomials on calibrated nonsquare grids`, () => {
      const c = channel((x, y) => {
        const j = axis === "rows" ? x : y,
          line = axis === "rows" ? y : x;
        return (
          (17 +
            3 * line +
            (degree >= 1 ? 2 * j : 0) +
            (degree >= 2 ? -0.4 * j * j : 0) +
            (degree >= 3 ? 0.03 * j * j * j : 0)) *
          1e-9
        );
      });
      const before = structuredClone(c),
        r = operate(c, axis, degree),
        length = axis === "rows" ? c.width : c.height;
      for (const v of r.channel.data) near(v, 0, 1e-21);
      assert.deepEqual(c, before);
      assert.equal(r.details.fits.length, axis === "rows" ? c.height : c.width);
      assert.equal(r.details.axis_offset, axis === "rows" ? c.xoff : c.yoff);
      near(r.details.axis_pitch, axis === "rows" ? 2e-9 : 5e-9, 1e-23);
      for (const fit of r.details.fits) {
        assert.equal(fit.count, length);
        assert.equal(fit.coefficients.length, degree + 1);
        assert.deepEqual(fit.fit_index_bounds, [0, length]);
        assert.ok(Number.isFinite(fit.height_origin));
        assert.equal(fit.index_origin, (length - 1) / 2);
        assert.equal(fit.index_scale, (length - 1) / 2);
      }
    });
test("excluded or masked feature remains above fitted background; fitting it changes its residual", () => {
  const c = channel((x, y) => 2 + x + 3 * y + (x === 4 ? 10 : 0));
  const polygon = [
    [c.xoff + 8e-9, c.yoff],
    [c.xoff + 10e-9, c.yoff],
    [c.xoff + 10e-9, c.yoff + c.yreal],
    [c.xoff + 8e-9, c.yoff + c.yreal],
  ];
  const excluded = operate(c, "rows", 1, { exclude_polygons: [polygon] }),
    fitted = operate(c);
  for (let y = 0; y < c.height; y++) {
    near(excluded.channel.data[y * c.width + 4], 10, 1e-12);
    near(fitted.channel.data[y * c.width + 4], 80 / 9, 1e-12);
  }
  for (let i = 0; i < c.data.length; i++)
    if (i % c.width !== 4) near(excluded.channel.data[i], 0, 1e-12);
  const masked = structuredClone(c);
  masked.mask = new Uint8Array(c.data.length);
  for (let y = 0; y < c.height; y++) masked.mask[y * c.width + 4] = 1;
  const before = structuredClone(masked),
    r = operate(masked);
  assert.deepEqual(r.channel.mask, masked.mask);
  assert.deepEqual(masked, before);
  for (let y = 0; y < c.height; y++)
    near(r.channel.data[y * c.width + 4], 10, 1e-12);
});
test("degree zero subtracts selected line mean and leaves unselected lines unchanged", () => {
  const c = channel((x, y) => 2 * x + 10 * y, 4, 3, {
      xreal: 4,
      yreal: 3,
      xoff: 0,
      yoff: 0,
    }),
    r = operate(c, "rows", 0, { roi: [0, 1, 2, 2] });
  assert.deepEqual(
    Array.from(r.channel.data),
    [0, 2, 4, 6, -1, 1, 3, 5, 20, 22, 24, 26],
  );
  assert.deepEqual(r.details.skipped_lines, [0, 2]);
  assert.equal(r.details.fits[0].count, 2);
  assert.deepEqual(r.details.fits[0].fit_index_bounds, [0, 2]);
});
test("nonfinite values and masks are preserved; too few fit samples reject without source mutation", () => {
  const c = channel((x, y) => 3 + x + y);
  c.data[0] = NaN;
  c.data[1] = Infinity;
  c.mask = new Uint8Array(c.data.length);
  c.mask[2] = 1;
  const before = structuredClone(c),
    r = operate(c);
  assert.ok(Number.isNaN(r.channel.data[0]));
  assert.equal(r.channel.data[1], Infinity);
  assert.deepEqual(r.channel.mask, c.mask);
  assert.deepEqual(c, before);
  const small = channel((x, y) => x + y, 4, 3, {
      xreal: 4,
      yreal: 3,
      xoff: 0,
      yoff: 0,
    }),
    saved = structuredClone(small);
  assert.throws(
    () => operate(small, "rows", 3, { roi: [0, 0, 2, 3] }),
    /Too few|underdetermined/,
  );
  assert.deepEqual(small, saved);
});
test("invalid axis and degree reject while omitted parameters retain documented defaults", () => {
  assert.deepEqual(normalizeOperation({ name: "line_polynomial" }), {
    name: "line_polynomial",
    params: { axis: "rows", degree: 1 },
  });
  for (const degree of [-1, 4, 1.5, NaN, Infinity, "1"])
    assert.throws(() =>
      normalizeOperation({ name: "line_polynomial", params: { degree } }),
    );
  for (const axis of ["x", "row", null, 1])
    assert.throws(() =>
      normalizeOperation({ name: "line_polynomial", params: { axis } }),
    );
});
test("centered fitting resolves represented small signals on large offsets and tiny physical units", () => {
  const high = channel((x, y) => 1e6 + 1e-8 * x * x + 2e-8 * y),
    r = operate(high, "rows", 2);
  // The stored samples themselves are quantized near 1e6: permit four input ULPs.
  for (const v of r.channel.data) near(v, 0, 4 * Number.EPSILON * 1e6);
  const tiny = channel(
    (x, y) => (4 + 2 * x - 0.1 * x * x + 0.01 * x * x * x + y) * 1e-20,
    9,
    6,
    { xreal: 9e-12, yreal: 3e-12, xoff: 1e-6, yoff: -1e-6 },
  );
  for (const v of operate(tiny, "rows", 3).channel.data) near(v, 0, 1e-32);
});
test("recipe JSON retains line parameters and exact replay identities; old engine identity rejects", async () => {
  const c = channel(
      (x, y) => (x * x + 3 * y + (x === 4 && y === 2 ? 5 : 0)) * 1e-9,
    ),
    source = {
      channels: { 0: c },
      sha256: "a".repeat(64),
      unsupported: [],
      warnings: [],
    },
    identity = "e".repeat(64);
  const result = await analyze(
      {
        file: "synthetic.gwy",
        channel: "0",
        operations: [
          { name: "line_polynomial", params: { axis: "rows", degree: 2 } },
        ],
      },
      source,
      null,
      identity,
    ),
    recipe = JSON.parse(JSON.stringify(result.recipe));
  assert.deepEqual(recipe.operations, [
    { name: "line_polynomial", params: { axis: "rows", degree: 2 } },
  ]);
  assert.ok(result.history[0].details.fits.every((f) => f.count === 9));
  const again = await replay(recipe, source, null, identity);
  assert.equal(again.replay_verified, true);
  assert.deepEqual(again.data, result.data);
  assert.deepEqual(again.recipe.output, recipe.output);
  await assert.rejects(
    replay(recipe, source, null, "old-engine"),
    /engine differs/,
  );
  const changed = structuredClone(recipe);
  changed.operations[0].params.degree = 1;
  await assert.rejects(
    replay(changed, source, null, identity),
    /Replay.*differs/,
  );
});

test("numerically rank-deficient clustered fit positions reject despite sufficient sample count", () => {
  // Four distinct abscissae, but three cluster within 0.5 ppm of the span end.
  const c = channel((x) => x * 1e-9, 4000001, 1);
  c.mask = new Uint8Array(c.width).fill(1);
  for (const x of [0, 1, 2, 4000000]) c.mask[x] = 0;
  const before = c.data.slice();
  assert.throws(() => operate(c, "rows", 3), /numerically underdetermined/);
  assert.deepEqual(c.data, before);
});
