/** Calibrated two-sided PSD and linear overlap-normalized autocorrelation. */
import {
  geometry,
  normalizeSelection,
  validMask,
  runPipeline,
} from "./engine.js";
import { fft2D } from "./fft.js";
const LIMIT = 4194304;
const finite = (value) => {
  if (!Number.isFinite(value))
    throw new Error("Texture numerical overflow or invalid result.");
  return value;
};
const positive = (value) => {
  if (!(finite(value) > 0))
    throw new Error("Texture pitch or scaling underflow.");
  return value;
};
const square = (value) => {
  const result = finite(value * value);
  if (value !== 0 && result === 0)
    throw new Error("Texture squared amplitude underflow.");
  return result;
};
const pow2 = (n) => {
  let k = 1;
  while (k < n) k *= 2;
  return k;
};
function parameters(options) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw new Error("Texture options must be a plain object.");
  for (const key of Reflect.ownKeys(options)) {
    if (
      typeof key !== "string" ||
      !["detrend", "window", "selection"].includes(key)
    )
      throw new Error("Unknown texture option.");
    const d = Object.getOwnPropertyDescriptor(options, key);
    if (!d.enumerable || !Object.hasOwn(d, "value"))
      throw new Error("Texture options require plain values.");
  }
  const p = {
    detrend: Object.hasOwn(options, "detrend") ? options.detrend : "mean",
    window: Object.hasOwn(options, "window") ? options.window : "boxcar",
    selection: normalizeSelection(options.selection ?? {}),
  };
  if (
    !["none", "mean", "plane"].includes(p.detrend) ||
    !["boxcar", "hann"].includes(p.window)
  )
    throw new Error("Invalid texture detrending or window.");
  return p;
}
export function textureSurface(channel, options = {}) {
  const p = parameters(options),
    { width, height } = channel,
    size = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(size) ||
    size > LIMIT
  )
    throw new Error(
      "Texture image limit is 4194304 pixels with positive integer dimensions.",
    );
  if (
    !(channel.data instanceof Float64Array) ||
    channel.data.length !== size ||
    (channel.mask != null && channel.mask.length !== size)
  )
    throw new Error("Texture arrays must match image dimensions.");
  if (
    !["xreal", "yreal", "xoff", "yoff"].every((key) =>
      Number.isFinite(channel[key]),
    ) ||
    channel.xreal <= 0 ||
    channel.yreal <= 0
  )
    throw new Error("Texture requires valid physical calibration.");
  for (const key of ["xy_unit", "z_unit"])
    if (channel[key] !== null && typeof channel[key] !== "string")
      throw new Error("Texture units must be strings or null.");
  const dx = positive(channel.xreal / width),
    dy = positive(channel.yreal / height);
  const pixelArea = positive(dx * dy);
  const valid = validMask(channel, p.selection);
  let x0 = width,
    y0 = height,
    x1 = 0,
    y1 = 0;
  for (let i = 0; i < size; i++)
    if (valid[i]) {
      const x = i % width,
        y = Math.floor(i / width);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  const W = x1 - x0,
    H = y1 - y0;
  if (W < 2 || H < 2)
    throw new Error(
      "Texture requires a complete rectangle of at least 2 by 2 pixels.",
    );
  const Kx = pow2(2 * W - 1),
    Ky = pow2(2 * H - 1),
    fftSize = Kx * Ky;
  if (fftSize > LIMIT)
    throw new Error("Texture zero-padding limit is 4194304 FFT cells.");
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (!valid[y * width + x])
        throw new Error(
          "Texture selected rectangle contains invalid pixels or internal mask/polygon holes.",
        );
  const data = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    data.set(
      channel.data.subarray((y + y0) * width + x0, (y + y0) * width + x1),
      y * W,
    );
  const region = {
    ...channel,
    width: W,
    height: H,
    shape: [H, W],
    xreal: positive(W * dx),
    yreal: positive(H * dy),
    xoff: finite(channel.xoff + x0 * dx),
    yoff: finite(channel.yoff + y0 * dy),
    data,
    mask: null,
  };
  finite(region.xoff + region.xreal);
  finite(region.yoff + region.yreal);
  const detrended = runPipeline(
    region,
    p.detrend === "none" ? [] : [{ name: p.detrend, params: {} }],
  );
  const residual = detrended.channel.data;
  const unwindowed = new Float64Array(fftSize),
    windowed = new Float64Array(fftSize);
  let energy = 0,
    windowEnergy = 0,
    weightedEnergy = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const r = finite(residual[y * W + x]);
      const w =
        p.window === "boxcar"
          ? 1
          : 0.25 *
            (1 - Math.cos((2 * Math.PI * x) / W)) *
            (1 - Math.cos((2 * Math.PI * y) / H));
      const wr = finite(w * r);
      if (w !== 0 && r !== 0 && wr === 0)
        throw new Error("Texture windowed amplitude underflow.");
      unwindowed[y * Kx + x] = r;
      windowed[y * Kx + x] = wr;
      energy = finite(energy + square(r));
      weightedEnergy = finite(weightedEnergy + square(wr));
      windowEnergy = finite(windowEnergy + w * w);
    }
  positive(windowEnergy);
  const scale = positive(pixelArea / windowEnergy),
    dfx = positive(1 / positive(Kx * dx)),
    dfy = positive(1 / positive(Ky * dy)),
    binArea = positive(dfx * dfy);
  const spectrum = fft2D(windowed, Kx, Ky);
  const psd = new Float64Array(fftSize),
    fx = new Float64Array(Kx),
    fy = new Float64Array(Ky);
  let psdSum = 0;
  for (let x = 0; x < Kx; x++) fx[x] = finite((x - Kx / 2) * dfx);
  for (let y = 0; y < Ky; y++) fy[y] = finite((y - Ky / 2) * dfy);
  for (let y = 0; y < Ky; y++)
    for (let x = 0; x < Kx; x++) {
      const i = ((y + Ky / 2) % Ky) * Kx + ((x + Kx / 2) % Kx);
      const power = finite(square(spectrum.real[i]) + square(spectrum.imag[i]));
      const value = finite(scale * power);
      if (power !== 0 && value === 0)
        throw new Error("Texture PSD scaling underflow.");
      psd[y * Kx + x] = value;
      psdSum = finite(psdSum + value);
    }
  const rawSpectrum = fft2D(unwindowed, Kx, Ky);
  for (let i = 0; i < fftSize; i++)
    rawSpectrum.real[i] = finite(
      square(rawSpectrum.real[i]) + square(rawSpectrum.imag[i]),
    );
  const correlation = fft2D(rawSpectrum.real, Kx, Ky, { inverse: true });
  const Aw = 2 * W - 1,
    Ah = 2 * H - 1,
    acf = new Float64Array(Aw * Ah),
    normalized = energy === 0 ? null : new Float64Array(Aw * Ah);
  const zeroLag = finite(energy / (W * H));
  if (energy > 0) positive(zeroLag);
  const xLags = Float64Array.from({ length: Aw }, (_, i) =>
    finite((i - W + 1) * dx),
  );
  const yLags = Float64Array.from({ length: Ah }, (_, i) =>
    finite((i - H + 1) * dy),
  );
  for (let y = 0; y < Ah; y++)
    for (let x = 0; x < Aw; x++) {
      const m = x - W + 1,
        n = y - H + 1,
        i = y * Aw + x;
      const sum = correlation.real[((n + Ky) % Ky) * Kx + ((m + Kx) % Kx)];
      acf[i] = finite(sum / ((W - Math.abs(m)) * (H - Math.abs(n))));
      if (normalized) normalized[i] = finite(acf[i] / zeroLag);
    }
  const integral = finite(psdSum * binArea);
  const expectedMeanSquare = finite(weightedEnergy / windowEnergy);
  if (
    (psdSum !== 0 && integral === 0) ||
    (weightedEnergy !== 0 && expectedMeanSquare === 0)
  )
    throw new Error("Texture integrated scaling underflow.");
  const knownXY = !!channel.xy_unit,
    knownZ = !!channel.z_unit;
  const warnings = [...detrended.warnings, ...(channel.warnings ?? [])];
  if (!knownXY || !knownZ)
    warnings.push(
      "Unknown units: frequency, PSD or ACF units remain unknown where calibration units are missing.",
    );
  if (!normalized)
    warnings.push(
      "Zero-energy residual: normalized autocorrelation is undefined.",
    );
  return {
    schema_version: 1,
    algorithm: "spatial_texture_v1",
    parameters: p,
    geometry: geometry(region),
    source_bounds: [x0, y0, x1, y1],
    sampling: {
      dx,
      dy,
      fft_width: Kx,
      fft_height: Ky,
      dfx,
      dfy,
      frequency_unit: knownXY ? `cycles/(${channel.xy_unit})` : null,
    },
    detrend_history: detrended.history,
    psd: {
      width: Kx,
      height: Ky,
      fx,
      fy,
      data: psd,
      unit:
        knownXY && knownZ ? `(${channel.z_unit})²*(${channel.xy_unit})²` : null,
      integral,
      expected_mean_square: expectedMeanSquare,
      window_energy: windowEnergy,
      definition:
        "Two-sided dx*dy*abs(FFT(window*residual))²/sum(window²); periodic Hann or boxcar, zero padded and fftshifted.",
    },
    acf: {
      width: Aw,
      height: Ah,
      x_lags: xLags,
      y_lags: yLags,
      data: acf,
      normalized,
      unit: knownZ ? `(${channel.z_unit})²` : null,
      zero_lag: zeroLag,
      definition:
        "Unwindowed linear product sum divided by (W-|lag_x|)*(H-|lag_y|); normalized by zero-lag mean square without clamping.",
    },
    warnings: [...new Set(warnings)],
  };
}
