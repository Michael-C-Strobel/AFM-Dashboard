import test from "node:test";
import assert from "node:assert/strict";
import {
  createThreePointDraft,
  samplingFootprint,
} from "../web/three-point-draft.js";
const geometry = {
  shape: [3, 4],
  xreal: 8,
  yreal: 3,
  xoff: 10,
  yoff: -5,
  xy_unit: "m",
  z_unit: "m",
};
const context = () => ({
  source_key: "source:channel:crop",
  geometry: structuredClone(geometry),
});
test("draft captures physical points and radius without mutating snapshots or context", () => {
  const d = createThreePointDraft(),
    c = context();
  d.reset(c);
  c.geometry.xoff = 999;
  d.setPoint(0, [10, -5]);
  d.setPoint(1, [17, -5]);
  d.setPoint(2, [10, -3]);
  d.setRadius(2);
  const op = d.operation();
  assert.deepEqual(op, {
    name: "three_point",
    params: {
      points: [
        [10, -5],
        [17, -5],
        [10, -3],
      ],
      radius: 2,
    },
  });
  op.params.points[0][0] = 999;
  const s = d.snapshot();
  s.context.geometry.xoff = 999;
  s.points[1][0] = 999;
  assert.equal(d.operation().params.points[0][0], 10);
  assert.equal(d.snapshot().context.geometry.xoff, 10);
  d.reset(context());
  assert.deepEqual(d.snapshot().points, [null, null, null]);
  assert.equal(d.snapshot().radius, 1);
});
test("incomplete, upper bounds, duplicate, collinear and normalized near-singular points reject", () => {
  const d = createThreePointDraft();
  assert.throws(() => d.operation());
  d.reset(context());
  assert.throws(() => d.operation());
  for (const p of [
    [18, -4],
    [11, -2],
    [9, -4],
    [11, -6],
    [NaN, 0],
  ])
    assert.throws(() => d.setPoint(0, p));
  for (const index of [-1, 3, 0.5])
    assert.throws(() => d.setPoint(index, [10, -5]));
  for (const r of [0, 21, 1.5, NaN]) assert.throws(() => d.setRadius(r));
  d.setPoint(0, [10, -5]);
  d.setPoint(1, [10, -5]);
  d.setPoint(2, [12, -4]);
  assert.throws(() => d.operation());
  d.setPoint(1, [11, -4.5]);
  assert.throws(() => d.operation());
  d.setPoint(1, [17, -5]);
  d.setPoint(2, [12, -5 + 1e-13]);
  assert.throws(() => d.operation());
  d.setPoint(2, [12, -4]);
  assert.equal(d.operation().name, "three_point");
});
test("restore snapshots operations and rejects malformed or out-of-image points atomically", () => {
  const d = createThreePointDraft();
  const op = {
    name: "three_point",
    params: {
      points: [
        [10, -5],
        [17, -5],
        [10, -3],
      ],
      radius: 3,
    },
  };
  d.restore(op, context());
  op.params.points[0][0] = 0;
  assert.equal(d.snapshot().points[0][0], 10);
  const saved = d.snapshot();
  for (const bad of [
    { name: "mean" },
    {
      name: "three_point",
      params: {
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        radius: 1,
      },
    },
    { name: "three_point", params: { points: [[10, -5]], radius: 1 } },
  ])
    assert.throws(() => d.restore(bad, context()));
  assert.deepEqual(d.snapshot(), saved);
});
test("footprint uses non-square calibrated pixel edges and clipped engine disk", () => {
  assert.deepEqual(samplingFootprint([13, -3.5], 1, geometry), [
    { row: 1, column: 1, bounds: [12, -4, 14, -3] },
  ]);
  const clipped = samplingFootprint([10, -5], 2, geometry);
  assert.deepEqual(
    clipped.map((p) => [p.row, p.column]),
    [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ],
  );
  const interior = samplingFootprint([13, -3.5], 2, geometry);
  assert.equal(interior.length, 9);
  const large = { ...geometry, shape: [7, 7], xreal: 7, yreal: 7 };
  assert.equal(samplingFootprint([13.5, -1.5], 3, large).length, 21);
  const crop = {
    ...geometry,
    shape: [2, 2],
    xreal: 4,
    yreal: 2,
    xoff: 12,
    yoff: -4,
  };
  assert.deepEqual(
    samplingFootprint([12, -4], 1, crop)[0].bounds,
    [12, -4, 14, -3],
  );
  assert.throws(() => samplingFootprint([18, -3], 1, geometry));
});
test("descriptor validation rejects getters and invalid geometry without invocation", () => {
  let invoked = false;
  const bad = {
    get source_key() {
      invoked = true;
      return "x";
    },
    geometry,
  };
  const d = createThreePointDraft();
  assert.throws(() => d.reset(bad));
  assert.equal(invoked, false);
  for (const g of [
    { ...geometry, extra: true },
    { ...geometry, shape: [0, 2] },
    { ...geometry, xreal: 0 },
    { ...geometry, z_unit: 4 },
  ])
    assert.throws(() => d.reset({ source_key: "x", geometry: g }));
  const p = [10, -5];
  Object.defineProperty(p, 0, {
    get() {
      invoked = true;
      return 10;
    },
  });
  d.reset(context());
  assert.throws(() => d.setPoint(0, p));
  assert.equal(invoked, false);
});
