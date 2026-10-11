import test from "node:test";
import assert from "node:assert/strict";
import { fft2D } from "../web/fft.js";

function direct(real, imag, width, height, inverse = false) {
  const outR = new Float64Array(real.length),
    outI = new Float64Array(real.length),
    sign = inverse ? 1 : -1,
    scale = inverse ? 1 / real.length : 1;
  for (let ky = 0; ky < height; ky++)
    for (let kx = 0; kx < width; kx++) {
      let r = 0,
        v = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = y * width + x,
            angle = sign * 2 * Math.PI * ((kx * x) / width + (ky * y) / height),
            c = Math.cos(angle),
            s = Math.sin(angle),
            im = imag?.[i] ?? 0;
          r += real[i] * c - im * s;
          v += real[i] * s + im * c;
        }
      outR[ky * width + kx] = r * scale;
      outI[ky * width + kx] = v * scale;
    }
  return { real: outR, imag: outI };
}
function close(actual, expected, tolerance) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++)
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `index ${i}: ${actual[i]} vs ${expected[i]}, tolerance ${tolerance}`,
    );
}
function seeded(n, seed = 123456) {
  let state = seed >>> 0;
  return Float64Array.from({ length: n }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  });
}
function energy(real, imag = null) {
  let sum = 0,
    c = 0;
  for (let i = 0; i < real.length; i++) {
    const term = real[i] ** 2 + (imag?.[i] ?? 0) ** 2,
      y = term - c,
      t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}

for (const [width, height] of [
  [1, 1],
  [1, 8],
  [8, 1],
  [2, 4],
  [4, 8],
])
  test(`independent direct DFT agrees for ${width}×${height} real and complex inputs`, () => {
    const n = width * height,
      r = seeded(n),
      im = seeded(n, 987);
    for (const imag of [null, im])
      for (const inverse of [false, true]) {
        const expected = direct(r, imag, width, height, inverse),
          actual = fft2D(r, width, height, { imag, inverse });
        const tolerance = 128 * Number.EPSILON * n;
        close(actual.real, expected.real, tolerance);
        close(actual.imag, expected.imag, tolerance);
      }
  });

test("origin impulse has a unit flat spectrum, DC signal has only DC", () => {
  const impulse = new Float64Array(32);
  impulse[0] = 1;
  const spectrum = fft2D(impulse, 8, 4);
  close(spectrum.real, new Float64Array(32).fill(1), 0);
  close(spectrum.imag, new Float64Array(32), 0);
  const dc = fft2D(new Float64Array(32).fill(3), 8, 4),
    expected = new Float64Array(32);
  expected[0] = 96;
  close(dc.real, expected, 0);
  close(dc.imag, new Float64Array(32), 0);
});

test("2D complex sinusoid lands at positive frequency under negative forward sign", () => {
  const width = 8,
    height = 4,
    r = new Float64Array(32),
    im = new Float64Array(32);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const phase = 2 * Math.PI * ((2 * x) / width + y / height);
      r[y * width + x] = Math.cos(phase);
      im[y * width + x] = Math.sin(phase);
    }
  const f = fft2D(r, width, height, { imag: im }),
    expected = new Float64Array(32);
  expected[1 * width + 2] = 32;
  close(f.real, expected, 2e-13);
  close(f.imag, new Float64Array(32), 2e-13);
});

test("real sinusoid gives the conjugate pair on the expected row and column", () => {
  const width = 16,
    height = 8,
    r = Float64Array.from({ length: 128 }, (_, i) =>
      Math.sin(
        2 *
          Math.PI *
          ((3 * (i % width)) / width + (2 * Math.floor(i / width)) / height),
      ),
    );
  const f = fft2D(r, width, height),
    expected = new Float64Array(128);
  expected[2 * width + 3] = -64;
  expected[6 * width + 13] = 64;
  close(f.real, new Float64Array(128), 8e-13);
  close(f.imag, expected, 8e-13);
});

test("inverse roundtrip is scale-aware and leaves both inputs untouched", () => {
  for (const scale of [1e-100, 1, 1e100]) {
    const r = seeded(128).map((v) => v * scale),
      im = seeded(128, 789).map((v) => v * scale),
      savedR = r.slice(),
      savedI = im.slice();
    const f = fft2D(r, 16, 8, { imag: im }),
      savedF = f.real.slice(),
      back = fft2D(f.real, 16, 8, { imag: f.imag, inverse: true });
    close(back.real, r, scale * 2e-14);
    close(back.imag, im, scale * 2e-14);
    assert.deepEqual(r, savedR);
    assert.deepEqual(im, savedI);
    assert.deepEqual(f.real, savedF);
    assert.notEqual(f.real, r);
    assert.notEqual(f.imag, im);
  }
});

for (const [width, height] of [
  [4, 8],
  [256, 512],
])
  test(`Parseval holds for deterministic complex ${width}×${height} data`, () => {
    const n = width * height,
      r = seeded(n),
      im = seeded(n, 88),
      f = fft2D(r, width, height, { imag: im }),
      original = energy(r, im),
      spectral = energy(f.real, f.imag) / n;
    assert.ok(
      Math.abs(spectral - original) <= original * 2e-13,
      `${spectral} vs ${original}`,
    );
    const back = fft2D(f.real, width, height, { imag: f.imag, inverse: true });
    close(back.real, r, 2e-13);
    close(back.imag, im, 2e-13);
  });

test("invalid dimensions arrays options and nonfinite values reject", () => {
  const r = new Float64Array(8);
  for (const [w, h] of [
    [0, 8],
    [-1, 8],
    [3, 2],
    [2, 1.5],
    [Infinity, 1],
    [4096, 2048],
  ])
    assert.throws(() => fft2D(r, w, h));
  assert.throws(() => fft2D(new Float32Array(8), 4, 2));
  assert.throws(() => fft2D(r, 2, 2));
  assert.throws(() => fft2D(r, 4, 2, { imag: new Float64Array(7) }));
  for (const options of [
    { extra: 1 },
    { inverse: 1 },
    { inverse: null },
    { imag: [] },
    null,
  ])
    assert.throws(() => fft2D(r, 4, 2, options));
  for (const value of [NaN, Infinity, -Infinity]) {
    const invalid = r.slice();
    invalid[3] = value;
    assert.throws(() => fft2D(invalid, 4, 2), RangeError);
    assert.throws(() => fft2D(r, 4, 2, { imag: invalid }), RangeError);
  }
  let invoked = false;
  assert.throws(() =>
    fft2D(r, 4, 2, {
      get inverse() {
        invoked = true;
        return false;
      },
    }),
  );
  assert.equal(invoked, false);
  assert.throws(() => fft2D(r, 4, 2, { [Symbol("extra")]: 1 }));
});

test("finite input whose butterfly arithmetic overflows raises range error", () => {
  const r = new Float64Array([1e308, 1e308]);
  assert.throws(() => fft2D(r, 2, 1), RangeError);
  assert.throws(() => fft2D(r, 2, 1, { inverse: true }), RangeError);
  assert.deepEqual([...r], [1e308, 1e308]);
});
