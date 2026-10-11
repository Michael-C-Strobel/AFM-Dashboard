import test from "node:test";
import assert from "node:assert/strict";
import { textureSurface } from "../web/texture.js";
const near = (a, b, t = 1e-10) =>
  assert.ok(
    Math.abs(a - b) <= t * Math.max(1, Math.abs(a), Math.abs(b)),
    `${a} != ${b}`,
  );
function channel(w = 3, h = 2, fn = (x, y) => x + 3 * y, extra = {}) {
  return {
    id: "0",
    title: "Synthetic",
    width: w,
    height: h,
    xreal: w * 2,
    yreal: h * 3,
    xoff: 7,
    yoff: -5,
    xy_unit: "m",
    z_unit: "m",
    data: Float64Array.from({ length: w * h }, (_, i) =>
      fn(i % w, Math.floor(i / w)),
    ),
    mask: null,
    warnings: [],
    metadata: {},
    log: [],
    ...extra,
  };
}
function directDFT(c, Kx, Ky, window) {
  const result = [];
  let S = 0;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const w =
        window === "hann"
          ? 0.25 *
            (1 - Math.cos((2 * Math.PI * x) / c.width)) *
            (1 - Math.cos((2 * Math.PI * y) / c.height))
          : 1;
      S += w * w;
    }
  for (let ky = 0; ky < Ky; ky++)
    for (let kx = 0; kx < Kx; kx++) {
      let re = 0,
        im = 0;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const w =
            window === "hann"
              ? 0.25 *
                (1 - Math.cos((2 * Math.PI * x) / c.width)) *
                (1 - Math.cos((2 * Math.PI * y) / c.height))
              : 1;
          const angle = -2 * Math.PI * ((kx * x) / Kx + (ky * y) / Ky),
            v = c.data[y * c.width + x] * w;
          re += v * Math.cos(angle);
          im += v * Math.sin(angle);
        }
      result.push(
        ((c.xreal / c.width) * (c.yreal / c.height) * (re * re + im * im)) / S,
      );
    }
  return result;
}
function directACF(c, m, n) {
  let sum = 0,
    count = 0;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const xx = x + m,
        yy = y + n;
      if (xx >= 0 && xx < c.width && yy >= 0 && yy < c.height) {
        sum += c.data[y * c.width + x] * c.data[yy * c.width + xx];
        count++;
      }
    }
  return sum / count;
}

