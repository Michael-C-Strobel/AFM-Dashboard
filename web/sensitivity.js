/** Deterministic same-source alternatives: descriptive sensitivity, not uncertainty. */
import { normalizeOperation, normalizeSelection } from "./engine.js";
const LIMIT = 262144,
  WORK_LIMIT = 134217728;
function finiteJSON(value, depth = 0, seen = new Set()) {
  if (depth > 64) throw new Error("Sensitivity JSON exceeds depth 64.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (
    !value ||
    typeof value !== "object" ||
    seen.has(value) ||
    (!Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new Error("Sensitivity requires plain finite JSON.");
  if (
    Array.isArray(value) &&
    (Object.keys(value).length !== value.length ||
      !Object.keys(value).every((key, i) => key === String(i)))
  )
    throw new Error("Sensitivity arrays must be dense JSON.");
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
      throw new Error("Sensitivity requires plain JSON properties.");
    finiteJSON(d.value, depth + 1, seen);
  }
  seen.delete(value);
}
function exact(value, keys, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new Error(name + " has missing or unknown fields.");
}
function text(value, min, max, name) {
  if (typeof value !== "string" || value.length < min || value.length > max)
    throw new Error("Invalid " + name + ".");
}
export function normalizeSensitivityRequest(request) {
  finiteJSON(request);
  if (new TextEncoder().encode(JSON.stringify(request)).length > LIMIT)
    throw new Error("Sensitivity request exceeds 262144 bytes.");
  exact(
    request,
    ["baseline_recipe", "variants", "assumptions"],
    "Sensitivity request",
  );
  if (
    !request.baseline_recipe ||
    typeof request.baseline_recipe !== "object" ||
    Array.isArray(request.baseline_recipe)
  )
    throw new Error("Baseline recipe must be an object.");
  if (
    !Array.isArray(request.variants) ||
    request.variants.length < 1 ||
    request.variants.length > 16
  )
    throw new Error("Sensitivity requires 1–16 variants.");
  exact(request.assumptions, ["calibration_note", "model_note"], "Assumptions");
  for (const key of ["calibration_note", "model_note"])
    text(request.assumptions[key], 0, 2000, key);
  const ids = new Set(["baseline"]);
  const variants = request.variants.map((v) => {
    exact(v, ["id", "label", "operations", "selection"], "Variant");
    if (
      typeof v.id !== "string" ||
      v.id.length > 32 ||
      !/^[a-z][a-z0-9_-]*$/.test(v.id) ||
      v.id.includes("\n") ||
      ids.has(v.id)
    )
      throw new Error("Invalid or duplicate sensitivity variant ID.");
    ids.add(v.id);
    text(v.label, 1, 120, "variant label");
    if (!Array.isArray(v.operations) || v.operations.length > 32)
      throw new Error("At most 32 operations per variant.");
    return {
      id: v.id,
      label: v.label,
      operations: v.operations.map(normalizeOperation),
      selection: normalizeSelection(v.selection),
    };
  });
  return {
    baseline_recipe: structuredClone(request.baseline_recipe),
    variants,
    assumptions: structuredClone(request.assumptions),
  };
}
export function sensitivityWork(request, sourcePixelCount) {
  const r = normalizeSensitivityRequest(request);
  if (
    !Number.isSafeInteger(sourcePixelCount) ||
    sourcePixelCount < 1 ||
    sourcePixelCount > 4194304
  )
    throw new Error("Sensitivity source must contain 1–4194304 pixels.");
  if (
    !Array.isArray(r.baseline_recipe.operations) ||
    r.baseline_recipe.operations.length > 32
  )
    throw new Error(
      "Baseline operations must be an array of at most 32 operations.",
    );
  const passes = [r.baseline_recipe, ...r.variants].reduce(
    (sum, v) => sum + Math.max(1, v.operations.length),
    0,
  );
  const estimated_pixel_passes = passes * sourcePixelCount;
  if (estimated_pixel_passes > WORK_LIMIT)
    throw new Error(
      "Sensitivity work limit exceeded; reduce variants or operation counts.",
    );
  return {
    source_pixels: sourcePixelCount,
    estimated_pixel_passes,
    limit: WORK_LIMIT,
  };
}
const definitions = [
  ["sa", "Sa"],
  ["sq", "Sq"],
  ["mean", "Mean"],
  ["min", "Minimum"],
  ["max", "Maximum"],
  ["peak_to_valley", "Peak-to-valley"],
  ["area", "Area"],
  ["valid_count", "Valid count"],
  ["excluded_count", "Excluded count"],
];
const read = (result, key) => {
  const [group, field] = key.split(".");
  return result?.[group]?.[field];
};
function unit(result, key) {
  if (key.endsWith("_count")) return "count";
  const group = key === "step.height" ? result?.step : result?.statistics;
  const u =
    key === "statistics.area"
      ? result?.statistics?.area_unit
      : group && Object.hasOwn(group, "z_unit")
        ? group.z_unit
        : result?.channel?.z_unit;
  return typeof u === "string" && u.length ? u : null;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function outputGeometry(result) {
  const source = result?.recipe?.output?.geometry ?? result?.channel;
  return Object.fromEntries(
    ["shape", "xreal", "yreal", "xoff", "yoff", "xy_unit", "z_unit"].map(
      (key) => [key, source?.[key]],
    ),
  );
}
const equal = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function summarizeSensitivity(baseline, variants) {
  if (!baseline || typeof baseline !== "object" || !Array.isArray(variants))
    throw new Error(
      "Sensitivity summary requires baseline and variant records.",
    );
  const entries = [
    {
      id: "baseline",
      label: "Baseline",
      status: "succeeded",
      result: baseline,
      error: null,
    },
    ...variants,
  ];
  const warnings = [
    "Same-source alternatives are not independent replicates; their spread is descriptive sensitivity, not a confidence interval or standard error.",
    "Calibration uncertainty has not been assessed.",
  ];
  for (const v of variants) {
    if (!["succeeded", "failed"].includes(v.status))
      throw new Error("Invalid sensitivity variant status.");
    if (v.status !== "succeeded") continue;
    if (!equal(baseline.recipe?.selection, v.result?.recipe?.selection))
      warnings.push(
        `Variant ${v.id}: selection differs; fitted or measured populations may differ.`,
      );
    if (!equal(outputGeometry(baseline), outputGeometry(v.result)))
      warnings.push(
        `Variant ${v.id}: output geometry differs; sampled populations may differ.`,
      );
    if (
      baseline.statistics?.valid_count !== v.result?.statistics?.valid_count ||
      baseline.statistics?.excluded_count !==
        v.result?.statistics?.excluded_count
    )
      warnings.push(
        `Variant ${v.id}: valid or excluded pixel population differs.`,
      );
  }
  const keys = definitions.map(([field, label]) => [
    "statistics." + field,
    label,
  ]);
  if (baseline.step != null) keys.push(["step.height", "Plateau height"]);
  if (baseline.comparison != null)
    keys.push(["comparison.rmse", "Reference RMSE"]);
  const metrics = keys.map(([key, label]) => {
    const raw = read(baseline, key),
      base = Number.isFinite(raw) ? raw : null,
      u = unit(baseline, key);
    const values = entries.map((v) => {
      const raw = read(v.result, key),
        value = v.status === "succeeded" && Number.isFinite(raw) ? raw : null;
      let delta = null,
        relative_delta = null;
      const reasons = [];
      if (v.status === "failed")
        reasons.push("Variant failed: " + (v.error || "unspecified error"));
      else if (value === null)
        reasons.push("Measurement is missing or nonfinite.");
      if (value !== null) {
        if (base === null)
          reasons.push("Baseline measurement is missing or nonfinite.");
        else {
          const d = value - base;
          if (Number.isFinite(d)) delta = d;
          else reasons.push("Delta exceeds finite numeric range.");
          if (base === 0)
            reasons.push("Relative delta is undefined for a zero baseline.");
          else if (delta !== null) {
            const rel = delta / Math.abs(base);
            if (Number.isFinite(rel)) relative_delta = rel;
            else reasons.push("Relative delta exceeds finite numeric range.");
          }
        }
        if (unit(v.result, key) !== u) {
          reasons.push("Declared metric unit differs from baseline.");
          warnings.push(
            `Variant ${v.id}: ${key} unit differs; numerical alternatives are not directly comparable.`,
          );
        }
      }
      return {
        id: v.id,
        label: v.label,
        status: v.status,
        value,
        delta,
        relative_delta,
        reason: reasons.length ? reasons.join(" ") : null,
      };
    });
    const members = values.filter((v) => v.value !== null),
      numbers = members.map((v) => v.value),
      minimum = numbers.length ? Math.min(...numbers) : null,
      maximum = numbers.length ? Math.max(...numbers) : null;
    const span = minimum === null ? null : maximum - minimum;
    const deltas = members.map((v) => v.delta),
      finiteDeltas = deltas.filter(Number.isFinite);
    const maxDelta = finiteDeltas.length
      ? Math.max(...finiteDeltas.map(Math.abs))
      : null;
    const reason = [];
    if (!members.length) reason.push("No finite successful measurements.");
    if (span !== null && !Number.isFinite(span))
      reason.push("Range span exceeds finite numeric range.");
    if (members.length && deltas.some((d) => d === null))
      reason.push(
        "Maximum absolute delta is unavailable because a baseline or delta is unrepresentable.",
      );
    return {
      key,
      label,
      unit: u,
      baseline: base,
      values,
      range: {
        minimum,
        maximum,
        span: Number.isFinite(span) ? span : null,
        max_abs_delta: deltas.some((d) => d === null) ? null : maxDelta,
        member_ids: members.map((v) => v.id),
        count: members.length,
        reason: reason.length ? reason.join(" ") : null,
      },
    };
  });
  return { metrics, warnings: [...new Set(warnings)] };
}
