import { analyze, replay } from "./service.js";
import { normalizeOperation, normalizeSelection, sha256 } from "./engine.js";
import {
  normalizeSensitivityRequest,
  sensitivityWork,
  summarizeSensitivity,
} from "./sensitivity.js";
import { tar } from "./archive.js";
const names = ["sensitivity.js", "sensitivity-service.js", "engine.js"],
  hash = /^[a-f0-9]{64}$/;
function finiteJSON(value, ancestors = new Set(), depth = 0) {
  if (depth > 64)
    throw new Error("Sensitivity JSON nesting exceeds 64 levels.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    throw new Error("Sensitivity provenance requires finite plain JSON.");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && keys.length !== value.length + 1)
    throw new Error("Sensitivity JSON requires dense ordinary arrays.");
  for (const key of keys) {
    if (typeof key === "symbol")
      throw new Error("Sensitivity JSON cannot contain symbol keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value"))
      throw new Error("Sensitivity JSON cannot contain accessors.");
    if (!descriptor.enumerable && !(Array.isArray(value) && key === "length"))
      throw new Error("Sensitivity JSON cannot contain hidden properties.");
    if (
      Array.isArray(value) &&
      key !== "length" &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
    )
      throw new Error("Sensitivity JSON requires ordinary array indices.");
    finiteJSON(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (o, keys) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).length === keys.length &&
  keys.every((k) => Object.hasOwn(o, k));
function identity(engine, code) {
  finiteJSON(code);
  if (
    !hash.test(engine) ||
    !exact(code, ["sha256", "files"]) ||
    !hash.test(code.sha256) ||
    !Array.isArray(code.files) ||
    code.files.length !== names.length ||
    code.files.some(
      (f, i) =>
        !exact(f, ["name", "sha256"]) ||
        f.name !== names[i] ||
        !hash.test(f.sha256),
    )
  )
    throw new Error("Invalid sensitivity engine or code identity.");
  return structuredClone(code);
}
function compact(result, recipe) {
  const comparison = result.comparison
    ? Object.fromEntries(
        Object.entries(result.comparison).filter(
          ([key]) => !["data", "target"].includes(key),
        ),
      )
    : null;
  return {
    recipe: structuredClone(recipe),
    channel: result.channel,
    statistics: result.statistics,
    profile: result.profile,
    step: result.step,
    comparison,
    history: result.history,
    warnings: result.warnings,
  };
}
function title(result, recipe) {
  if (
    recipe.source.channel !== String(result.channel.id) ||
    recipe.source.title !== result.channel.title
  )
    throw new Error("Sensitivity source channel or title mismatch.");
}
function invocation(base, variant) {
  return {
    file: base.source.file,
    channel: base.source.channel,
    operations: variant.operations,
    selection: variant.selection,
    profile: base.profile,
    plateaus: base.plateaus,
    reference: base.reference,
  };
}
function verifyDefinition(recipe, base, variant) {
  if (
    !same(recipe.source, base.source) ||
    !same(recipe.operations, variant.operations.map(normalizeOperation)) ||
    !same(recipe.selection, normalizeSelection(variant.selection)) ||
    !["profile", "plateaus", "reference"].every((key) =>
      same(recipe[key], base[key]),
    )
  )
    throw new Error(
      "Saved sensitivity recipe differs from its requested variant definition or fixed settings.",
    );
}
function workFor(request, source) {
  const channel = source.channels[request.baseline_recipe.source?.channel];
  if (!channel) throw new Error("Sensitivity source channel not found.");
  return sensitivityWork(request, channel.width * channel.height);
}
async function assembled(request, code, work, baseline, variants, source) {
  const summary = summarizeSensitivity(baseline, variants),
    warnings = [
      ...(source.warnings ?? []),
      ...(baseline.warnings ?? []),
      ...(summary.warnings ?? []),
    ];
  for (const value of [
    baseline,
    ...variants.filter((v) => v.status === "succeeded").map((v) => v.result),
  ]) {
    warnings.push(...(value.warnings ?? []), ...(value.channel.warnings ?? []));
    const support = value.channel.metadata?.["Import / support"];
    if (support !== undefined)
      warnings.push(
        `Imported support status: ${typeof support === "string" ? support : JSON.stringify(support)}. Replay does not certify calibration.`,
      );
  }
  const report = {
    schema_version: 1,
    kind: "analysis_sensitivity",
    request,
    code,
    work,
    baseline,
    variants,
    summary,
    calibration_uncertainty: {
      status: "not_evaluated",
      note: request.assumptions.calibration_note,
    },
    model_note: request.assumptions.model_note,
    status: variants.some((v) => v.status === "failed")
      ? "partial"
      : "complete",
    warnings: [...new Set(warnings)],
  };
  finiteJSON(report);
  report.report_sha256 = await sha256(
    new TextEncoder().encode(JSON.stringify(report)),
  );
  return report;
}
export async function sensitivityReport(
  request,
  source,
  reference,
  engineIdentity,
  codeIdentity,
) {
  const normalized = normalizeSensitivityRequest(request),
    code = identity(engineIdentity, codeIdentity),
    work = workFor(normalized, source);
  const replayed = await replay(
    normalized.baseline_recipe,
    source,
    reference,
    engineIdentity,
  );
  title(replayed, normalized.baseline_recipe);
  const baseline = compact(replayed, normalized.baseline_recipe),
    variants = [];
  for (const variant of normalized.variants) {
    try {
      const result = await analyze(
        invocation(normalized.baseline_recipe, variant),
        source,
        reference,
        engineIdentity,
      );
      variants.push({
        id: variant.id,
        label: variant.label,
        status: "succeeded",
        result: compact(result, result.recipe),
        error: null,
      });
    } catch (error) {
      variants.push({
        id: variant.id,
        label: variant.label,
        status: "failed",
        result: null,
        error: String(error.message ?? error),
      });
    }
  }
  return assembled(normalized, code, work, baseline, variants, source);
}
export async function verifySensitivityReport(
  report,
  source,
  reference,
  engineIdentity,
  codeIdentity,
) {
  finiteJSON(report);
  const saved = structuredClone(report),
    code = identity(engineIdentity, codeIdentity);
  if (!hash.test(saved.report_sha256 ?? ""))
    throw new Error("Missing sensitivity report hash.");
  const { report_sha256, ...unsigned } = saved;
  if (
    (await sha256(new TextEncoder().encode(JSON.stringify(unsigned)))) !==
    report_sha256
  )
    throw new Error("Sensitivity report hash mismatch.");
  if (!same(saved.code, code))
    throw new Error("Sensitivity code identity differs.");
  const request = normalizeSensitivityRequest(saved.request),
    work = workFor(request, source);
  if (
    !same(request, saved.request) ||
    !same(saved.baseline?.recipe, request.baseline_recipe) ||
    !Array.isArray(saved.variants) ||
    saved.variants.length !== request.variants.length
  )
    throw new Error("Sensitivity report definitions are inconsistent.");
  const replayed = await replay(
    request.baseline_recipe,
    source,
    reference,
    engineIdentity,
  );
  title(replayed, request.baseline_recipe);
  const baseline = compact(replayed, request.baseline_recipe),
    variants = [];
  for (let index = 0; index < request.variants.length; index++) {
    const definition = request.variants[index],
      record = saved.variants[index];
    if (
      !record ||
      record.id !== definition.id ||
      record.label !== definition.label
    )
      throw new Error("Sensitivity variant identity mismatch.");
    if (record.status === "succeeded") {
      if (record.error !== null || !record.result?.recipe)
        throw new Error("Invalid successful sensitivity record.");
      verifyDefinition(
        record.result.recipe,
        request.baseline_recipe,
        definition,
      );
      const value = await replay(
        record.result.recipe,
        source,
        reference,
        engineIdentity,
      );
      title(value, record.result.recipe);
      variants.push({
        id: definition.id,
        label: definition.label,
        status: "succeeded",
        result: compact(value, record.result.recipe),
        error: null,
      });
    } else if (record.status === "failed") {
      if (record.result !== null || typeof record.error !== "string")
        throw new Error("Invalid failed sensitivity record.");
      let error = null;
      try {
        await analyze(
          invocation(request.baseline_recipe, definition),
          source,
          reference,
          engineIdentity,
        );
      } catch (e) {
        error = String(e.message ?? e);
      }
      if (error === null || error !== record.error)
        throw new Error("Recorded sensitivity failure did not reproduce.");
      variants.push({
        id: definition.id,
        label: definition.label,
        status: "failed",
        result: null,
        error,
      });
    } else throw new Error("Invalid sensitivity variant status.");
  }
  const rebuilt = await assembled(
    request,
    code,
    work,
    baseline,
    variants,
    source,
  );
  if (!same(rebuilt, saved))
    throw new Error(
      "Sensitivity report content differs from replayed evidence.",
    );
  return structuredClone(saved);
}
function cell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  text = text.replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return typeof value !== "number" && /^[=+@-]/.test(text) ? "'" + text : text;
}
export function sensitivityTsv(report) {
  const rows = [
    [
      "metric",
      "unit",
      "member_id",
      "label",
      "status",
      "value",
      "baseline",
      "delta",
      "relative_delta",
      "reason",
    ],
  ];
  for (const metric of report.summary.metrics)
    for (const value of metric.values)
      rows.push([
        metric.key,
        metric.unit,
        value.id,
        value.label,
        value.status,
        value.value,
        metric.baseline,
        value.delta,
        value.relative_delta,
        value.reason,
      ]);
  return rows.map((row) => row.map(cell).join("\t")).join("\n") + "\n";
}
export function sensitivityReadme() {
  return `AFM processing and selection sensitivity evidence

Alternatives are applied to the same original source and channel. Their spread is sensitivity to recorded choices, not a confidence interval, independent-replicate count or calibration uncertainty. Assumption notes are not verified numerical calibration. Source bytes are not included; obtain exact source/reference files identified by recipe hashes.

Each successful variant has its own actual generated recipe timestamp/environment. Re-export verifies baseline and every successful recipe, binds operations/selections and fixed settings to the normalized request, and re-evaluates recorded failures. Report verification rebuilds numerical evidence without replacing saved recipe timestamps. Hashes are integrity checks, not signatures.

Report SHA256 is UTF8 JSON.stringify after removing report_sha256 in recorded property order. Code SHA256 covers sensitivity.js, sensitivity-service.js and engine.js joined by one newline in that order; individual file hashes are retained. Summary TSV includes baseline and all variant statuses, unavailable-value reasons and units. Relative delta is (variant-baseline)/abs(baseline), unavailable for zero baseline or unrepresentable arithmetic.

Execute: node scripts/sensitivity.mjs --request request.json --input SOURCE --out NEWDIR [--reference REFERENCE]
Verify/re-export: node scripts/sensitivity.mjs --report report.json --input SOURCE --out NEWDIR [--reference REFERENCE]
`;
}
export function sensitivityEntries(report) {
  const entries = {
    "report.json": JSON.stringify(report, null, 2) + "\n",
    "request.json": JSON.stringify(report.request, null, 2) + "\n",
    "baseline-recipe.json":
      JSON.stringify(report.baseline.recipe, null, 2) + "\n",
  };
  for (const variant of report.variants)
    if (variant.status === "succeeded")
      entries[`variant-${variant.id}-recipe.json`] =
        JSON.stringify(variant.result.recipe, null, 2) + "\n";
  entries["summary.tsv"] = sensitivityTsv(report);
  entries["README.txt"] = sensitivityReadme();
  return entries;
}
/** Caller must verify saved reports before export; this function only serializes. */
export function sensitivityBundle(report) {
  return tar(sensitivityEntries(report));
}
