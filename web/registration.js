/** Explicit fixed = moving + translation; no implicit correction of either input. */
import { geometry, normalizeSelection, validMask } from "./engine.js";
const MAX_PIXELS = 4194304,
  MAX_WORK = 134217728;
function plain(value, depth = 0, seen = new Set()) {
  if (depth > 64) throw new Error("Registration options exceed nesting limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    seen.has(value) ||
    (!Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new Error("Registration options require plain finite JSON.");
  if (
    Array.isArray(value) &&
    (Object.keys(value).length !== value.length ||
      !Object.keys(value).every((k, i) => k === String(i)))
  )
    throw new Error("Registration arrays must be dense plain JSON.");
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !d.enumerable ||
      !Object.hasOwn(d, "value")
    )
      throw new Error("Registration options require plain values.");
    plain(d.value, depth + 1, seen);
  }
  seen.delete(value);
}
function parameters(options) {
  plain(options);
  if (!options || Array.isArray(options) || typeof options !== "object")
    throw new Error("Expected registration options object.");
  const mode = options.mode === undefined ? "manual" : options.mode;
  if (!["manual", "automatic"].includes(mode))
    throw new Error("Unknown registration mode.");
  const allowed = [
    "mode",
    "fixed_selection",
    "moving_selection",
    ...(mode === "manual"
      ? ["tx", "ty", "interpolation"]
      : ["radius_x", "radius_y", "min_overlap_fraction"]),
  ];
  for (const key of Object.keys(options))
    if (!allowed.includes(key))
      throw new Error("Unknown registration option: " + key);
  const p = {
    mode,
    fixed_selection: normalizeSelection(options.fixed_selection ?? {}),
    moving_selection: normalizeSelection(options.moving_selection ?? {}),
  };
  if (mode === "manual") {
    p.tx = Object.hasOwn(options, "tx") ? options.tx : 0;
    p.ty = Object.hasOwn(options, "ty") ? options.ty : 0;
    p.interpolation = Object.hasOwn(options, "interpolation")
      ? options.interpolation
      : "bilinear";
    if (
      !Number.isFinite(p.tx) ||
      !Number.isFinite(p.ty) ||
      !["nearest", "bilinear"].includes(p.interpolation)
    )
      throw new Error("Invalid manual translation or interpolation.");
  } else {
    p.radius_x = Object.hasOwn(options, "radius_x") ? options.radius_x : 4;
    p.radius_y = Object.hasOwn(options, "radius_y") ? options.radius_y : 4;
    p.min_overlap_fraction = Object.hasOwn(options, "min_overlap_fraction")
      ? options.min_overlap_fraction
      : 0.5;
    p.interpolation = "integer";
    if (
      ![p.radius_x, p.radius_y].every(
        (v) => Number.isInteger(v) && v >= 0 && v <= 64,
      ) ||
      !Number.isFinite(p.min_overlap_fraction) ||
      !(p.min_overlap_fraction > 0 && p.min_overlap_fraction <= 1)
    )
      throw new Error("Invalid automatic search radius or overlap fraction.");
  }
  return p;
}
function check(c) {
  if (
    !c ||
    !Number.isSafeInteger(c.width) ||
    !Number.isSafeInteger(c.height) ||
    c.width < 1 ||
    c.height < 1
  )
    throw new Error("Positive integer image dimensions required.");
  if (c.width * c.height > MAX_PIXELS)
    throw new Error("Registration limit is 4194304 pixels per input.");
  if (
    !(c.data instanceof Float64Array) ||
    c.data.length !== c.width * c.height ||
    (c.mask != null && c.mask.length !== c.data.length)
  )
    throw new Error("Channel array dimensions do not match.");
  if (
    !["xreal", "yreal", "xoff", "yoff"].every((k) => Number.isFinite(c[k])) ||
    c.xreal <= 0 ||
    c.yreal <= 0
  )
    throw new Error("Invalid physical calibration.");
  if (
    !["xy_unit", "z_unit"].every(
      (k) => typeof c[k] === "string" && c[k].trim().length,
    )
  )
    throw new Error("Registration requires declared nonempty XY and Z units.");
  const dx = c.xreal / c.width,
    dy = c.yreal / c.height;
  if (
    !(
      dx > 0 &&
      dy > 0 &&
      Number.isFinite(c.xoff + c.xreal) &&
      Number.isFinite(c.yoff + c.yreal)
    )
  )
    throw new RangeError("Physical grid exceeds numerical range.");
  return { dx, dy };
}
function sample(c, mask, x, y, method) {
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new RangeError("Sampling coordinate exceeds numerical range.");
  if (method === "nearest") {
    const ix = Math.floor(x + 0.5),
      iy = Math.floor(y + 0.5);
    return ix >= 0 &&
      iy >= 0 &&
      ix < c.width &&
      iy < c.height &&
      mask[iy * c.width + ix]
      ? c.data[iy * c.width + ix]
      : NaN;
  }
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy;
  let result = 0;
  for (let oy = 0; oy <= 1; oy++)
    for (let ox = 0; ox <= 1; ox++) {
      const w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
      if (w === 0) continue;
      const xx = ix + ox,
        yy = iy + oy;
      if (
        xx < 0 ||
        yy < 0 ||
        xx >= c.width ||
        yy >= c.height ||
        !mask[yy * c.width + xx]
      )
        return NaN;
      result += w * c.data[yy * c.width + xx];
    }
  if (!Number.isFinite(result))
    throw new RangeError("Interpolated value exceeds numerical range.");
  return result;
}
export function registerSurfaces(fixed, moving, options = {}) {
  const p = parameters(options),
    f = check(fixed),
    m = check(moving);
  if (fixed.xy_unit !== moving.xy_unit || fixed.z_unit !== moving.z_unit)
    throw new Error("Registration requires identical declared XY and Z units.");
  if (p.mode === "automatic") {
    if (
      Math.abs(f.dx - m.dx) > 1e-12 * Math.max(f.dx, m.dx) ||
      Math.abs(f.dy - m.dy) > 1e-12 * Math.max(f.dy, m.dy)
    )
      throw new Error(
        "Automatic registration requires equal pixel pitches; use manual resampling.",
      );
    if (
      fixed.data.length * (2 * p.radius_x + 1) * (2 * p.radius_y + 1) >
      MAX_WORK
    )
      throw new Error(
        "Registration search exceeds work budget; crop inputs or reduce search radii.",
      );
  }
  const fm = validMask(fixed, p.fixed_selection),
    mm = validMask(moving, p.moving_selection);
  let fc = 0,
    mc = 0,
    fs = 0,
    ms = 0;
  for (let i = 0; i < fm.length; i++)
    if (fm[i]) {
      fc++;
      fs = Math.max(fs, Math.abs(fixed.data[i]));
    }
  for (let i = 0; i < mm.length; i++)
    if (mm[i]) {
      mc++;
      ms = Math.max(ms, Math.abs(moving.data[i]));
    }
  const denominator = Math.min(fc, mc);
  if (!denominator)
    throw new Error("Registration selections contain no valid pixels.");
  const warnings = [
    ...new Set([
      ...(fixed.warnings ?? []),
      ...(moving.warnings ?? []),
      "Matching declared units does not certify instrument calibration.",
      "Interpolation can alter apparent roughness; registration does not establish physical deformation.",
    ]),
  ];
  let tx = p.tx,
    ty = p.ty,
    shift = null,
    search = null;
  if (p.mode === "automatic") {
    const candidates = [];
    for (let sy = -p.radius_y || 0; sy <= p.radius_y; sy++)
      for (let sx = -p.radius_x || 0; sx <= p.radius_x; sx++) {
        let n = 0,
          a = 0,
          b = 0,
          aa = 0,
          bb = 0,
          ab = 0;
        for (
          let y = Math.max(0, sy);
          y < Math.min(fixed.height, moving.height + sy);
          y++
        )
          for (
            let x = Math.max(0, sx);
            x < Math.min(fixed.width, moving.width + sx);
            x++
          ) {
            const i = y * fixed.width + x,
              j = (y - sy) * moving.width + x - sx;
            if (!fm[i] || !mm[j]) continue;
            const av = fs ? fixed.data[i] / fs : 0,
              bv = ms ? moving.data[j] / ms : 0;
            n++;
            const da = av - a,
              db = bv - b;
            a += da / n;
            b += db / n;
            aa += da * (av - a);
            bb += db * (bv - b);
            ab += da * (bv - b);
          }
        const fraction = n / denominator;
        const ncc =
          n >= 3 && fraction >= p.min_overlap_fraction && aa > 0 && bb > 0
            ? Math.max(-1, Math.min(1, ab / Math.sqrt(aa) / Math.sqrt(bb)))
            : null;
        if (ncc !== null && !Number.isFinite(ncc))
          throw new RangeError("Correlation exceeds numerical range.");
        candidates.push({
          sx,
          sy,
          ncc,
          valid_count: n,
          overlap_fraction: fraction,
        });
      }
    let best = -Infinity;
    for (const c of candidates)
      if (c.ncc !== null) best = Math.max(best, c.ncc);
    if (best === -Infinity)
      throw new Error(
        "No valid automatic registration score: check overlap and nonconstant data.",
      );
    const tied = candidates
      .filter((c) => c.ncc !== null && best - c.ncc <= 1e-12)
      .sort(
        (a, b) =>
          a.sx * a.sx + a.sy * a.sy - b.sx * b.sx - b.sy * b.sy ||
          a.sy - b.sy ||
          a.sx - b.sx,
      );
    const chosen = tied[0];
    shift = [chosen.sx, chosen.sy];
    tx = fixed.xoff - moving.xoff + chosen.sx * f.dx;
    ty = fixed.yoff - moving.yoff + chosen.sy * f.dy;
    search = {
      origin_convention:
        "Coincident raster origins: tx = fixed.xoff - moving.xoff + sx*dx; ty = fixed.yoff - moving.yoff + sy*dy",
      candidates,
      tied_candidates: tied,
      boundary_peak:
        Math.abs(chosen.sx) === p.radius_x ||
        Math.abs(chosen.sy) === p.radius_y,
    };
    if (tied.length > 1)
      warnings.push(
        "Multiple candidate shifts tie within 1e-12; alignment is ambiguous.",
      );
    if (search.boundary_peak)
      warnings.push(
        "Selected shift is on the search boundary; review a broader search.",
      );
    warnings.push(
      "Automatic integer translation is a proposal for review, without subpixel precision.",
    );
  }
  if (!Number.isFinite(tx) || !Number.isFinite(ty))
    throw new RangeError("Translation exceeds numerical range.");
  function evaluate(tx, ty, integerShift = null, output = false) {
    const aligned = output
        ? new Float64Array(fixed.data.length).fill(NaN)
        : null,
      difference = output
        ? new Float64Array(fixed.data.length).fill(NaN)
        : null,
      valid = output ? new Uint8Array(fixed.data.length) : null;
    let n = 0,
      mean = 0,
      mae = 0,
      max = 0,
      scale = 0,
      ssq = 0,
      x0 = fixed.width,
      y0 = fixed.height,
      x1 = 0,
      y1 = 0;
    for (let y = 0; y < fixed.height; y++)
      for (let x = 0; x < fixed.width; x++) {
        const i = y * fixed.width + x;
        if (!fm[i]) continue;
        let v;
        if (integerShift) {
          const xx = x - integerShift[0],
            yy = y - integerShift[1];
          v =
            xx >= 0 &&
            yy >= 0 &&
            xx < moving.width &&
            yy < moving.height &&
            mm[yy * moving.width + xx]
              ? moving.data[yy * moving.width + xx]
              : NaN;
        } else
          v = sample(
            moving,
            mm,
            x * (f.dx / m.dx) +
              (fixed.xoff - moving.xoff - tx + 0.5 * (f.dx - m.dx)) / m.dx,
            y * (f.dy / m.dy) +
              (fixed.yoff - moving.yoff - ty + 0.5 * (f.dy - m.dy)) / m.dy,
            p.mode === "automatic" ? "nearest" : p.interpolation,
          );
        if (!Number.isFinite(v)) continue;
        const d = fixed.data[i] - v;
        if (!Number.isFinite(d))
          throw new RangeError("Difference exceeds numerical range.");
        n++;
        mean = mean * ((n - 1) / n) + d / n;
        const a = Math.abs(d);
        mae = mae * ((n - 1) / n) + a / n;
        max = Math.max(max, a);
        if (a > 0) {
          if (scale < a) {
            ssq = 1 + ssq * (scale / a) ** 2;
            scale = a;
          } else ssq += (a / scale) ** 2;
        }
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
        if (output) {
          aligned[i] = v;
          difference[i] = d;
          valid[i] = 1;
        }
      }
    if (!n) return null;
    const metrics = {
      valid_count: n,
      overlap_fraction: n / fc,
      fixed_valid_count: fc,
      moving_valid_count: mc,
      overlap_fraction_definition:
        "common-valid fixed pixels / valid fixed pixels",
      area: n * f.dx * f.dy,
      area_unit: "(" + fixed.xy_unit + ")²",
      bounds: [x0, y0, x1, y1],
      rmse: scale * Math.sqrt(ssq / n),
      mae,
      mean_difference: mean,
      max_abs: max,
      value_unit: fixed.z_unit,
    };
    if (
      ![metrics.area, metrics.rmse, mae, mean, max].every(Number.isFinite) ||
      metrics.area <= 0
    )
      throw new RangeError("Registration metrics exceed numerical range.");
    return { aligned, difference, valid, metrics };
  }
  const result = evaluate(tx, ty, shift, true);
  if (!result) throw new Error("Translation has no common valid overlap.");
  let before;
  if (p.mode === "automatic") {
    const sx = (moving.xoff - fixed.xoff) / f.dx,
      sy = (moving.yoff - fixed.yoff) / f.dy;
    if (
      !Number.isFinite(sx) ||
      !Number.isFinite(sy) ||
      Math.abs(sx - Math.round(sx)) > 1e-12 ||
      Math.abs(sy - Math.round(sy)) > 1e-12
    )
      before = {
        available: false,
        reason:
          "Zero physical translation does not align the pixel lattices for integer sampling.",
      };
    else before = evaluate(0, 0, [Math.round(sx), Math.round(sy)])?.metrics;
  } else before = evaluate(0, 0)?.metrics;
  return {
    schema_version: 1,
    algorithm: "translation_registration_v1",
    parameters: p,
    transform: {
      type: "translation",
      tx,
      ty,
      unit: fixed.xy_unit,
      mapping: "fixed = moving + translation",
      pixel_shift: shift,
    },
    fixed_geometry: geometry(fixed),
    moving_geometry: geometry(moving),
    ...result,
    before: before ?? {
      available: false,
      reason: "No common valid overlap at zero physical translation.",
    },
    search,
    warnings,
  };
}
