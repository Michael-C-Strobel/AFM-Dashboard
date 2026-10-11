/** Pure calibrated AFM operations. Arrays are never mutated in place. */
export const ENGINE_VERSION = "0.1.0";
export const SCHEMA_VERSION = 1;
const finite = Number.isFinite;
const fail = (message) => {
  throw new Error(message);
};
export function median(values) {
  if (!values.length) fail("No valid values.");
  const a = Array.from(values).sort((a, b) => a - b),
    m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function average(a) {
  let sum = 0,
    correction = 0;
  for (const v of a) {
    const y = v - correction,
      t = sum + y;
    correction = t - sum - y;
    sum = t;
  }
  return sum / a.length;
}
export function geometry(c) {
  return {
    shape: [c.height, c.width],
    xreal: c.xreal,
    yreal: c.yreal,
    xoff: c.xoff,
    yoff: c.yoff,
    xy_unit: c.xy_unit,
    z_unit: c.z_unit,
  };
}
function xy(c, i) {
  return [
    c.xoff + (((i % c.width) + 0.5) * c.xreal) / c.width,
    c.yoff + ((Math.floor(i / c.width) + 0.5) * c.yreal) / c.height,
  ];
}
function point(p) {
  if (!Array.isArray(p) || p.length !== 2 || !p.every(finite))
    fail("Expected a finite physical [x,y] point.");
  return p;
}
function bounds(b) {
  if (
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every(finite) ||
    b[0] >= b[2] ||
    b[1] >= b[3]
  )
    fail("Bounds must be [x0,y0,x1,y1] with positive area.");
  return b;
}
function inside(x, y, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}
export function normalizeSelection(s = {}) {
  if (s === null) s = {};
  if (typeof s !== "object" || Array.isArray(s)) fail("Invalid selection.");
  for (const k of Object.keys(s))
    if (!["roi", "exclude_polygons"].includes(k))
      fail(`Unknown selection field: ${k}`);
  const roi = s.roi == null ? null : bounds(s.roi).slice();
  const polygons = s.exclude_polygons ?? [];
  if (!Array.isArray(polygons) || polygons.length > 32)
    fail("At most 32 exclusion polygons are supported.");
  for (const p of polygons) {
    if (!Array.isArray(p) || p.length < 3 || p.length > 256)
      fail("A polygon needs 3–256 points.");
    p.forEach(point);
  }
  return { roi, exclude_polygons: structuredClone(polygons) };
}
export function validMask(c, selection = {}) {
  const s = normalizeSelection(selection),
    mask = new Uint8Array(c.data.length);
  for (let i = 0; i < mask.length; i++) {
    if (!finite(c.data[i]) || c.mask?.[i]) continue;
    const [x, y] = xy(c, i);
    if (s.roi && (x < s.roi[0] || x > s.roi[2] || y < s.roi[1] || y > s.roi[3]))
      continue;
    if (s.exclude_polygons.some((p) => inside(x, y, p))) continue;
    mask[i] = 1;
  }
  return mask;
}
function selected(c, m) {
  const a = [];
  for (let i = 0; i < m.length; i++) if (m[i]) a.push(c.data[i]);
  if (!a.length) fail("Selection contains no valid pixels.");
  return a;
}
export function statistics(c, selection = {}) {
  const values = selected(c, validMask(c, selection)),
    mean = average(values);
  let abs = 0,
    sq = 0,
    min = Infinity,
    max = -Infinity;
  for (const v of values) {
    abs += Math.abs(v - mean);
    sq += (v - mean) ** 2;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const bins = max === min ? 1 : 32,
    counts = Array(bins).fill(0),
    edges = Array.from(
      { length: bins + 1 },
      (_, i) => min + ((max - min) * i) / bins,
    );
  for (const v of values)
    counts[
      max === min
        ? 0
        : Math.min(bins - 1, Math.floor(((v - min) / (max - min)) * bins))
    ]++;
  return {
    histogram: { edges, counts },
    sa: abs / values.length,
    sq: Math.sqrt(sq / values.length),
    min,
    max,
    mean,
    peak_to_valley: max - min,
    valid_count: values.length,
    excluded_count: c.data.length - values.length,
    area: (((values.length * c.xreal) / c.width) * c.yreal) / c.height,
    z_unit: c.z_unit,
    xy_unit: c.xy_unit,
    reference: "selected arithmetic mean",
    area_unit: c.xy_unit === null ? null : `(${c.xy_unit})²`,
  };
}
function solve(a, b) {
  const n = b.length,
    m = a.map((row, i) => [...row, b[i]]),
    scale = Math.max(...a.flat().map(Math.abs));
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++)
      if (Math.abs(m[i][k]) > Math.abs(m[pivot][k])) pivot = i;
    if (Math.abs(m[pivot][k]) < scale * 1e-12)
      fail("Fit is underdetermined: choose a larger, non-collinear region.");
    [m[k], m[pivot]] = [m[pivot], m[k]];
    const d = m[k][k];
    for (let j = k; j <= n; j++) m[k][j] /= d;
    for (let i = 0; i < n; i++)
      if (i !== k) {
        const f = m[i][k];
        for (let j = k; j <= n; j++) m[i][j] -= f * m[k][j];
      }
  }
  return m.map((row) => row[n]);
}
function basis(c, i, degree) {
  const x = (2 * ((i % c.width) + 0.5)) / c.width - 1,
    y = (2 * (Math.floor(i / c.width) + 0.5)) / c.height - 1;
  return degree === 2 ? [1, x, y, x * x, x * y, y * y] : [1, x, y];
}
function fit(c, mask, degree = 1) {
  const values = selected(c, mask),
    origin = average(values),
    n = degree === 2 ? 6 : 3;
  if (values.length < n) fail("Too few pixels for the requested surface fit.");
  const a = Array.from({ length: n }, () => Array(n).fill(0)),
    b = Array(n).fill(0);
  for (let i = 0; i < c.data.length; i++)
    if (mask[i]) {
      const v = basis(c, i, degree),
        z = c.data[i] - origin;
      for (let j = 0; j < n; j++) {
        b[j] += v[j] * z;
        for (let k = 0; k < n; k++) a[j][k] += v[j] * v[k];
      }
    }
  return { coefficients: solve(a, b), origin, degree };
}
function prediction(c, i, f) {
  return basis(c, i, f.degree).reduce(
    (s, v, j) => s + v * f.coefficients[j],
    0,
  );
}
const SPECS = {
  mean: {},
  plane: {},
  zero_min: {},
  polynomial: { degree: 2 },
  robust_plane: { iterations: 5, sigma: 3 },
  three_point: { points: null, radius: 1 },
  line_median: { axis: "rows" },
  line_match: { axis: "rows" },
  gaussian: { sigma: 1 },
  crop: { bounds: null },
};
export function operationRegistry() {
  return Object.entries(SPECS).map(([name, defaults]) => ({
    name,
    version: 1,
    defaults,
  }));
}
export function normalizeOperation(op) {
  if (!op || typeof op !== "object" || !Object.hasOwn(SPECS, op.name))
    fail(`Unknown operation: ${op?.name}`);
  if (Object.keys(op).some((k) => !["name", "params"].includes(k)))
    fail("Unknown operation field.");
  const supplied = op.params ?? {};
  if (typeof supplied !== "object" || Array.isArray(supplied))
    fail("Operation parameters must be an object.");
  const defaults = SPECS[op.name];
  for (const k of Object.keys(supplied))
    if (!Object.hasOwn(defaults, k)) fail(`Unknown ${op.name} parameter: ${k}`);
  const p = { ...defaults, ...supplied };
  if ("axis" in p && !["rows", "columns"].includes(p.axis))
    fail("Axis must be rows or columns.");
  if (op.name === "polynomial" && p.degree !== 2)
    fail("Only degree 2 polynomial surfaces are supported.");
  if (
    op.name === "robust_plane" &&
    (!Number.isInteger(p.iterations) ||
      p.iterations < 1 ||
      p.iterations > 20 ||
      !finite(p.sigma) ||
      p.sigma < 1 ||
      p.sigma > 10)
  )
    fail("Invalid robust plane settings.");
  if (
    op.name === "gaussian" &&
    (!finite(p.sigma) || p.sigma <= 0 || p.sigma > 10)
  )
    fail("Gaussian sigma must be > 0 and <= 10 pixels.");
  if (op.name === "crop") bounds(p.bounds);
  if (op.name === "three_point") {
    if (!Array.isArray(p.points) || p.points.length !== 3)
      fail("Three-point leveling requires exactly three points.");
    p.points.forEach(point);
    if (!Number.isInteger(p.radius) || p.radius < 1 || p.radius > 20)
      fail("Point radius must be 1–20 pixels.");
  }
  return { name: op.name, params: structuredClone(p) };
}
export function applyOperation(input, operation, selection = {}) {
  const op = normalizeOperation(operation),
    p = op.params,
    c = {
      ...input,
      data: input.data.slice(),
      mask: input.mask?.slice() ?? null,
    },
    m = validMask(c, selection),
    details = {};
  selected(c, m);
  if (["plane", "polynomial", "robust_plane"].includes(op.name)) {
    let fm = m.slice(),
      f = fit(c, fm, op.name === "polynomial" ? 2 : 1);
    if (op.name === "robust_plane")
      for (let iteration = 0; iteration < p.iterations; iteration++) {
        const residual = [];
        for (let i = 0; i < fm.length; i++)
          if (fm[i]) residual.push(c.data[i] - f.origin - prediction(c, i, f));
        const med = median(residual),
          mad = median(residual.map((v) => Math.abs(v - med))),
          scale = 1.4826 * mad;
        if (scale <= Number.EPSILON * Math.max(Math.abs(f.origin), 1e-30) * 16)
          break;
        const next = new Uint8Array(m.length);
        let changed = false;
        for (let i = 0; i < m.length; i++)
          if (m[i]) {
            next[i] =
              Math.abs(c.data[i] - f.origin - prediction(c, i, f) - med) <=
              p.sigma * scale
                ? 1
                : 0;
            if (next[i] !== fm[i]) changed = true;
          }
        f = fit(c, next);
        fm = next;
        if (!changed) break;
      }
    for (let i = 0; i < c.data.length; i++)
      c.data[i] = c.data[i] - f.origin - prediction(c, i, f);
    Object.assign(details, f, {
      fit_pixel_count: fm.reduce((a, b) => a + b, 0),
      coordinate_basis: "x,y normalized to [-1,1] at pixel centres",
    });
  } else if (op.name === "mean" || op.name === "zero_min") {
    const values = selected(c, m),
      value =
        op.name === "mean"
          ? average(values)
          : values.reduce((a, b) => Math.min(a, b), Infinity);
    for (let i = 0; i < c.data.length; i++) c.data[i] -= value;
    details.offset = value;
  } else if (op.name === "three_point") {
    const rows = [],
      z = [];
    for (const [x, y] of p.points) {
      const col = Math.floor(((x - c.xoff) / c.xreal) * c.width),
        row = Math.floor(((y - c.yoff) / c.yreal) * c.height);
      if (col < 0 || col >= c.width || row < 0 || row >= c.height)
        fail("Leveling point is outside the image.");
      const values = [];
      // Gwyddion radius=1 samples the selected pixel; larger radii use a disk.
      for (let dy = 1 - p.radius; dy < p.radius; dy++)
        for (let dx = 1 - p.radius; dx < p.radius; dx++) {
          const xx = col + dx,
            yy = row + dy;
          if (
            dx * dx + dy * dy > (p.radius - 0.5) ** 2 ||
            xx < 0 ||
            xx >= c.width ||
            yy < 0 ||
            yy >= c.height
          )
            continue;
          const i = yy * c.width + xx;
          if (m[i]) values.push(c.data[i]);
        }
      if (!values.length)
        fail("A leveling point has no valid pixels inside the selection.");
      rows.push([
        1,
        (2 * (x - c.xoff)) / c.xreal - 1,
        (2 * (y - c.yoff)) / c.yreal - 1,
      ]);
      z.push(average(values));
    }
    const origin = average(z),
      coefficients = solve(
        rows,
        z.map((v) => v - origin),
      );
    const f = { degree: 1, origin, coefficients };
    for (let i = 0; i < c.data.length; i++)
      c.data[i] = c.data[i] - origin - prediction(c, i, f);
    Object.assign(details, f, { point_heights: z });
  } else if (op.name === "line_median" || op.name === "line_match") {
    const rows = p.axis === "rows",
      lines = rows ? c.height : c.width,
      length = rows ? c.width : c.height,
      idx = (line, j) => (rows ? line * c.width + j : j * c.width + line);
    const offsets = Array(lines).fill(0),
      skipped = [];
    for (let line = 0; line < lines; line++) {
      const values = [];
      for (let j = 0; j < length; j++) {
        const i = idx(line, j);
        if (!m[i]) continue;
        if (op.name === "line_match") {
          if (line && m[idx(line - 1, j)])
            values.push(input.data[i] - input.data[idx(line - 1, j)]);
        } else values.push(input.data[i]);
      }
      if (op.name === "line_match" && line === 0) continue;
      if (!values.length) {
        skipped.push(line);
        offsets[line] = line ? offsets[line - 1] : 0;
        continue;
      }
      offsets[line] =
        (op.name === "line_match" && line ? offsets[line - 1] : 0) +
        median(values);
    }
    const center = median(offsets);
    for (let line = 0; line < lines; line++)
      for (let j = 0; j < length; j++)
        c.data[idx(line, j)] -= offsets[line] - center;
    Object.assign(details, { offsets, skipped_lines: skipped });
  } else if (op.name === "gaussian") {
    const radius = Math.ceil(3 * p.sigma),
      weights = Array.from({ length: 2 * radius + 1 }, (_, j) =>
        Math.exp(-0.5 * ((j - radius) / p.sigma) ** 2),
      );
    // Normalized convolution excludes imported masks, drawn exclusions and nonfinite pixels; ROI does not truncate the filter kernel.
    const included = validMask(c, {
      exclude_polygons: selection.exclude_polygons ?? [],
    });
    let num = Float64Array.from(c.data, (v, i) => (included[i] ? v : 0)),
      den = Float64Array.from(c.data, (v, i) => (included[i] ? 1 : 0));
    for (const horizontal of [true, false]) {
      const n = new Float64Array(num.length),
        d = new Float64Array(num.length);
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const i = y * c.width + x;
          for (let k = -radius; k <= radius; k++) {
            const xx = Math.min(
                c.width - 1,
                Math.max(0, x + (horizontal ? k : 0)),
              ),
              yy = Math.min(
                c.height - 1,
                Math.max(0, y + (horizontal ? 0 : k)),
              ),
              j = yy * c.width + xx,
              w = weights[k + radius];
            n[i] += w * num[j];
            d[i] += w * den[j];
          }
        }
      num = n;
      den = d;
    }
    for (let i = 0; i < c.data.length; i++)
      c.data[i] = included[i] && den[i] ? num[i] / den[i] : NaN;
    details.boundary = "nearest pixel";
    details.sigma_unit = "pixels";
  } else if (op.name === "crop") {
    const b = p.bounds,
      dx = c.xreal / c.width,
      dy = c.yreal / c.height;
    const x0 = Math.max(0, Math.ceil((b[0] - c.xoff) / dx - 0.5)),
      x1 = Math.min(c.width, Math.floor((b[2] - c.xoff) / dx - 0.5) + 1),
      y0 = Math.max(0, Math.ceil((b[1] - c.yoff) / dy - 0.5)),
      y1 = Math.min(c.height, Math.floor((b[3] - c.yoff) / dy - 0.5) + 1);
    if (x1 <= x0 || y1 <= y0) fail("Crop does not include pixel centres.");
    const width = x1 - x0,
      height = y1 - y0,
      data = new Float64Array(width * height),
      mask = c.mask ? new Uint8Array(width * height) : null;
    for (let y = 0; y < height; y++) {
      data.set(
        c.data.subarray((y + y0) * c.width + x0, (y + y0) * c.width + x1),
        y * width,
      );
      if (mask)
        mask.set(
          c.mask.subarray((y + y0) * c.width + x0, (y + y0) * c.width + x1),
          y * width,
        );
    }
    Object.assign(c, {
      data,
      mask,
      width,
      height,
      shape: [height, width],
      xreal: width * dx,
      yreal: height * dy,
      xoff: c.xoff + x0 * dx,
      yoff: c.yoff + y0 * dy,
    });
    details.pixel_bounds = [x0, y0, x1, y1];
  }
  return { channel: c, operation: op, details };
}
export function profile(c, points, selection = {}) {
  if (!Array.isArray(points) || points.length !== 2)
    fail("A profile requires two endpoints.");
  points.forEach(point);
  const [a, b] = points,
    dx = c.xreal / c.width,
    dy = c.yreal / c.height;
  for (const [x, y] of points)
    if (
      x < c.xoff ||
      x > c.xoff + c.xreal ||
      y < c.yoff ||
      y > c.yoff + c.yreal
    )
      fail("Profile endpoint is outside the image.");
  const n = Math.min(
      4096,
      Math.max(
        2,
        Math.ceil(Math.hypot((b[0] - a[0]) / dx, (b[1] - a[1]) / dy)) + 1,
      ),
    ),
    distance = [],
    height = [],
    mask = validMask(c, selection),
    length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (let j = 0; j < n; j++) {
    const t = j / (n - 1),
      x = Math.min(
        c.width - 1,
        Math.max(0, (a[0] + t * (b[0] - a[0]) - c.xoff) / dx - 0.5),
      ),
      y = Math.min(
        c.height - 1,
        Math.max(0, (a[1] + t * (b[1] - a[1]) - c.yoff) / dy - 0.5),
      ),
      x0 = Math.floor(x),
      y0 = Math.floor(y),
      x1 = Math.min(x0 + 1, c.width - 1),
      y1 = Math.min(y0 + 1, c.height - 1),
      fx = x - x0,
      fy = y - y0;
    let v = 0,
      ok = true;
    for (const [i, w] of [
      [y0 * c.width + x0, (1 - fx) * (1 - fy)],
      [y0 * c.width + x1, fx * (1 - fy)],
      [y1 * c.width + x0, (1 - fx) * fy],
      [y1 * c.width + x1, fx * fy],
    ])
      if (w > 0) {
        if (!mask[i]) ok = false;
        else v += w * c.data[i];
      }
    distance.push(t * length);
    height.push(ok ? v : null);
  }
  return {
    distance,
    height,
    xy_unit: c.xy_unit,
    z_unit: c.z_unit,
    interpolation: "bilinear; edge pixels clamped; excluded samples null",
  };
}
export function compare(c, target, selection = {}) {
  if (
    c.width !== target.width ||
    c.height !== target.height ||
    c.xy_unit !== target.xy_unit ||
    c.z_unit !== target.z_unit
  )
    fail("Reference must have matching shape and units.");
  for (const k of ["xreal", "yreal", "xoff", "yoff"])
    if (
      Math.abs(c[k] - target[k]) >
      1e-12 * Math.max(Math.abs(c[k]), Math.abs(target[k]), c.xreal, c.yreal)
    )
      fail(
        "Reference must have matching physical calibration; registration is not implicit.",
      );
  const a = validMask(c, selection),
    b = validMask(target, selection),
    data = new Float64Array(c.data.length).fill(NaN);
  let n = 0,
    sq = 0,
    abs = 0,
    sum = 0,
    max = 0;
  for (let i = 0; i < a.length; i++)
    if (a[i] && b[i]) {
      const d = c.data[i] - target.data[i];
      data[i] = d;
      n++;
      sq += d * d;
      abs += Math.abs(d);
      sum += d;
      max = Math.max(max, Math.abs(d));
    }
  if (!n) fail("No common valid pixels for comparison.");
  return {
    rmse: Math.sqrt(sq / n),
    mae: abs / n,
    max_abs: max,
    mean_difference: sum / n,
    valid_count: n,
    data,
    target: target.data,
    definition: "processed minus reference; common valid selection only",
  };
}
export function runPipeline(source, operations = [], selection = {}) {
  if (!Array.isArray(operations) || operations.length > 32)
    fail("A recipe supports at most 32 operations.");
  const s = normalizeSelection(selection);
  let c = {
      ...source,
      data: source.data.slice(),
      mask: source.mask?.slice() ?? null,
    },
    history = [];
  for (const op of operations) {
    const result = applyOperation(c, op, s);
    c = result.channel;
    history.push({ ...result.operation, version: 1, details: result.details });
  }
  const nonfinite = c.data.reduce((n, v) => n + (!finite(v) ? 1 : 0), 0),
    warnings = [...(source.warnings ?? [])];
  if (c.z_unit !== "m")
    warnings.push(
      "Vertical units are not metres; interpret statistics in the stored units, not as topographic heights.",
    );
  if (nonfinite) warnings.push(`${nonfinite} nonfinite pixels are excluded.`);
  if (history.some((h) => h.details.skipped_lines?.length))
    warnings.push(
      "Some scan lines lacked fit pixels; inspect skipped_lines in operation history.",
    );
  return {
    channel: c,
    history,
    statistics: statistics(c, s),
    quality: { nonfinite_count: nonfinite, warnings },
    warnings,
  };
}
export async function sha256(bytes) {
  const view =
    bytes instanceof ArrayBuffer
      ? bytes
      : bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function arrayHash(data) {
  const bytes = new ArrayBuffer(data.length * 8),
    view = new DataView(bytes);
  for (let i = 0; i < data.length; i++) {
    if (Number.isNaN(data[i]))
      view.setBigUint64(i * 8, 0x7ff8000000000000n, true);
    else view.setFloat64(i * 8, data[i], true);
  }
  return sha256(bytes);
}

/** Difference of plateau means, with descriptive population spread. */
export function stepHeight(c, plateaus, selection = {}) {
  if (!Array.isArray(plateaus) || plateaus.length !== 2)
    fail("Choose two plateau rectangles.");
  const [a, b] = plateaus.map(bounds);
  if (
    Math.max(a[0], b[0]) < Math.min(a[2], b[2]) &&
    Math.max(a[1], b[1]) < Math.min(a[3], b[3])
  )
    fail("Plateau rectangles must not overlap.");
  const measure = (roi) => {
    const values = selected(
        c,
        validMask(c, {
          roi,
          exclude_polygons: selection.exclude_polygons ?? [],
        }),
      ),
      mean = average(values);
    let sum = 0;
    for (const v of values) sum += (v - mean) ** 2;
    return { mean, sd: Math.sqrt(sum / values.length), count: values.length };
  };
  const plateau_a = measure(a),
    plateau_b = measure(b);
  return {
    height: plateau_b.mean - plateau_a.mean,
    plateau_a,
    plateau_b,
    z_unit: c.z_unit,
    method:
      "mean B minus mean A; population spreads descriptive, not uncertainty",
  };
}
