import { replay } from "./service.js";
import { textureSurface } from "./texture.js";
import { sha256 } from "./engine.js";
import { tar } from "./archive.js";
const files = ["fft.js", "texture.js", "texture-service.js", "engine.js"];
const hash = /^[a-f0-9]{64}$/;
function finiteJSON(value, ancestors = new Set(), depth = 0) {
  if (depth > 64) throw new Error("Texture JSON nesting exceeds 64 levels.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    throw new Error("Texture provenance requires finite plain JSON.");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && keys.length !== value.length + 1)
    throw new Error("Texture JSON requires dense ordinary arrays.");
  for (const key of keys) {
    if (typeof key === "symbol")
      throw new Error("Texture JSON cannot contain symbol keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value"))
      throw new Error("Texture JSON cannot contain accessors.");
    if (!descriptor.enumerable && !(Array.isArray(value) && key === "length"))
      throw new Error("Texture JSON cannot contain hidden properties.");
    if (
      Array.isArray(value) &&
      key !== "length" &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
    )
      throw new Error("Texture JSON requires ordinary array indices.");
    finiteJSON(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

function bins(length, maximum) {
  const count = Math.min(length, maximum);
  return Array.from({ length: count }, (_, i) => [
    Math.floor((i * length) / count),
    Math.floor(((i + 1) * length) / count),
  ]);
}
function mean(values, start, end) {
  // Divide before summing to avoid overflow for finite high-dynamic-range values.
  let result = 0;
  for (let i = start; i < end; i++) result += values[i] / (end - start);
  return result;
}
function overview(data, width, height, x, y) {
  const xb = bins(width, 256),
    yb = bins(height, 256),
    values = [];
  for (const [ys, ye] of yb)
    for (const [xs, xe] of xb) {
      let sum = 0;
      const count = (ye - ys) * (xe - xs);
      for (let row = ys; row < ye; row++)
        for (let col = xs; col < xe; col++)
          sum += data[row * width + col] / count;
      values.push(sum);
    }
  return {
    width: xb.length,
    height: yb.length,
    x: xb.map(([s, e]) => mean(x, s, e)),
    y: yb.map(([s, e]) => mean(y, s, e)),
    data: values,
    aggregation: "arithmetic mean of recorded pixel bins",
    x_bins: xb,
    y_bins: yb,
  };
}
function cut(coordinates, values) {
  const ranges = bins(coordinates.length, 2048);
  return {
    coordinates: ranges.map(([s, e]) => mean(coordinates, s, e)),
    values: ranges.map(([s, e]) => mean(values, s, e)),
    bins: ranges,
    fixed_coordinate: 0,
  };
}
function cuts(data, width, height, x, y) {
  const row = Math.floor(height / 2),
    col = Math.floor(width / 2);
  return {
    x: cut(x, data.subarray(row * width, (row + 1) * width)),
    y: cut(
      y,
      Float64Array.from({ length: height }, (_, i) => data[i * width + col]),
    ),
  };
}
function axis(values, unit) {
  return {
    start: values[0],
    step: values[1] - values[0],
    count: values.length,
    unit,
  };
}
async function raster(data, width, height, x, y, unit, file) {
  if (
    !(data instanceof Float64Array) ||
    data.length !== width * height ||
    !data.every(Number.isFinite)
  )
    throw new Error("Invalid finite texture raster.");
  const bytes = new Uint8Array(data.length * 8),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < data.length; i++) view.setFloat64(i * 8, data[i], true);
  return {
    bytes,
    metadata: {
      file,
      dtype: "float64-le",
      width,
      height,
      sha256: await sha256(bytes),
      x_axis: axis(x, unit),
      y_axis: axis(y, unit),
    },
  };
}
/** Replay an immutable captured analysis, then measure its rectangular texture domain. */
export async function textureRecipe(
  request,
  source,
  reference,
  engineIdentity,
  codeIdentity,
) {
  finiteJSON(request);
  finiteJSON(codeIdentity);
  if (
    !request ||
    Array.isArray(request) ||
    Object.keys(request).length !== 2 ||
    !Object.hasOwn(request, "recipe") ||
    !Object.hasOwn(request, "parameters")
  )
    throw new Error("Texture request must contain only recipe and parameters.");
  if (
    !request.parameters ||
    typeof request.parameters !== "object" ||
    Array.isArray(request.parameters) ||
    Object.hasOwn(request.parameters, "selection")
  )
    throw new Error(
      "Texture selection is fixed by the input recipe; overrides are forbidden.",
    );
  if (
    !codeIdentity ||
    Object.keys(codeIdentity).length !== 2 ||
    !hash.test(codeIdentity.sha256 ?? "") ||
    !Array.isArray(codeIdentity.files) ||
    codeIdentity.files.length !== files.length ||
    codeIdentity.files.some(
      (f, i) =>
        !f ||
        Object.keys(f).length !== 2 ||
        f.name !== files[i] ||
        !hash.test(f.sha256 ?? ""),
    )
  )
    throw new Error("Invalid texture code identity or file order.");
  const { recipe: inputRecipe, parameters: options } = structuredClone(request),
    code = structuredClone(codeIdentity);
  const replayed = await replay(inputRecipe, source, reference, engineIdentity);
  if (
    inputRecipe.source.channel !== String(replayed.channel.id) ||
    inputRecipe.source.title !== replayed.channel.title
  )
    throw new Error(
      "Recipe source channel or title differs from replayed channel.",
    );
  const [height, width] = replayed.channel.shape;
  const result = textureSurface(
    {
      ...replayed.channel,
      width,
      height,
      data: Float64Array.from(replayed.data.flat(), (v) =>
        v === null ? NaN : v,
      ),
      mask: null,
    },
    { ...options, selection: inputRecipe.selection },
  );
  const p = result.psd,
    a = result.acf;
  const specs = {
    psd: [
      p.data,
      p.width,
      p.height,
      p.fx,
      p.fy,
      result.sampling.frequency_unit,
      "psd.f64",
    ],
    acf: [
      a.data,
      a.width,
      a.height,
      a.x_lags,
      a.y_lags,
      result.geometry.xy_unit,
      "acf.f64",
    ],
    acf_normalized:
      a.normalized === null
        ? null
        : [
            a.normalized,
            a.width,
            a.height,
            a.x_lags,
            a.y_lags,
            result.geometry.xy_unit,
            "acf_normalized.f64",
          ],
  };
  const arrays = {},
    rasters = {};
  for (const [key, spec] of Object.entries(specs)) {
    const exported = spec === null ? null : await raster(...spec);
    arrays[key] = exported?.metadata ?? null;
    rasters[key] = exported?.bytes ?? null;
  }
  const acfOverview = overview(a.data, a.width, a.height, a.x_lags, a.y_lags);
  const warnings = [
    ...new Set([
      ...(replayed.warnings ?? []),
      ...(replayed.channel.warnings ?? []),
      ...(source.warnings ?? []),
      ...result.warnings,
    ]),
  ];
  const support = replayed.channel.metadata?.["Import / support"];
  if (support !== undefined)
    warnings.push(
      `Imported support status: ${typeof support === "string" ? support : JSON.stringify(support)}. Replay does not certify calibration.`,
    );
  const report = {
    schema_version: 1,
    kind: "spatial_texture",
    algorithm: result.algorithm,
    input_recipe: inputRecipe,
    code,
    parameters: result.parameters,
    geometry: result.geometry,
    source_bounds: result.source_bounds,
    sampling: result.sampling,
    detrend_history: result.detrend_history,
    psd: {
      unit: p.unit,
      definition: p.definition,
      integral: p.integral,
      expected_mean_square: p.expected_mean_square,
      window_energy: p.window_energy,
      overview: overview(p.data, p.width, p.height, p.fx, p.fy),
      cuts: cuts(p.data, p.width, p.height, p.fx, p.fy),
    },
    acf: {
      unit: a.unit,
      definition: a.definition,
      zero_lag: a.zero_lag,
      overview: acfOverview,
      normalized_overview:
        a.normalized === null
          ? null
          : {
              ...acfOverview,
              data: acfOverview.data.map((v) => v / a.zero_lag),
            },
      cuts: cuts(a.data, a.width, a.height, a.x_lags, a.y_lags),
    },
    arrays,
    warnings: [...new Set(warnings)],
  };
  finiteJSON(report);
  report.report_sha256 = await sha256(
    new TextEncoder().encode(JSON.stringify(report)),
  );
  return { report, rasters };
}
export function textureReadme(report) {
  return `AFM Dashboard spatial texture evidence\n\nInput bytes are not included. Obtain the exact source and optional reference named in input-recipe.json and verify their SHA-256 values. Strict replay verifies source, engine, geometry and processed output before measurement. Replay is not calibration certification.\n\nEach .f64 file contains row-major IEEE-754 float64 values in little-endian byte order, without a header. Dimensions and value units are recorded in report.json; offset in bytes = 8 * (row * width + column). Axis coordinates = start + index * step using each array's x_axis and y_axis, including units. PSD frequencies are cycles per lateral unit; ACF axes are signed physical lags. Full normalized ACF is omitted when zero-lag energy is zero.\n\nPSD is two-sided window-energy-normalized density. ACF is linear, overlap-normalized, and computed from unwindowed residuals. Off-zero normalized ACF can exceed unity. JSON overviews and directional cuts average the explicit half-open pixel bins; they are reduced display products, not replacement numerical arrays.\n\nVerify each raster SHA-256 against arrays metadata. To verify report_sha256, parse report.json, remove its report_sha256 property and hash UTF-8 JSON.stringify of the remaining object in recorded property order. Code SHA-256 is UTF-8 source texts of fft.js, texture.js, texture-service.js, engine.js joined by one newline in that order; individual hashes are also recorded. Hashes are integrity checks, not digital signatures.\n\nReplay with matching code:\nnode scripts/texture.mjs --recipe input-recipe.json --input SOURCE_PATH --out NEW_DIRECTORY --detrend ${report.parameters.detrend} --window ${report.parameters.window}\nAdd --reference REFERENCE_PATH if the recipe records a reference. Original measurements are never overwritten.\n`;
}
export function textureBundle({ report, rasters }) {
  const entries = {
    "report.json": JSON.stringify(report, null, 2) + "\n",
    "input-recipe.json": JSON.stringify(report.input_recipe, null, 2) + "\n",
    "README.txt": textureReadme(report),
  };
  for (const key of ["psd", "acf", "acf_normalized"])
    if (report.arrays[key] !== null)
      entries[report.arrays[key].file] = rasters[key];
  return tar(entries);
}
