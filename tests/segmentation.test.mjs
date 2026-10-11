import test from "node:test";
import assert from "node:assert/strict";
import { segmentSurface } from "../web/segmentation.js";
const channel = (width = 6, height = 5, fn = () => 0, extra = {}) => ({
  id: "0",
  title: "Height",
  width,
  height,
  shape: [height, width],
  xreal: width * 2,
  yreal: height * 3,
  xoff: 10,
  yoff: -4,
  xy_unit: "m",
  z_unit: "m",
  mask: null,
  warnings: [],
  data: Float64Array.from({ length: width * height }, (_, i) =>
    fn(i % width, Math.floor(i / width)),
  ),
  ...extra,
});
const seg = (c, options = {}) =>
  segmentSurface(c, { threshold: 1, ...options });

test("anisotropic offset rectangle has exact pixel area bounds centroid and excursion", () => {
  const c = channel(6, 5, (x, y) =>
      x >= 1 && x <= 3 && y >= 1 && y <= 2 ? x + y : 0,
    ),
    result = seg(c),
    r = result.regions[0];
  assert.equal(r.pixel_count, 6);
  assert.equal(r.area, 36);
  assert.equal(r.area_unit, "(m)²");
  assert.deepEqual(r.bbox_pixel, [1, 1, 4, 3]);
  assert.deepEqual(r.bbox, [12, -1, 18, 5]);
  assert.equal(r.width, 6);
  assert.equal(r.height, 6);
  assert.deepEqual(r.centroid, [15, 2]);
  assert.equal(r.min, 2);
  assert.equal(r.max, 5);
  assert.equal(r.mean, 3.5);
  assert.equal(r.excursion_height, 4);
  assert.equal(r.touches_image_boundary, false);
  assert.equal(r.touches_selection_boundary, false);
  assert.deepEqual(result.counts, {
    valid: 30,
    invalid: 0,
    threshold_pixels: 6,
    accepted_pixels: 6,
    candidate_regions: 1,
    accepted_regions: 1,
    excluded_regions: 0,
  });
});

test("four and eight connectivity distinguish diagonal components deterministically", () => {
  const c = channel(4, 4, (x, y) => (x === y ? 2 : 0));
  assert.equal(seg(c).regions.length, 4);
  assert.equal(seg(c, { connectivity: 8 }).regions.length, 1);
  assert.deepEqual(
    [...seg(c).labels],
    [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4],
  );
});

test("above and below include pixels exactly at threshold", () => {
  const c = channel(3, 1, (x) => [0, 1, 2][x]);
  const above = seg(c),
    below = seg(c, { direction: "below" });
  assert.deepEqual([...above.labels], [0, 1, 1]);
  assert.deepEqual([...below.labels], [1, 1, 0]);
  assert.equal(above.regions[0].excursion_height, 1);
  assert.equal(below.regions[0].excursion_height, 1);
});

test("invalid mask hole sets selection boundary and exclusion retains metrics", () => {
  const c = channel(5, 5, (x, y) =>
    x >= 1 && x <= 3 && y >= 1 && y <= 3 ? 2 : 0,
  );
  c.mask = new Uint8Array(25);
  c.mask[12] = 1;
  const included = seg(c),
    excluded = seg(c, { boundary: "exclude" });
  assert.equal(included.regions[0].pixel_count, 8);
  assert.equal(included.regions[0].touches_selection_boundary, true);
  assert.equal(included.regions[0].touches_image_boundary, false);
  assert.equal(excluded.regions.length, 0);
  assert.equal(excluded.excluded_regions[0].pixel_count, 8);
  assert.deepEqual(excluded.excluded_regions[0].excluded_reasons, [
    "selection_boundary",
  ]);
  assert.ok(excluded.labels.every((v) => v === 0));
});

test("ROI polygon and nonfinite exclusions define four-neighbor boundary independently of connectivity", () => {
  const c = channel(5, 5, () => 2),
    roi = [12, -1, 18, 8];
  const r = seg(c, { selection: { roi } }).regions[0];
  assert.equal(r.pixel_count, 9);
  assert.equal(r.touches_selection_boundary, true);
  assert.equal(r.touches_image_boundary, false);
  const polygon = [
    [14, 2],
    [16, 2],
    [16, 5],
    [14, 5],
  ];
  assert.equal(
    seg(c, { selection: { exclude_polygons: [polygon] } }).counts.invalid,
    1,
  );
  const d = channel(5, 5, (x, y) => (x === 2 && y === 2 ? 2 : 0));
  d.data[6] = NaN;
  assert.equal(
    seg(d, { connectivity: 8 }).regions[0].touches_selection_boundary,
    false,
  );
  d.data[7] = Infinity;
  assert.equal(
    seg(d, { connectivity: 8 }).regions[0].touches_selection_boundary,
    true,
  );
});

