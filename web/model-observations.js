/** Compact selected diagnostic observations; integrity verification is not numerical validation. */
import { canonicalJSON } from "./tool-session.js";
import { createEvidenceReport } from "./evidence-report.js";
import { validateToolCall } from "./tool-contracts.js";
import { normalizeSelection } from "./engine.js";
const canon = (v) => canonicalJSON(v, new Set(), 0, 128),
  same = (a, b) => canon(a) === canon(b);
const fail = () => {
  throw new Error("Invalid or unbound selected model observation.");
};
const str = (v) => {
  if (typeof v !== "string") fail();
  return v;
};
const unit = (v) => (v === null ? null : str(v));
const num = (v) => {
  if (!Number.isFinite(v)) fail();
  return v;
};
const nullable = (v) => (v === null ? null : num(v));
const count = (v) => {
  if (!Number.isSafeInteger(v) || v < 0) fail();
  return v;
};
const pick = (v, spec) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  return Object.fromEntries(
    Object.entries(spec).map(([k, fn]) => [k, fn(v[k])]),
  );
};
function geometry(v) {
  const g = pick(v, {
    shape: (s) => {
      if (
        !Array.isArray(s) ||
        s.length !== 2 ||
        s.some((x) => !Number.isSafeInteger(x) || x <= 0)
      )
        fail();
      return s.slice();
    },
    xreal: num,
    yreal: num,
    xoff: num,
    yoff: num,
    xy_unit: unit,
    z_unit: unit,
  });
  if (g.xreal <= 0 || g.yreal <= 0) fail();
  return g;
}
const selection = (v) => {
  const normalized = normalizeSelection(v);
  if (!same(v, normalized)) fail();
  return normalized;
};
function support(v) {
  if (v == null) return null;
  const out = pick(v, { status: str, message: str });
  for (const k of ["format", "configuration"])
    if (Object.hasOwn(v, k)) {
      if (
        v[k] !== null &&
        typeof v[k] !== "string" &&
        typeof v[k] !== "number" &&
        typeof v[k] !== "boolean"
      )
        fail();
      out[k] = v[k];
    }
  return out;
}
function quality(r, a) {
  if (
    r.schema_version !== 1 ||
    r.report?.schema_version !== 1 ||
    !same(r.parameters, {
      selection: a.selection,
      boundary_sigma: a.boundary_sigma,
    }) ||
    !same(r.report.parameters, r.parameters) ||
    r.input.reference_channel !== a.reference_channel
  )
    fail();
  const q = r.report,
    g = geometry(q.geometry),
    c = pick(q.counts, {
      total: count,
      selected: count,
      invalid: count,
      imported_mask: count,
      excluded: count,
      selection_excluded_valid: count,
    });
  if (
    c.total !== g.shape[0] * g.shape[1] ||
    c.selected + c.excluded !== c.total
  )
    fail();
  const axis = (v) => {
    const out = pick(v, {
      center: nullable,
      mad: nullable,
      threshold: nullable,
    });
    if (!Array.isArray(v.candidates)) fail();
    out.candidate_count = v.candidates.length;
    return out;
  };
  let comparison = null;
  if (q.comparison !== null)
    comparison = pick(q.comparison, {
      rmse: num,
      mae: num,
      max_abs: num,
      mean_difference: num,
      valid_count: count,
      definition: str,
      z_unit: unit,
    });
  if ((a.reference_channel === null) !== (comparison === null)) fail();
  if (
    q.units?.xy !== g.xy_unit ||
    q.units?.z !== g.z_unit ||
    (comparison && comparison.z_unit !== g.z_unit)
  )
    fail();
  return {
    geometry: g,
    units: pick(q.units, { xy: unit, z: unit }),
    counts: c,
    boundary_sigma: num(q.parameters.boundary_sigma),
    rows: axis(q.rows),
    columns: axis(q.columns),
    comparison,
    support: support(r.input.support),
  };
}
function segmentation(r, a, recipe) {
  if (
    r.kind !== "segmentation" ||
    r.schema_version !== 1 ||
    r.report?.algorithm !== "threshold_components_v1"
  )
    fail();
  const expected = {
    ...a.parameters,
    selection: normalizeSelection(recipe.selection),
  };
  if (
    !same(r.parameters, expected) ||
    !same(r.report.parameters, expected) ||
    !same(r.report.geometry, recipe.output.geometry)
  )
    fail();
  return {
    algorithm: r.report.algorithm,
    parameters: pick(expected, {
      threshold: num,
      direction: str,
      connectivity: count,
      min_pixels: count,
      boundary: str,
      selection,
    }),
    geometry: geometry(r.report.geometry),
    counts: pick(r.report.counts, {
      valid: count,
      invalid: count,
      threshold_pixels: count,
      accepted_pixels: count,
      candidate_regions: count,
      accepted_regions: count,
      excluded_regions: count,
    }),
  };
}
function texture(r, a, recipe) {
  if (
    r.kind !== "spatial_texture" ||
    r.schema_version !== 1 ||
    r.algorithm !== "spatial_texture_v1" ||
    !same(r.parameters, {
      ...a.parameters,
      selection: normalizeSelection(recipe.selection),
    })
  )
    fail();
  const acf = pick(r.acf, { unit, definition: str, zero_lag: num });
  return {
    algorithm: r.algorithm,
    parameters: pick(r.parameters, { detrend: str, window: str, selection }),
    geometry: geometry(r.geometry),
    sampling: pick(r.sampling, {
      dx: num,
      dy: num,
      fft_width: count,
      fft_height: count,
      dfx: num,
      dfy: num,
      frequency_unit: unit,
    }),
    psd: {
      ...pick(r.psd, {
        unit,
        definition: str,
        integral: num,
        expected_mean_square: num,
        window_energy: num,
      }),
      integral_unit: acf.unit,
      expected_mean_square_unit: acf.unit,
    },
    acf,
  };
}
function sensitivity(r, a, recipe) {
  if (
    r.kind !== "analysis_sensitivity" ||
    r.schema_version !== 1 ||
    !same(r.request, {
      baseline_recipe: recipe,
      variants: a.variants,
      assumptions: a.assumptions,
    }) ||
    !same(r.baseline.recipe, recipe) ||
    !Array.isArray(r.variants) ||
    r.variants.length !== a.variants.length ||
    r.variants.length > 16
  )
    fail();
  const statuses = new Map([
    ["baseline", { id: "baseline", label: "Baseline", status: "succeeded" }],
  ]);
  r.variants.forEach((v, i) => {
    const definition = a.variants[i];
    if (
      v.id !== definition.id ||
      v.label !== definition.label ||
      !["succeeded", "failed"].includes(v.status)
    )
      fail();
    statuses.set(v.id, v);
    if (v.status === "succeeded") {
      const saved = v.result?.recipe;
      if (
        !saved ||
        !same(saved.source, recipe.source) ||
        !same(saved.reference, recipe.reference) ||
        !same(saved.operations, definition.operations) ||
        !same(saved.selection, definition.selection)
      )
        fail();
    }
  });
  const keys = [
    "statistics.sa",
    "statistics.sq",
    "statistics.mean",
    "statistics.min",
    "statistics.max",
    "statistics.peak_to_valley",
    "statistics.area",
    "statistics.valid_count",
    "statistics.excluded_count",
  ];
  if (r.baseline.step !== null) keys.push("step.height");
  if (r.baseline.comparison !== null) keys.push("comparison.rmse");
  if (
    !Array.isArray(r.summary?.metrics) ||
    !same(
      r.summary.metrics.map((m) => m.key),
      keys,
    )
  )
    fail();
  const metrics = r.summary.metrics.map((m) => {
    const out = pick(m, { key: str, label: str, unit, baseline: nullable });
    if (
      !Array.isArray(m.values) ||
      m.values.length !== statuses.size ||
      m.values.length > 17
    )
      fail();
    const ids = [...statuses.keys()];
    out.values = m.values.map((v, i) => {
      const value = pick(v, {
        id: str,
        label: str,
        status: str,
        value: nullable,
        delta: nullable,
        relative_delta: nullable,
        reason: unit,
      });
      const expected = statuses.get(value.id);
      if (
        value.id !== ids[i] ||
        !expected ||
        value.status !== expected.status ||
        value.label !== expected.label ||
        (value.status === "failed" &&
          [value.value, value.delta, value.relative_delta].some(
            (x) => x !== null,
          ))
      )
        fail();
      return value;
    });
    out.range = pick(m.range, {
      minimum: nullable,
      maximum: nullable,
      span: nullable,
      max_abs_delta: nullable,
      member_ids: (v) => {
        if (
          !Array.isArray(v) ||
          v.length > 17 ||
          new Set(v).size !== v.length ||
          v.some((id) => typeof id !== "string" || !statuses.has(id))
        )
          fail();
        return v.slice();
      },
      count,
      reason: unit,
    });
    if (
      out.range.count !== out.range.member_ids.length ||
      !same(
        out.range.member_ids,
        out.values
          .filter((v) => v.value !== null && v.status === "succeeded")
          .map((v) => v.id),
      )
    )
      fail();
    return out;
  });
  if (
    r.calibration_uncertainty?.status !== "not_evaluated" ||
    r.calibration_uncertainty.note !== a.assumptions.calibration_note ||
    r.model_note !== a.assumptions.model_note ||
    !["complete", "partial"].includes(r.status) ||
    r.status !==
      (r.variants.some((v) => v.status === "failed") ? "partial" : "complete")
  )
    fail();
  return {
    status: r.status,
    calibration_uncertainty: pick(r.calibration_uncertainty, {
      status: str,
      note: str,
    }),
    model_note: str(r.model_note),
    summary: { metrics },
  };
}
export async function createModelObservations(bundle, sources) {
  canon(bundle);
  canon(sources);
  const input = structuredClone(bundle),
    selected = structuredClone(sources);
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    !["manifest", "journal", "step_ids"].every((k) =>
      Object.hasOwn(input, k),
    ) ||
    !Array.isArray(input.step_ids) ||
    input.step_ids.length < 1 ||
    input.step_ids.length > 16 ||
    new Set(input.step_ids).size !== input.step_ids.length ||
    input.step_ids.some(
      (id) =>
        typeof id !== "string" ||
        id.trim() !== id ||
        !/^[a-z][a-z0-9_-]{0,31}$/.test(id),
    )
  )
    fail();
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 8)
    fail();
  for (const s of selected)
    validateToolCall({
      name: "check_quality",
      arguments: {
        file: s.file,
        source_sha256: s.source_sha256,
        channel: s.channel,
      },
    });
  const verified = await createEvidenceReport({
    manifest: input.manifest,
    journal: input.journal,
  });
  const observations = [],
    allWarnings = new Set();
  for (const id of input.step_ids) {
    const index = input.manifest.steps.findIndex((s) => s.id === id),
      step = input.manifest.steps[index];
    if (!step || step.status !== "complete") fail();
    const call = validateToolCall(step.resolved_call),
      tool = call.name,
      a = call.arguments,
      r = step.result.artifact.content.result;
    if (
      ![
        "check_quality",
        "segment_surface",
        "measure_texture",
        "analyze_sensitivity",
      ].includes(tool)
    )
      fail();
    let recipe = null,
      predecessor = null,
      actual,
      reference;
    if (tool === "check_quality") {
      actual = {
        file: r.input?.file,
        source_sha256: r.input?.sha256,
        channel: r.input?.channel,
      };
      reference =
        r.input?.reference_channel == null
          ? null
          : {
              file: actual.file,
              source_sha256: actual.source_sha256,
              channel: r.input.reference_channel,
            };
    } else {
      predecessor = input.manifest.steps
        .slice(0, index)
        .find(
          (s) =>
            s.status === "complete" &&
            s.result?.artifact?.id === a.recipe_artifact &&
            ["analyze_surface", "replay_recipe"].includes(
              s.resolved_call?.name,
            ),
        );
      if (
        !predecessor ||
        !verified.claims.some((c) => c.step_id === predecessor.id)
      )
        fail();
      recipe =
        tool === "analyze_sensitivity"
          ? r.request?.baseline_recipe
          : r.input_recipe;
      if (
        !recipe ||
        !same(recipe, predecessor.result.artifact.content.result.recipe)
      )
        fail();
      actual = {
        file: recipe.source.file,
        source_sha256: recipe.source.sha256,
        channel: recipe.source.channel,
      };
      reference = recipe.reference
        ? {
            file: recipe.reference.file,
            source_sha256: recipe.reference.sha256,
            channel: recipe.reference.channel,
          }
        : null;
    }
    const tuple = (s) =>
      selected.find(
        (c) =>
          c.file === s.file &&
          c.source_sha256 === s.source_sha256 &&
          c.channel === s.channel,
      );
    const selectedSource = tuple(actual),
      selectedReference = reference ? tuple(reference) : null;
    if (
      !selectedSource ||
      (reference && !selectedReference) ||
      actual.file !== a.file ||
      actual.source_sha256 !== a.source_sha256 ||
      (Object.hasOwn(a, "channel") && actual.channel !== a.channel)
    )
      fail();
    const warnings = new Set();
    const add = (list) => {
      if (list === undefined) return;
      if (!Array.isArray(list) || list.some((w) => typeof w !== "string"))
        fail();
      for (const w of list) warnings.add(w);
    };
    for (const obj of [
      r,
      r.report,
      r.input,
      r.reference,
      r.baseline,
      r.baseline?.channel,
      r.summary,
      predecessor?.result?.artifact?.content?.result,
      predecessor?.result?.artifact?.content?.result?.channel,
      selectedSource,
      selectedReference,
    ])
      if (obj) add(obj.warnings);
    add(r.input?.reference_warnings);
    if (tool === "analyze_sensitivity" && Array.isArray(r.variants))
      for (const variant of r.variants)
        if (variant.status === "succeeded") {
          add(variant.result?.warnings);
          add(variant.result?.channel?.warnings);
        }
    let summary;
    if (tool === "check_quality") summary = quality(r, a);
    else if (tool === "segment_surface") summary = segmentation(r, a, recipe);
    else if (tool === "measure_texture") summary = texture(r, a, recipe);
    else summary = sensitivity(r, a, recipe);
    for (const w of warnings) allWarnings.add(w);
    observations.push({
      observation_id: `${verified.plan_sha256}:${id}:${tool}`,
      step_id: id,
      tool,
      artifact_id: step.result.artifact.id,
      source: actual,
      summary,
      warnings: [...warnings],
    });
  }
  if (input.manifest.status !== "complete")
    allWarnings.add(
      "The recorded run is incomplete; only explicitly selected verified observations are included.",
    );
  const output = {
    schema_version: 1,
    plan_sha256: verified.plan_sha256,
    journal_head_sha256: verified.journal_head_sha256,
    run_status: input.manifest.status,
    observations,
    warnings: [...allWarnings],
  };
  canon(output);
  if (new TextEncoder().encode(JSON.stringify(output)).length > 65536)
    throw new Error("Projected observations exceed 64 KiB.");
  return output;
}
