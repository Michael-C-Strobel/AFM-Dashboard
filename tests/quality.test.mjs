import test from "node:test";
import assert from "node:assert/strict";
import { qualityReport, findTracePairs } from "../web/quality.js";
const fixture = (width = 9, height = 9, fn = () => 0) => ({
  id: "0",
  title: "Height_Trace",
  width,
  height,
  shape: [height, width],
  xreal: width,
  yreal: height,
  xoff: 0,
  yoff: 0,
  xy_unit: "m",
  z_unit: "m",
  mask: null,
  data: Float64Array.from({ length: width * height }, (_, i) =>
    fn(i % width, Math.floor(i / width)),
  ),
});

test("isolated row offset flags both boundaries without modifying data", () => {
  const c = fixture(9, 9, (_, y) => (y === 4 ? 10 : 0)),
    saved = c.data.slice(),
    report = qualityReport(c);
  assert.deepEqual(
    report.rows.candidates.map((c) => c.boundary_index),
    [4, 5],
  );
  assert.deepEqual(
    report.rows.candidates.map((c) => c.delta),
    [10, -10],
  );
  assert.equal(report.rows.center, 0);
  assert.equal(report.columns.candidates.length, 0);
  assert.deepEqual(c.data, saved);
  assert.equal(report.counts.selected, 81);
});

test("flat fields and linear ramps have no boundary candidates", () => {
  for (const c of [
    fixture(7, 9, () => 10),
    fixture(7, 9, (x, y) => 5 + 2 * x + 3 * y),
  ]) {
    const report = qualityReport(c);
    assert.deepEqual(report.rows.candidates, []);
    assert.deepEqual(report.columns.candidates, []);
  }
});

test("column offset stripe flags both sides and imported mask removes defect evidence", () => {
  const c = fixture(9, 7, (x) => (x === 4 ? 5 : 0));
  assert.deepEqual(
    qualityReport(c).columns.candidates.map((c) => c.boundary_index),
    [4, 5],
  );
  c.mask = Uint8Array.from(c.data, (_, i) => (i % 9 === 4 ? 1 : 0));
  const r = qualityReport(c);
  assert.equal(r.columns.medians[4], null);
  assert.deepEqual(r.columns.candidates, []);
  assert.equal(r.counts.imported_mask, 7);
});

test("ROI, polygon, imported masks and nonfinite pixels define selected counts", () => {
  const c = fixture(5, 5, () => 2);
  c.data[6] = NaN;
  c.data[7] = Infinity;
  c.mask = new Uint8Array(25);
  c.mask[8] = 1;
  const r = qualityReport(c, {
    selection: {
      roi: [1, 1, 4, 4],
      exclude_polygons: [
        [
          [1, 2],
          [2, 2],
          [2, 3],
          [1, 3],
        ],
      ],
    },
  });
  assert.deepEqual(r.counts, {
    total: 25,
    selected: 5,
    invalid: 2,
    imported_mask: 1,
    excluded: 20,
    selection_excluded_valid: 17,
  });
  assert.equal(r.rows.medians[0], null);
  assert.ok(r.rows.medians.slice(1, 4).every((v) => v === 2 || v === null));
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("no adjacent valid pair returns empty candidates and warnings", () => {
  const c = fixture(1, 1, () => 4),
    r = qualityReport(c);
  assert.deepEqual(r.rows.adjacent_differences, []);
  assert.deepEqual(r.rows.candidates, []);
  assert.equal(r.rows.threshold, null);
  assert.ok(r.warnings.some((w) => w.includes("No usable adjacent row")));
  c.data[0] = NaN;
  assert.equal(qualityReport(c).counts.selected, 0);
});

test("boundary_sigma controls the specified MAD threshold and rejects invalid settings", () => {
  const levels = [0, 1, 3, 6, 10, 15, 35],
    c = fixture(5, 7, (_, y) => levels[y]);
  const a = qualityReport(c, { boundary_sigma: 1 }),
    b = qualityReport(c, { boundary_sigma: 10 });
  assert.ok(a.rows.candidates.length > b.rows.candidates.length);
  assert.equal(a.rows.threshold, 1.4826 * a.rows.mad);
  for (const boundary_sigma of [0, -1, NaN, Infinity, "6"])
    assert.throws(() => qualityReport(c, { boundary_sigma }));
});

test("reference uses explicit input-minus-reference metrics with common valid pixels", () => {
  const a = fixture(4, 3, () => 5),
    b = fixture(4, 3, () => 3);
  b.mask = new Uint8Array(12);
  b.mask[0] = 1;
  const report = qualityReport(a, {}, b);
  assert.equal(report.comparison.rmse, 2);
  assert.equal(report.comparison.mean_difference, 2);
  assert.equal(report.comparison.valid_count, 11);
  assert.ok(!Object.hasOwn(report.comparison, "data"));
  assert.ok(!Object.hasOwn(report.comparison, "target"));
  for (const extra of [
    { z_unit: "V" },
    { xy_unit: "nm" },
    { xreal: 7 },
    { xoff: 1 },
    { width: 3 },
  ])
    assert.throws(() => qualityReport(a, {}, { ...b, ...extra }));
});

test("trace pairing requires unambiguous exact families and never matches distinct signals", () => {
  const channels = {
    0: { title: "Height_Trace" },
    1: { title: "height_RETRACE" },
    2: { title: "PhaseTrace" },
    3: { title: "PhaseRetrace" },
    4: { title: "HeightSensorTrace" },
  };
  assert.deepEqual(findTracePairs(channels), [
    { family: "height_", trace_id: "0", retrace_id: "1" },
    { family: "phase", trace_id: "2", retrace_id: "3" },
  ]);
  channels[5] = { title: "Height_TRACE" };
  assert.deepEqual(findTracePairs(channels), [
    { family: "phase", trace_id: "2", retrace_id: "3" },
  ]);
  assert.deepEqual(
    findTracePairs({
      0: { title: "HeightTrace" },
      1: { title: "HeightSensorRetrace" },
    }),
    [],
  );
  assert.deepEqual(
    findTracePairs({
      0: { title: "HeightTrace" },
      1: { title: "Height_Retrace" },
    }),
    [],
  );
});

test("import warnings and unknown units stay visible without implying height", () => {
  const c = fixture();
  c.z_unit = null;
  c.warnings = ["Unverified instrument configuration"];
  const reference = fixture();
  reference.z_unit = null;
  reference.warnings = ["Reference calibration unverified"];
  const report = qualityReport(c, {}, reference);
  assert.ok(report.warnings.includes("Unverified instrument configuration"));
  assert.ok(
    report.warnings.some((w) => w.includes("Reference calibration unverified")),
  );
  assert.ok(
    report.warnings.some((w) => w.includes("Unknown lateral or vertical unit")),
  );
  assert.equal(report.units.z, null);
  assert.equal(report.comparison.z_unit, null);
  assert.deepEqual(c.warnings, ["Unverified instrument configuration"]);
});