test("min size and boundary filters preserve original IDs with gaps", () => {
  const c = channel(7, 5, (x, y) =>
    (x === 0 && y === 0) || (y === 2 && (x === 2 || x === 3)) ? 2 : 0,
  );
  const result = seg(c, { min_pixels: 2, boundary: "exclude" });
  assert.equal(result.regions[0].id, 2);
  assert.equal(result.excluded_regions[0].id, 1);
  assert.deepEqual(result.excluded_regions[0].excluded_reasons, [
    "min_pixels",
    "image_boundary",
  ]);
  assert.equal(result.labels[0], 0);
  assert.equal(result.labels[16], 2);
});

test("nonfinite and masked pixels are invalid; all-invalid errors, no-foreground is valid", () => {
  const c = channel(3, 1, (x) => [NaN, Infinity, 2][x]);
  assert.equal(seg(c).counts.invalid, 2);
  c.mask = Uint8Array.from([0, 0, 1]);
  assert.throws(() => seg(c), /no valid pixels/);
  const empty = seg(channel());
  assert.equal(empty.regions.length, 0);
  assert.equal(empty.counts.candidate_regions, 0);
  assert.ok(empty.labels.every((v) => v === 0));
});

test("unknown and nonmeter units remain explicit and warn", () => {
  const c = channel(3, 3, () => 2, {
    xy_unit: null,
    z_unit: "V",
    warnings: ["Unverified source"],
  });
  const r = seg(c);
  assert.equal(r.regions[0].area_unit, null);
  assert.ok(r.warnings.includes("Unverified source"));
  assert.ok(r.warnings.some((w) => w.includes("Unknown units")));
  assert.ok(r.warnings.some((w) => w.includes("not an inferred")));
  assert.equal(
    seg(channel(2, 2, () => 2, { xy_unit: "nm" })).regions[0].area_unit,
    "(nm)²",
  );
});

test("unknown options missing thresholds and invalid settings reject", () => {
  const c = channel();
  for (const options of [
    {},
    { threshold: NaN },
    { threshold: Infinity },
    { threshold: 1, unexpected: true },
    { threshold: 1, direction: "auto" },
    { threshold: 1, connectivity: 6 },
    { threshold: 1, min_pixels: 0 },
    { threshold: 1, min_pixels: 1.5 },
    { threshold: 1, min_pixels: 4194305 },
    { threshold: 1, boundary: "maybe" },
    { threshold: 1, selection: { roi: [1, 1, 0, 0] } },
  ])
    assert.throws(() => segmentSurface(c, options));
  assert.throws(() => seg({ ...c, xreal: 0 }));
  assert.throws(() => seg({ ...c, width: 4194305, height: 1 }), /4194304/);
});

test("candidate limit errors explicitly even if size filters would discard all", () => {
  const c = channel(512, 257, (x, y) => ((x + y) % 2 === 0 ? 2 : 0));
  assert.throws(() => seg(c, { min_pixels: 2 }), /65536/);
});

test("source arrays parameters and masks are immutable and labeling repeats identically", () => {
  const c = channel(5, 5, (x, y) => ((x + y) % 3 ? 2 : 0));
  c.mask = new Uint8Array(25);
  c.mask[7] = 1;
  const data = c.data.slice(),
    mask = c.mask.slice(),
    options = { threshold: 1, selection: { roi: [10, -4, 20, 11] } };
  const first = segmentSurface(c, options),
    second = segmentSurface(c, options);
  assert.deepEqual(first, second);
  assert.deepEqual(c.data, data);
  assert.deepEqual(c.mask, mask);
  first.parameters.selection.roi[0] = 999;
  assert.equal(options.selection.roi[0], 10);
  first.labels[0] = 100;
  assert.deepEqual(c.data, data);
});

test("finite extreme values reject derived overflow instead of emitting nonfinite metrics", () => {
  assert.throws(
    () =>
      seg(
        channel(2, 2, () => 1e308),
        { threshold: -1e308 },
      ),
    RangeError,
  );
  assert.throws(
    () =>
      seg(
        channel(2, 2, () => -1e308),
        { threshold: 1e308, direction: "below" },
      ),
    RangeError,
  );
  assert.throws(
    () => seg(channel(2, 2, () => 2, { xreal: 1e308, yreal: 1e308 })),
    RangeError,
  );
  assert.throws(
    () => seg(channel(2, 2, () => 2, { xoff: 1e308, xreal: 1e308 })),
    RangeError,
  );
  const stable = seg(
    channel(2, 2, () => 1e308),
    { threshold: 1e308 },
  );
  assert.equal(stable.regions[0].mean, 1e308);
  assert.equal(stable.regions[0].excursion_height, 0);
  for (const extra of [
    { width: 1.5 },
    { data: new Float64Array(1) },
    { mask: new Uint8Array(1) },
    { xy_unit: undefined },
    { z_unit: 5 },
  ])
    assert.throws(() => seg(channel(2, 2, () => 2, extra)));
  for (const option of ["direction", "connectivity", "min_pixels", "boundary"])
    assert.throws(() => seg(channel(), { [option]: null }));
});

test("finite calibration that underflows pixel area is rejected", () => {
  assert.throws(
    () =>
      seg(
        channel(2, 2, () => 2, {
          xreal: 1e-300,
          yreal: 1e-300,
          xoff: 0,
          yoff: 0,
        }),
      ),
    /numeric range/,
  );
});
