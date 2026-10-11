/** Physical-coordinate editing state; sampling footprints do not imply valid data. */
import { canonicalJSON } from "./tool-session.js";
import { normalizeOperation } from "./engine.js";
const fail = () => {
  throw new Error(
    "Invalid three-point draft or incomplete, duplicate, or collinear points.",
  );
};
function copy(value) {
  canonicalJSON(value);
  return structuredClone(value);
}
function exact(value, keys) {
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    fail();
}
function geometry(value) {
  const g = copy(value);
  exact(g, ["shape", "xreal", "yreal", "xoff", "yoff", "xy_unit", "z_unit"]);
  if (
    !Array.isArray(g.shape) ||
    g.shape.length !== 2 ||
    !g.shape.every((n) => Number.isSafeInteger(n) && n > 0) ||
    !["xreal", "yreal", "xoff", "yoff"].every((k) => Number.isFinite(g[k])) ||
    g.xreal <= 0 ||
    g.yreal <= 0 ||
    !Number.isFinite(g.xoff + g.xreal) ||
    !Number.isFinite(g.yoff + g.yreal) ||
    !["xy_unit", "z_unit"].every(
      (k) => g[k] === null || typeof g[k] === "string",
    )
  )
    fail();
  return g;
}
function context(value) {
  const c = copy(value);
  exact(c, ["source_key", "geometry"]);
  if (typeof c.source_key !== "string" || !c.source_key.length) fail();
  return { source_key: c.source_key, geometry: geometry(c.geometry) };
}
function radius(value) {
  if (!Number.isInteger(value) || value < 1 || value > 20) fail();
  return value;
}
function point(value, g) {
  const p = copy(value);
  if (
    !Array.isArray(p) ||
    p.length !== 2 ||
    !p.every(Number.isFinite) ||
    p[0] < g.xoff ||
    p[0] >= g.xoff + g.xreal ||
    p[1] < g.yoff ||
    p[1] >= g.yoff + g.yreal
  )
    fail();
  return p;
}
export function createThreePointDraft() {
  let state = { context: null, points: [null, null, null], radius: 1 };
  const snapshot = () => structuredClone(state);
  return {
    reset(value) {
      state = {
        context: context(value),
        points: [null, null, null],
        radius: 1,
      };
      return snapshot();
    },
    restore(operation, value) {
      const op = copy(operation),
        c = context(value);
      if (op?.name !== "three_point") fail();
      const normalized = normalizeOperation(op);
      state = {
        context: c,
        points: normalized.params.points.map((p) => point(p, c.geometry)),
        radius: normalized.params.radius,
      };
      return snapshot();
    },
    setPoint(index, value) {
      if (!Number.isInteger(index) || index < 0 || index > 2 || !state.context)
        fail();
      const p = point(value, state.context.geometry);
      state.points[index] = p;
      return snapshot();
    },
    setRadius(value) {
      state.radius = radius(value);
      return snapshot();
    },
    snapshot,
    operation() {
      if (!state.context || state.points.some((p) => p === null)) fail();
      const g = state.context.geometry,
        p = state.points
          .map((v) => point(v, g))
          .map(([x, y]) => [(x - g.xoff) / g.xreal, (y - g.yoff) / g.yreal]);
      const determinant =
        (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) -
        (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
      if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12)
        fail();
      return normalizeOperation({
        name: "three_point",
        params: { points: structuredClone(state.points), radius: state.radius },
      });
    },
  };
}
export function samplingFootprint(value, samplingRadius, calibration) {
  const g = geometry(calibration),
    p = point(value, g),
    r = radius(samplingRadius),
    [height, width] = g.shape;
  const column = Math.floor(((p[0] - g.xoff) / g.xreal) * width),
    row = Math.floor(((p[1] - g.yoff) / g.yreal) * height),
    result = [];
  for (let dy = 1 - r; dy < r; dy++)
    for (let dx = 1 - r; dx < r; dx++) {
      const y = row + dy,
        x = column + dx;
      if (
        dx * dx + dy * dy > (r - 0.5) ** 2 ||
        x < 0 ||
        x >= width ||
        y < 0 ||
        y >= height
      )
        continue;
      const bounds = [
        g.xoff + (x * g.xreal) / width,
        g.yoff + (y * g.yreal) / height,
        g.xoff + ((x + 1) * g.xreal) / width,
        g.yoff + ((y + 1) * g.yreal) / height,
      ];
      if (!bounds.every(Number.isFinite)) fail();
      result.push({ row: y, column: x, bounds });
    }
  return result;
}