test("nonsquare PSD and linear ACF match independent direct sums for both windows", () => {
  const c = channel();
  for (const window of ["boxcar", "hann"]) {
    const r = textureSurface(c, { detrend: "none", window }),
      Kx = r.psd.width,
      Ky = r.psd.height,
      direct = directDFT(c, Kx, Ky, window);
    for (let y = 0; y < Ky; y++)
      for (let x = 0; x < Kx; x++)
        near(
          r.psd.data[y * Kx + x],
          direct[((y + Ky / 2) % Ky) * Kx + ((x + Kx / 2) % Kx)],
        );
    for (let y = 0; y < r.acf.height; y++)
      for (let x = 0; x < r.acf.width; x++)
        near(
          r.acf.data[y * r.acf.width + x],
          directACF(c, x - c.width + 1, y - c.height + 1),
        );
    near(r.psd.integral, r.psd.expected_mean_square);
    near(r.acf.zero_lag, 55 / 6);
    near(r.acf.normalized[(c.height - 1) * r.acf.width + c.width - 1], 1);
  }
});
test("anisotropic sinusoidal bins retain two-sided calibrated frequency coordinates", () => {
  const c = channel(8, 4, (x) => Math.cos((2 * Math.PI * x) / 4));
  const r = textureSurface(c, { detrend: "none" }),
    zeroY = r.psd.fy.indexOf(0);
  const ix = r.psd.fx.indexOf(1 / 8),
    negative = r.psd.fx.indexOf(-1 / 8);
  assert.ok(ix >= 0 && negative >= 0);
  near(
    r.psd.data[zeroY * r.psd.width + ix],
    r.psd.data[zeroY * r.psd.width + negative],
  );
  near(r.psd.data[zeroY * r.psd.width + ix], 48);
  near(r.psd.integral, 0.5);
  assert.equal(r.sampling.dx, 2);
  assert.equal(r.sampling.dy, 3);
  assert.equal(r.sampling.frequency_unit, "cycles/(m)");
});
test("periodic Hann Parseval and constant mean detrending have explicit zero-energy behavior", () => {
  for (const window of ["boxcar", "hann"]) {
    const r = textureSurface(
      channel(5, 3, (x, y) => Math.sin(x) + y),
      { window },
    );
    near(r.psd.integral, r.psd.expected_mean_square);
  }
  const zero = textureSurface(channel(4, 3, () => 9));
  assert.equal(zero.acf.zero_lag, 0);
  assert.equal(zero.acf.normalized, null);
  assert.ok(zero.psd.data.every((v) => v === 0));
  assert.ok(zero.acf.data.every((v) => v === 0));
  assert.ok(zero.warnings.some((w) => /Zero-energy/.test(w)));
});
test("plane detrending and impulse covariance preserve estimator definitions", () => {
  const plane = textureSurface(
    channel(5, 4, (x, y) => 10 + 2 * x - 3 * y),
    { detrend: "plane" },
  );
  assert.ok(plane.psd.integral < 1e-22);
  assert.equal(plane.detrend_history[0].name, "plane");
  const c = channel(3, 3, (x, y) => (x === 1 && y === 1 ? 2 : 0)),
    r = textureSurface(c, { detrend: "none" });
  near(r.acf.zero_lag, 4 / 9);
  near(r.psd.integral, 4 / 9);
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 5; x++)
      near(r.acf.data[y * 5 + x], x === 2 && y === 2 ? 4 / 9 : 0);
});
test("selected rectangle records bounds calibration and does not mutate source or options", () => {
  const c = channel(5, 4),
    before = c.data.slice(),
    options = { selection: { roi: [9, -2, 15, 7] }, detrend: "none" };
  const saved = structuredClone(options),
    r = textureSurface(c, options);
  assert.deepEqual(r.source_bounds, [1, 1, 4, 4]);
  assert.deepEqual(r.geometry.shape, [3, 3]);
  assert.equal(r.geometry.xoff, 9);
  assert.equal(r.geometry.yoff, -2);
  assert.equal(r.geometry.xreal, 6);
  assert.equal(r.geometry.yreal, 9);
  assert.deepEqual(c.data, before);
  assert.deepEqual(options, saved);
});
test("internal masked nonfinite and polygon holes reject instead of filling", () => {
  const masked = channel(5, 5);
  masked.mask = new Uint8Array(25);
  masked.mask[12] = 1;
  assert.throws(() => textureSurface(masked), /internal mask/);
  const invalid = channel(5, 5);
  invalid.data[12] = NaN;
  assert.throws(() => textureSurface(invalid), /internal mask/);
  assert.throws(
    () =>
      textureSurface(channel(5, 5), {
        selection: {
          exclude_polygons: [
            [
              [11, 1],
              [13, 1],
              [13, 4],
              [11, 4],
            ],
          ],
        },
      }),
    /internal mask/,
  );
  assert.throws(() => textureSurface(channel(1, 4)), /at least 2/);
});
test("unknown units stay unknown without invented correlation lengths", () => {
  const r = textureSurface(
    channel(3, 2, undefined, { xy_unit: null, z_unit: null }),
  );
  assert.equal(r.psd.unit, null);
  assert.equal(r.acf.unit, null);
  assert.equal(r.sampling.frequency_unit, null);
  assert.ok(r.warnings.some((w) => /Unknown units/.test(w)));
  assert.equal(r.Sal, undefined);
});
test("strict options calibration array and allocation limits reject", () => {
  for (const options of [
    { unknown: 1 },
    { detrend: "median" },
    { window: "hamming" },
    [],
    { detrend: undefined },
  ])
    assert.throws(() => textureSurface(channel(), options));
  assert.throws(
    () =>
      textureSurface(channel(3, 2, undefined, { data: new Float32Array(6) })),
    /arrays/,
  );
  assert.throws(
    () => textureSurface(channel(3, 2, undefined, { xreal: 0 })),
    /calibration/,
  );
  assert.throws(() => textureSurface({ width: 4194305, height: 1 }), /4194304/);
  assert.throws(() => textureSurface(channel(1025, 513)), /zero-padding limit/);
  assert.throws(
    () => textureSurface(channel(2, 2, undefined, { xreal: Number.MIN_VALUE })),
    /underflow/,
  );
  assert.throws(
    () =>
      textureSurface(
        channel(2, 2, () => 1e200),
        { detrend: "none" },
      ),
    /overflow|finite|range/i,
  );
});

test("overlap-normalized off-zero ACF may exceed one without clamping", () => {
  const result = textureSurface(
    channel(3, 2, (x) => (x === 1 ? 0 : 1)),
    { detrend: "none" },
  );
  near(result.acf.normalized[result.acf.width + result.acf.width - 1], 1.5);
  assert.throws(
    () =>
      textureSurface(
        channel(2, 2, () => 1e-170),
        { detrend: "none" },
      ),
    /underflow/,
  );
});

test("nanometre amplitudes preserve independently calculated PSD and ACF at physical scale", () => {
  const c = channel(5, 3, (x, y) => 2e-9 * (Math.cos(x) + Math.sin(y)), {
    xreal: 5e-6,
    yreal: 9e-6,
  });
  const closeScaled = (actual, expected, scale) =>
    assert.ok(
      Math.abs(actual - expected) <= 2e-12 * scale,
      `${actual} differs from ${expected} at scale ${scale}`,
    );
  for (const window of ["boxcar", "hann"]) {
    const r = textureSurface(c, { detrend: "none", window });
    const expected = directDFT(c, r.psd.width, r.psd.height, window);
    const scale = Math.max(...expected);
    for (let y = 0; y < r.psd.height; y++)
      for (let x = 0; x < r.psd.width; x++) {
        const i =
          ((y + r.psd.height / 2) % r.psd.height) * r.psd.width +
          ((x + r.psd.width / 2) % r.psd.width);
        closeScaled(r.psd.data[y * r.psd.width + x], expected[i], scale);
      }
    const zero = directACF(c, 0, 0);
    for (let y = 0; y < r.acf.height; y++)
      for (let x = 0; x < r.acf.width; x++)
        closeScaled(
          r.acf.data[y * r.acf.width + x],
          directACF(c, x - c.width + 1, y - c.height + 1),
          zero,
        );
    closeScaled(r.psd.integral, r.psd.expected_mean_square, zero);
  }
});
