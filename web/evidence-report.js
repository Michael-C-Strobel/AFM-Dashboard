import { canonicalJSON } from "./tool-session.js";
import { validatePlan } from "./tool-plans.js";
import { validateToolCall, TOOL_VERSION } from "./tool-contracts.js";
import { sha256 } from "./engine.js";

const HASH = /^[a-f0-9]{64}$/;
const ARTIFACT = /^artifact:[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const canonical = (x) => canonicalJSON(x, new Set(), 0, 128);
const digest = (x) => sha256(encoder.encode(canonical(x)));
const same = (a, b) => canonical(a) === canonical(b);
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = (x) => typeof x === "string" && x.length > 0;
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const escape = (x) =>
  String(x)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|\-]/g, "\\$&")
    .replace(/[\r\n\t]+/g, " ");
const link = (id) => `[${id}](#artifact-${id.slice(9)})`;
const geometryKeys = [
  "shape",
  "xreal",
  "yreal",
  "xoff",
  "yoff",
  "xy_unit",
  "z_unit",
];
function geometry(g) {
  requireValue(
    plain(g) &&
      Array.isArray(g.shape) &&
      g.shape.length === 2 &&
      g.shape.every((n) => Number.isSafeInteger(n) && n > 0),
    "Missing or invalid result geometry",
  );
  requireValue(
    ["xreal", "yreal"].every((k) => Number.isFinite(g[k]) && g[k] > 0) &&
      ["xoff", "yoff"].every((k) => Number.isFinite(g[k])),
    "Invalid physical geometry",
  );
  requireValue(
    ["xy_unit", "z_unit"].every(
      (k) => Object.hasOwn(g, k) && (g[k] === null || typeof g[k] === "string"),
    ),
    "Missing geometry units",
  );
  return Object.fromEntries(geometryKeys.map((k) => [k, g[k]]));
}
function analysisClaims(step, artifact, warnings) {
  const result = artifact.content.result,
    recipe = result?.recipe,
    channel = result?.channel,
    stats = result?.statistics,
    call = step.resolved_call;
  requireValue(
    plain(recipe) &&
      recipe.schema_version === 1 &&
      plain(stats) &&
      plain(channel),
    "Analysis artifact lacks recipe, channel or statistics",
  );
  requireValue(
    HASH.test(recipe.source?.sha256 ?? "") &&
      text(recipe.source?.file) &&
      text(recipe.source?.channel) &&
      text(recipe.source?.title),
    "Invalid analysis source identity",
  );
  requireValue(
    recipe.source.sha256 === call.arguments.source_sha256 &&
      recipe.source.file === call.arguments.file,
    "Analysis source does not match verified call",
  );
  requireValue(
    String(channel.id) === recipe.source.channel &&
      channel.title === recipe.source.title,
    "Analysis channel identity mismatch",
  );
  requireValue(
    HASH.test(recipe.engine?.sha256 ?? "") &&
      HASH.test(recipe.output?.sha256 ?? "") &&
      HASH.test(recipe.output?.measurement_sha256 ?? ""),
    "Missing recipe engine or output hashes",
  );
  const source = geometry(recipe.source.geometry),
    output = geometry(recipe.output.geometry);
  requireValue(
    same(output, geometry(channel)),
    "Recipe/result geometry mismatch",
  );
  requireValue(
    source.xy_unit === output.xy_unit &&
      source.z_unit === output.z_unit &&
      stats.xy_unit === output.xy_unit &&
      stats.z_unit === output.z_unit,
    "Recipe/result unit mismatch",
  );
  requireValue(
    stats.area_unit === (stats.xy_unit === null ? null : `(${stats.xy_unit})²`),
    "Area unit mismatch",
  );
  requireValue(
    Array.isArray(recipe.operations) &&
      plain(recipe.selection) &&
      Object.hasOwn(recipe, "profile") &&
      Object.hasOwn(recipe, "plateaus"),
    "Missing explicit analysis operations or selections",
  );
  if (call.name === "analyze_surface") {
    requireValue(
      recipe.source.channel === call.arguments.channel,
      "Analysis channel does not match call",
    );
    for (const key of ["operations", "selection", "profile", "plateaus"])
      requireValue(
        same(recipe[key], call.arguments[key]),
        `Analysis ${key} does not match call`,
      );
    const reference = call.arguments.reference;
    requireValue(
      reference === null
        ? recipe.reference === null
        : recipe.reference?.file === reference.file &&
            recipe.reference?.channel === reference.channel &&
            recipe.reference?.sha256 === reference.source_sha256,
      "Analysis reference does not match call",
    );
  } else
    requireValue(
      result.replay_verified === true,
      "Replay artifact is not marked replay verified",
    );
  const keys = [
    "sa",
    "sq",
    "mean",
    "min",
    "max",
    "valid_count",
    "excluded_count",
    "area",
  ];
  requireValue(
    keys.every((k) => Number.isFinite(stats[k])) && text(stats.reference),
    "Missing or nonfinite analysis statistics",
  );
  requireValue(
    stats.sa >= 0 && stats.sq >= 0 && stats.min <= stats.max && stats.area > 0,
    "Invalid statistics ranges",
  );
  requireValue(
    Number.isSafeInteger(stats.valid_count) &&
      stats.valid_count > 0 &&
      Number.isSafeInteger(stats.excluded_count) &&
      stats.excluded_count >= 0 &&
      stats.valid_count + stats.excluded_count ===
        output.shape[0] * output.shape[1],
    "Invalid statistics counts",
  );
  const expectedArea =
    (((stats.valid_count * output.xreal) / output.shape[1]) * output.yreal) /
    output.shape[0];
  requireValue(
    Math.abs(stats.area - expectedArea) <= Math.abs(expectedArea) * 1e-10,
    "Statistics area does not match geometry",
  );
  const tolerance = Math.max(Math.abs(stats.min), Math.abs(stats.max)) * 1e-10;
  requireValue(
    stats.mean >= stats.min - tolerance && stats.mean <= stats.max + tolerance,
    "Statistics mean outside value range",
  );
  for (const values of [
    result.warnings,
    result.quality?.warnings,
    channel.warnings,
  ])
    if (Array.isArray(values))
      values
        .filter((v) => typeof v === "string")
        .forEach((v) => warnings.add(v));
  const support = channel.metadata?.["Import / support"];
  if (support !== undefined)
    warnings.add(
      `Imported support status: ${typeof support === "string" ? support : canonical(support)}. Artifact integrity does not certify the configuration or calibration.`,
    );
  if (stats.z_unit === null || stats.z_unit === "")
    warnings.add(`Step ${step.id}: vertical units are unknown.`);
  if (stats.xy_unit === null || stats.xy_unit === "")
    warnings.add(`Step ${step.id}: lateral units are unknown.`);
  const definitions = {
    sa: `Mean absolute deviation from ${stats.reference}`,
    sq: `Root mean square deviation from ${stats.reference}`,
    mean: "Arithmetic mean of selected valid values",
    min: "Minimum selected valid value",
    max: "Maximum selected valid value",
    valid_count: "Number of selected valid pixels",
    excluded_count:
      "Number of image pixels excluded from the selected valid population",
    area: "Selected valid pixel count multiplied by lateral pixel area",
  };
  return keys.map((metric) => ({
    step_id: step.id,
    artifact_id: artifact.id,
    source_sha256: recipe.source.sha256,
    channel: recipe.source.channel,
    metric,
    value: stats[metric],
    unit: ["valid_count", "excluded_count"].includes(metric)
      ? "pixels"
      : metric === "area"
        ? stats.area_unit
        : stats.z_unit,
    definition: definitions[metric],
  }));
}

