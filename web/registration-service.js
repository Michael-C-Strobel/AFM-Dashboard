import { replay } from "./service.js";
import { registerSurfaces } from "./registration.js";
import { sha256 } from "./engine.js";
import { tar } from "./archive.js";
const names = ["registration.js", "registration-service.js", "engine.js"];
const hash = /^[a-f0-9]{64}$/;
function finiteJSON(value, ancestors = new Set(), depth = 0) {
  if (depth > 64)
    throw new Error("Registration JSON nesting exceeds 64 levels.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    throw new Error("Registration provenance requires finite plain JSON.");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && keys.length !== value.length + 1)
    throw new Error("Registration JSON requires dense ordinary arrays.");
  for (const key of keys) {
    if (typeof key === "symbol")
      throw new Error("Registration JSON cannot contain symbol keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value"))
      throw new Error("Registration JSON cannot contain accessors.");
    if (!descriptor.enumerable && !(Array.isArray(value) && key === "length"))
      throw new Error("Registration JSON cannot contain hidden properties.");
    if (
      Array.isArray(value) &&
      key !== "length" &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
    )
      throw new Error("Registration JSON requires ordinary array indices.");
    finiteJSON(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

const exact = (object, keys) =>
  object &&
  !Array.isArray(object) &&
  typeof object === "object" &&
  Object.keys(object).length === keys.length &&
  keys.every((key) => Object.hasOwn(object, key));
function channel(result, recipe) {
  if (
    recipe.source.channel !== String(result.channel.id) ||
    recipe.source.title !== result.channel.title
  )
    throw new Error(
      "Registration recipe channel or title differs from replayed channel.",
    );
  return {
    ...result.channel,
    width: result.channel.shape[1],
    height: result.channel.shape[0],
    data: Float64Array.from(result.data.flat(), (value) =>
      value === null ? NaN : value,
    ),
    mask: null,
  };
}
function axis(count, offset, pitch, unit) {
  return { start: offset + pitch / 2, step: pitch, count, unit };
}
function bins(length) {
  const n = Math.min(length, 256);
  return Array.from({ length: n }, (_, i) => [
    Math.floor((i * length) / n),
    Math.floor(((i + 1) * length) / n),
  ]);
}
function overview(data, valid, geometry) {
  const [height, width] = geometry.shape,
    xb = bins(width),
    yb = bins(height),
    values = [],
    counts = [];
  for (const [ys, ye] of yb)
    for (const [xs, xe] of xb) {
      let count = 0;
      for (let y = ys; y < ye; y++)
        for (let x = xs; x < xe; x++) if (valid[y * width + x]) count++;
      let mean = 0;
      if (count)
        for (let y = ys; y < ye; y++)
          for (let x = xs; x < xe; x++)
            if (valid[y * width + x]) mean += data[y * width + x] / count;
      values.push(count ? mean : null);
      counts.push(count);
    }
  return {
    width: xb.length,
    height: yb.length,
    x_bins: xb,
    y_bins: yb,
    x: xb.map(
      ([s, e]) => geometry.xoff + (((s + e) / 2) * geometry.xreal) / width,
    ),
    y: yb.map(
      ([s, e]) => geometry.yoff + (((s + e) / 2) * geometry.yreal) / height,
    ),
    data: values,
    valid_counts: counts,
    aggregation: "mean of common-valid pixels in recorded bins",
  };
}
async function raster(data, valid, geometry, file, mask = false) {
  const [height, width] = geometry.shape,
    size = width * height;
  if (data.length !== size || valid.length !== size)
    throw new Error("Registration output raster dimensions differ.");
  const bytes = new Uint8Array(size * (mask ? 1 : 8)),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < size; i++) {
    if (valid[i] !== 0 && valid[i] !== 1)
      throw new Error("Invalid registration common-valid mask.");
    if (mask) bytes[i] = valid[i];
    else if (valid[i]) {
      if (!Number.isFinite(data[i]))
        throw new Error("Nonfinite valid registration output.");
      view.setFloat64(i * 8, data[i], true);
    } else {
      view.setUint32(i * 8, 0, true);
      view.setUint32(i * 8 + 4, 0x7ff80000, true);
    }
  }
  return {
    bytes,
    metadata: {
      file,
      dtype: mask ? "uint8" : "float64-le",
      width,
      height,
      sha256: await sha256(bytes),
      unit: mask ? "dimensionless" : geometry.z_unit,
      x_axis: axis(
        width,
        geometry.xoff,
        geometry.xreal / width,
        geometry.xy_unit,
      ),
      y_axis: axis(
        height,
        geometry.yoff,
        geometry.yreal / height,
        geometry.xy_unit,
      ),
    },
  };
}
export async function registrationRecipe(
  request,
  fixedSource,
  movingSource,
  fixedReference,
  movingReference,
  engineIdentities,
  codeIdentity,
) {
  finiteJSON(request);
  finiteJSON(engineIdentities);
  finiteJSON(codeIdentity);
  if (!exact(request, ["fixed_recipe", "moving_recipe", "parameters"]))
    throw new Error(
      "Registration request requires exactly fixed_recipe, moving_recipe and parameters.",
    );
  if (
    !request.parameters ||
    typeof request.parameters !== "object" ||
    Array.isArray(request.parameters) ||
    Object.hasOwn(request.parameters, "fixed_selection") ||
    Object.hasOwn(request.parameters, "moving_selection")
  )
    throw new Error(
      "Registration selections are fixed by the captured recipes; overrides are forbidden.",
    );
  if (
    !exact(engineIdentities, ["fixed", "moving"]) ||
    !hash.test(engineIdentities.fixed) ||
    !hash.test(engineIdentities.moving)
  )
    throw new Error("Invalid registration replay engine identities.");
  if (
    !exact(codeIdentity, ["sha256", "files"]) ||
    !hash.test(codeIdentity.sha256) ||
    !Array.isArray(codeIdentity.files) ||
    codeIdentity.files.length !== names.length ||
    codeIdentity.files.some(
      (file, i) =>
        !exact(file, ["name", "sha256"]) ||
        file.name !== names[i] ||
        !hash.test(file.sha256),
    )
  )
    throw new Error("Invalid registration code identity or file order.");
  const saved = structuredClone(request),
    code = structuredClone(codeIdentity),
    engines = structuredClone(engineIdentities);
  const fixed = await replay(
    saved.fixed_recipe,
    fixedSource,
    fixedReference,
    engines.fixed,
  );
  const moving = await replay(
    saved.moving_recipe,
    movingSource,
    movingReference,
    engines.moving,
  );
  const result = registerSurfaces(
    channel(fixed, saved.fixed_recipe),
    channel(moving, saved.moving_recipe),
    {
      ...saved.parameters,
      fixed_selection: saved.fixed_recipe.selection,
      moving_selection: saved.moving_recipe.selection,
    },
  );
  const arrays = {},
    rasters = {};
  for (const [key, file] of [
    ["aligned", "aligned.f64"],
    ["difference", "difference.f64"],
    ["valid", "valid.u8"],
  ]) {
    const output = await raster(
      result[key],
      result.valid,
      result.fixed_geometry,
      file,
      key === "valid",
    );
    arrays[key] = output.metadata;
    rasters[key] = output.bytes;
  }
  const warnings = [...(result.warnings ?? [])];
  for (const [name, replayed, source] of [
    ["Fixed", fixed, fixedSource],
    ["Moving", moving, movingSource],
  ]) {
    for (const warning of [
      ...(source.warnings ?? []),
      ...(replayed.warnings ?? []),
      ...(replayed.channel.warnings ?? []),
    ])
      warnings.push(`${name}: ${warning}`);
    const support = replayed.channel.metadata?.["Import / support"];
    if (support !== undefined)
      warnings.push(
        `${name} imported support status: ${typeof support === "string" ? support : JSON.stringify(support)}. Replay does not certify calibration.`,
      );
  }
  const report = {
    schema_version: 1,
    kind: "translation_registration",
    algorithm: result.algorithm,
    input_recipes: { fixed: saved.fixed_recipe, moving: saved.moving_recipe },
    code,
    parameters: result.parameters,
    transform: result.transform,
    fixed_geometry: result.fixed_geometry,
    moving_geometry: result.moving_geometry,
    metrics: result.metrics,
    before: result.before,
    search: result.search,
    warnings: [...new Set(warnings)],
    overviews: {
      aligned: overview(result.aligned, result.valid, result.fixed_geometry),
      difference: overview(
        result.difference,
        result.valid,
        result.fixed_geometry,
      ),
    },
    arrays,
  };
  finiteJSON(report);
  report.report_sha256 = await sha256(
    new TextEncoder().encode(JSON.stringify(report)),
  );
  return { report, rasters };
}
export function registrationReadme() {
  return `AFM translation registration evidence

Both captured recipes are strictly replayed against their exact source bytes, reference inputs where recorded, engine identities, channel calibration and output hashes. Original source bytes are not included. Matching declared units and replay integrity do not certify calibration. Automatic transforms are proposals for review, not fitted subpixel precision.

Transform convention: fixed physical coordinate = moving physical coordinate + translation. Output remains on the fixed grid. Difference is fixed minus aligned moving; only common-valid pixels enter metrics. Read report.json for interpolation, selections, overlap, before metrics, search candidates and warnings.

aligned.f64 and difference.f64 are row-major little-endian IEEE754 float64 arrays with no header. Invalid cells are canonical quiet NaN (little-endian hex 000000000000f87f). valid.u8 has one byte per fixed pixel: 1 common-valid, 0 missing. Width/height, SHA256 and calibrated center axes are in report.json arrays. Axis coordinate = start + index*step. Overviews average only common-valid pixels in recorded half-open bins; valid_counts and null empty bins prevent missing values being silently treated as zero.

The report SHA256 is UTF8 JSON.stringify after removing report_sha256, retaining property order. Composite code SHA256 covers registration.js, registration-service.js and engine.js joined by one newline, in that order. Hashes are integrity checks, not signatures. Both original recipes retain their recorded timestamps; no export timestamp is introduced.

CLI: node scripts/register.mjs --fixed-recipe fixed-recipe.json --moving-recipe moving-recipe.json --fixed FIXED_SOURCE --moving MOVING_SOURCE --out NEW_DIRECTORY [recorded registration parameters]. Add --fixed-reference and --moving-reference when the recipes require them. Never overwrite original measurements.
`;
}
export function registrationBundle({ report, rasters }) {
  return tar({
    "report.json": JSON.stringify(report, null, 2) + "\n",
    "fixed-recipe.json":
      JSON.stringify(report.input_recipes.fixed, null, 2) + "\n",
    "moving-recipe.json":
      JSON.stringify(report.input_recipes.moving, null, 2) + "\n",
    "README.txt": registrationReadme(),
    "aligned.f64": rasters.aligned,
    "difference.f64": rasters.difference,
    "valid.u8": rasters.valid,
  });
}