export async function createEvidenceReport({ manifest, journal }) {
  // Validate before cloning so getters, cycles, nonfinite numbers and exotic objects cannot be silently coerced.
  canonical(manifest);
  canonical(journal);
  manifest = structuredClone(manifest);
  journal = structuredClone(journal);
  requireValue(
    journal.schema_version === 1 &&
      journal.tool_version === TOOL_VERSION &&
      Array.isArray(journal.records),
    "Invalid journal schema",
  );
  let previous = null;
  for (let i = 0; i < journal.records.length; i++) {
    const record = journal.records[i];
    requireValue(
      record.sequence === i + 1 &&
        record.tool_version === journal.tool_version &&
        record.previous_sha256 === previous &&
        HASH.test(record.sha256 ?? ""),
      "Broken journal sequence or chain",
    );
    requireValue(
      text(record.started_at) &&
        text(record.finished_at) &&
        ["succeeded", "failed"].includes(record.status),
      "Invalid journal record",
    );
    requireValue(
      record.status === "succeeded"
        ? ARTIFACT.test(record.artifact_id ?? "") && record.error === undefined
        : text(record.error) && record.artifact_id === undefined,
      "Invalid journal outcome",
    );
    const { sha256: hash, ...unsigned } = record;
    requireValue(
      (await digest(unsigned)) === hash,
      "Journal record hash mismatch",
    );
    previous = hash;
  }
  requireValue(journal.head_sha256 === previous, "Journal head mismatch");
  requireValue(
    manifest.schema_version === 1 &&
      ["running", "complete", "failed", "canceled"].includes(manifest.status),
    "Invalid plan manifest",
  );
  const normalized = validatePlan(manifest.plan);
  requireValue(
    JSON.stringify(normalized) === JSON.stringify(manifest.plan),
    "Plan is not normalized",
  );
  requireValue(
    HASH.test(manifest.plan_sha256 ?? "") &&
      (await sha256(encoder.encode(JSON.stringify(manifest.plan)))) ===
        manifest.plan_sha256,
    "Plan hash mismatch",
  );
  requireValue(
    Array.isArray(manifest.steps) &&
      manifest.steps.length === normalized.steps.length,
    "Plan step count mismatch",
  );
  if (manifest.status === "complete")
    requireValue(
      manifest.steps.every((s) => s.status === "complete"),
      "Complete plan contains incomplete steps",
    );
  if (manifest.status === "failed")
    requireValue(
      manifest.steps.some((s) => s.status === "failed") &&
        manifest.steps.every((s) =>
          ["complete", "failed", "not_run"].includes(s.status),
        ),
      "Failed manifest statuses are inconsistent",
    );
  if (manifest.status === "canceled")
    requireValue(
      manifest.steps.some((s) => s.status === "not_run") &&
        manifest.steps.every((s) => ["complete", "not_run"].includes(s.status)),
      "Canceled manifest statuses are inconsistent",
    );
  const claims = [],
    verified = new Map(),
    warnings = new Set(),
    usedSequences = new Set();
  let lastSequence = 0,
    stopped = false;
  for (let i = 0; i < manifest.steps.length; i++) {
    const step = manifest.steps[i],
      planned = normalized.steps[i];
    requireValue(
      step.id === planned.id &&
        ["pending", "running", "complete", "failed", "not_run"].includes(
          step.status,
        ),
      "Plan step identity or status mismatch",
    );
    if (stopped)
      requireValue(
        ["pending", "not_run"].includes(step.status),
        "Executed step follows an unfinished step",
      );
    if (step.status !== "complete") {
      stopped = true;
      warnings.add(
        `Step ${step.id}: ${step.status}${step.error ? `: ${step.error}` : ""}`,
      );
    }
    if (["pending", "running", "not_run"].includes(step.status)) {
      requireValue(
        step.result === undefined || step.result === null,
        "Unfinished step contains a result",
      );
      continue;
    }
    const expected = structuredClone(planned.call);
    for (const key of ["recipe_artifact", "artifact_id"]) {
      const value = expected.arguments[key];
      if (typeof value === "string" && value.startsWith("$step:")) {
        const predecessor = verified.get(value.slice(6));
        requireValue(predecessor, "Missing verified predecessor artifact");
        expected.arguments[key] = predecessor.id;
      }
    }
    requireValue(
      step.resolved_call &&
        same(validateToolCall(expected), step.resolved_call),
      "Resolved call differs from approved plan",
    );
    if (!step.result) {
      requireValue(
        step.status === "failed" && text(step.error),
        "Missing tool result",
      );
      continue;
    }
    const { record, artifact } = step.result;
    requireValue(
      plain(record) &&
        Number.isSafeInteger(record.sequence) &&
        record.sequence > lastSequence &&
        !usedSequences.has(record.sequence),
      "Invalid or reused tool record sequence",
    );
    requireValue(
      journal.records[record.sequence - 1] &&
        same(record, journal.records[record.sequence - 1]),
      "Tool record does not match journal",
    );
    requireValue(
      same(record.call, step.resolved_call),
      "Record call differs from resolved call",
    );
    usedSequences.add(record.sequence);
    lastSequence = record.sequence;
    if (step.status === "failed") {
      requireValue(
        record.status === "failed" && artifact === null,
        "Failed step has inconsistent tool result",
      );
      continue;
    }
    requireValue(
      record.status === "succeeded" &&
        plain(artifact) &&
        ARTIFACT.test(artifact.id ?? "") &&
        HASH.test(artifact.sha256 ?? ""),
      "Completed step lacks successful artifact",
    );
    requireValue(
      artifact.id === record.artifact_id &&
        artifact.id === "artifact:" + artifact.sha256 &&
        artifact.content?.tool_version === record.tool_version,
      "Artifact identity mismatch",
    );
    requireValue(
      (await digest(artifact.content)) === artifact.sha256,
      "Artifact content hash mismatch",
    );
    requireValue(
      same(artifact.content.call, record.call),
      "Artifact call differs from journal",
    );
    if (record.call.name === "replay_recipe") {
      const reference = [...verified.values()].find(
        (candidate) => candidate.id === record.call.arguments.recipe_artifact,
      );
      requireValue(
        reference &&
          ["analyze_surface", "replay_recipe"].includes(
            reference.content.call.name,
          ) &&
          plain(reference.content.result?.recipe),
        "Replay recipe lacks a preceding verified analysis artifact",
      );
      requireValue(
        same(artifact.content.result?.recipe, reference.content.result.recipe),
        "Replay recipe differs from its referenced analysis artifact",
      );
    }
    verified.set(step.id, artifact);
    if (["analyze_surface", "replay_recipe"].includes(record.call.name))
      claims.push(...analysisClaims(step, artifact, warnings));
    else {
      const result = artifact.content.result;
      if (Array.isArray(result?.warnings))
        result.warnings
          .filter((v) => typeof v === "string")
          .forEach((v) => warnings.add(v));
    }
  }
  const warningList = [...warnings];
  const lines = [
    "# " + escape(normalized.title),
    "",
    "Artifact and journal integrity verification is not a signature or calibration certification. This report states recorded numeric results; it does not establish independent sample counts, confidence intervals or defect identities.",
    "",
    `Plan status: **${manifest.status}**.`,
    `Plan SHA-256: ${manifest.plan_sha256}`,
    `Journal head SHA-256: ${journal.head_sha256 ?? "none"}`,
    "",
    "## Steps",
    "",
  ];
  for (let i = 0; i < manifest.steps.length; i++) {
    const step = manifest.steps[i],
      planned = normalized.steps[i],
      artifact = verified.get(step.id);
    lines.push(
      `- ${escape(step.id)}: **${step.status}**${step.error ? ` — ${escape(step.error)}` : ""}${artifact ? `; ${link(artifact.id)}` : ""}.`,
    );
    if (planned.rationale)
      lines.push(`  Rationale: ${escape(planned.rationale)}`);
    if (
      artifact &&
      ["analyze_surface", "replay_recipe"].includes(artifact.content.call.name)
    ) {
      const recipe = artifact.content.result.recipe;
      lines.push(
        `  Source: ${escape(recipe.source.file)}; SHA-256 ${recipe.source.sha256}; channel ${escape(recipe.source.channel)} (${escape(recipe.source.title)}).`,
        `  Operations: ${escape(JSON.stringify(recipe.operations))}. Selection/ROI: ${escape(JSON.stringify(recipe.selection))}.`,
      );
    }
  }
  lines.push(
    "",
    "## Verified numeric claims",
    "",
    "| Step | Metric | Value | Unit | Definition | Artifact |",
    "| --- | --- | ---: | --- | --- | --- |",
  );
  for (const c of claims)
    lines.push(
      `| ${escape(c.step_id)} | ${c.metric} | ${c.value} | ${escape(c.unit ?? "unknown")} | ${escape(c.definition)} | ${link(c.artifact_id)} |`,
    );
  if (!claims.length)
    lines.push(
      "",
      "No numeric analysis claims were produced by completed verified analysis steps.",
    );
  lines.push("", "## Warnings", "");
  lines.push(
    ...(warningList.length
      ? warningList.map((w) => "- " + escape(w))
      : ["No additional recorded warnings."]),
  );
  lines.push("", "## Artifacts", "");
  for (const artifact of new Map(
    [...verified.values()].map((a) => [a.id, a]),
  ).values())
    lines.push(`### Artifact ${artifact.sha256}`, "", `ID: ${artifact.id}`, "");
  return {
    schema_version: 1,
    plan_sha256: manifest.plan_sha256,
    journal_head_sha256: journal.head_sha256,
    claims,
    warnings: warningList,
    markdown: lines.join("\n") + "\n",
  };
}
