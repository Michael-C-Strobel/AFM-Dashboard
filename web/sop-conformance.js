/** Record completeness checks, not scientific suitability or approval certification. */
import { workflowSops, sopPrompt } from "./workflow-sops.js";
import { canonicalJSON } from "./tool-session.js";
import { validateToolCall } from "./tool-contracts.js";
import {
  createEvidenceReport,
  verifyEvidenceJournal,
} from "./evidence-report.js";
import { createModelObservations } from "./model-observations.js";
const canon = (v) => canonicalJSON(v, new Set(), 0, 128);
const equal = (a, b) => canon(a) === canon(b);
const clone = (v) => {
  canon(v);
  return structuredClone(v);
};
const fail = () => {
  throw Error("Invalid SOP conformance input or source binding.");
};
const text = (v, required = false) => {
  if (typeof v !== "string" || v.length > 2000 || (required && !v.trim()))
    fail();
  return v;
};
const exact = (v, keys) => {
  if (
    !v ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail();
};
const freeze = (v) => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
function tuple(v) {
  exact(v, ["file", "source_sha256", "channel"]);
  return validateToolCall({ name: "check_quality", arguments: v }).arguments;
}
const identity = (r) => ({
  file: r.file,
  source_sha256: r.sha256,
  channel: r.channel,
});
export function createSopRecord(id, options = {}) {
  const input = clone(options);
  if (new TextEncoder().encode(JSON.stringify(input)).length > 16384) fail();
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !["approved_settings", "deviations"].includes(k),
    )
  )
    fail();
  const sop = workflowSops.find((s) => s.id === id);
  if (!sop) fail();
  const approved = input.approved_settings ?? null;
  let settings = null;
  if (approved !== null) {
    const allowed = [
      "source",
      "operations",
      "selection",
      "reference",
      "justification",
      "fit_point_provenance",
    ];
    if (
      !approved ||
      Array.isArray(approved) ||
      Object.keys(approved).some((k) => !allowed.includes(k)) ||
      !["source", "operations", "selection", "justification"].every((k) =>
        Object.hasOwn(approved, k),
      )
    )
      fail();
    tuple(approved.source);
    if (approved.reference != null) tuple(approved.reference);
    const a = validateToolCall({
      name: "analyze_surface",
      arguments: {
        ...approved.source,
        operations: approved.operations,
        selection: approved.selection,
        reference: approved.reference ?? null,
      },
    }).arguments;
    settings = {
      source: clone(approved.source),
      operations: a.operations,
      selection: a.selection,
      reference: a.reference,
      justification: text(approved.justification, true),
      fit_point_provenance: text(approved.fit_point_provenance ?? ""),
    };
  }
  return freeze({
    id: sop.id,
    version: sop.version,
    guidance: sopPrompt(id),
    approved_settings: settings,
    deviations: text(input.deviations ?? ""),
  });
}
const RAW = {
  file: "sample-input.gwy",
  source_sha256:
    "ea0287a8afbed275d2d780f31508f89bd937796ab357f5a7d9389152e27abaab",
  channel: "0",
};
const REF = {
  file: "sample-reference.gwy",
  source_sha256:
    "4e72274c8ec3077857c5ab943c04efeb541c2e23c7fa07f2b8b996d2ee288dec",
  channel: "0",
};
export async function checkSopConformance(raw) {
  const input = clone(raw);
  exact(input, ["record", "runs", "journal", "sources"]);
  const { record, runs, journal, sources } = input;
  exact(record, [
    "id",
    "version",
    "guidance",
    "approved_settings",
    "deviations",
  ]);
  if (
    !equal(
      record,
      createSopRecord(record.id, {
        approved_settings: record.approved_settings,
        deviations: record.deviations,
      }),
    )
  )
    fail();
  if (
    !Array.isArray(runs) ||
    runs.length > 8 ||
    !Array.isArray(sources) ||
    sources.length < 1 ||
    sources.length > 8
  )
    fail();
  const selected = sources.map((s) => {
    const t = {
      file: s.file,
      source_sha256: s.source_sha256,
      channel: s.channel,
    };
    tuple(t);
    return t;
  });
  if (new Set(selected.map(canon)).size !== selected.length) fail();
  const bound = (t) => selected.some((s) => equal(s, t));
  const approved = record.approved_settings;
  if (
    approved &&
    (!bound(approved.source) ||
      (approved.reference && !bound(approved.reference)))
  )
    fail();
  const entries = [],
    warnings = new Set(),
    plans = [],
    used = new Set();
  let head = null;
  for (const manifest of runs) {
    const report = await createEvidenceReport({ manifest, journal });
    head = report.journal_head_sha256;
    plans.push(report.plan_sha256);
    report.warnings.forEach((w) => warnings.add(w));
    if (manifest.status !== "complete")
      warnings.add(
        `Recorded run ${report.plan_sha256} has status ${manifest.status}.`,
      );
    for (const step of manifest.steps) {
      if (step.result?.record) {
        const seq = step.result.record.sequence;
        if (used.has(seq)) fail();
        used.add(seq);
      }
      if (step.status !== "complete") continue;
      const call = step.resolved_call,
        a = call.arguments,
        result = step.result.artifact.content.result;
      if (
        a.file &&
        !selected.some(
          (s) =>
            s.file === a.file &&
            (!a.source_sha256 || s.source_sha256 === a.source_sha256) &&
            (!a.channel || s.channel === a.channel),
        )
      )
        fail();
      if (a.reference && !bound(a.reference)) fail();
      if (
        a.reference_channel &&
        !bound({
          file: a.file,
          source_sha256: a.source_sha256,
          channel: a.reference_channel,
        })
      )
        fail();
      if (
        result.recipe &&
        (!bound(identity(result.recipe.source)) ||
          (result.recipe.reference &&
            !bound(identity(result.recipe.reference))))
      )
        fail();
      entries.push({
        manifest,
        step,
        call,
        result,
        seq: step.result.record.sequence,
        id: step.result.artifact.id,
      });
    }
  }
  if (!runs.length) head = await verifyEvidenceJournal(journal);
  entries.sort((a, b) => a.seq - b.seq);
  const analyses = entries.filter((e) => e.call.name === "analyze_surface");
  const baseline = analyses.find(
    (e) =>
      e.result.recipe.operations.length === 0 &&
      (!approved ||
        (equal(identity(e.result.recipe.source), approved.source) &&
          equal(e.result.recipe.selection, approved.selection))) &&
      (record.id !== "chemist-reference" ||
        equal(identity(e.result.recipe.source), RAW)),
  );
  const candidates = baseline
    ? analyses.filter(
        (e) =>
          e.seq > baseline.seq &&
          equal(e.result.recipe.source, baseline.result.recipe.source) &&
          equal(e.result.recipe.selection, baseline.result.recipe.selection),
      )
    : [];
  const matches = (e) =>
    approved &&
    equal(identity(e.result.recipe.source), approved.source) &&
    equal(e.result.recipe.operations, approved.operations) &&
    equal(e.result.recipe.selection, approved.selection) &&
    equal(
      e.result.recipe.reference ? identity(e.result.recipe.reference) : null,
      approved.reference,
    );
  const processed = candidates.find(matches) ?? candidates[0];
  const checks = [];
  const check = (id, status, message, items = []) =>
    checks.push({
      id,
      status,
      message,
      artifacts: items.filter(Boolean).map((e) => e.id),
    });
  check(
    "baseline",
    baseline ? "met" : "missing",
    "Original values require an explicit empty-operation baseline.",
    [baseline],
  );
  check(
    "processed",
    processed
      ? approved && !matches(processed)
        ? "mismatch"
        : "met"
      : "missing",
    "Processed analysis must follow the same-source, same-selection baseline.",
    [processed],
  );
  check(
    "approved_settings",
    !approved
      ? "missing"
      : processed && matches(processed)
        ? "met"
        : "mismatch",
    "Recorded settings must match the explicit approved declaration; authenticity requires review.",
    processed && matches(processed) ? [processed] : [],
  );
  if (record.id === "height-roughness") {
    let found = null;
    for (const e of entries.filter((e) => e.call.name === "check_quality")) {
      const projected = await createModelObservations(
        { manifest: e.manifest, journal, step_ids: [e.step.id] },
        sources,
      );
      projected.warnings.forEach((w) => warnings.add(w));
      if (
        baseline &&
        equal(
          projected.observations[0].source,
          identity(baseline.result.recipe.source),
        ) &&
        equal(e.call.arguments.selection, baseline.result.recipe.selection)
      )
        found ??= e;
    }
    check(
      "quality",
      found ? "met" : "missing",
      "Original-source diagnostics must record the baseline selection.",
      [found],
    );
  }
  const replay =
    processed &&
    entries.find(
      (e) =>
        e.call.name === "replay_recipe" &&
        e.manifest === processed.manifest &&
        e.seq > processed.seq &&
        e.call.arguments.recipe_artifact === processed.id &&
        e.result.replay_verified === true &&
        equal(
          { ...e.result.recipe, created_at: null },
          { ...processed.result.recipe, created_at: null },
        ),
    );
  check(
    "replay",
    replay ? "met" : "missing",
    "Strict replay must reference the processed artifact earlier in the same plan; execution timestamps may differ.",
    [replay],
  );
  if (record.id === "chemist-reference") {
    const r = processed?.result,
      ops = r?.recipe.operations,
      cp = r?.comparison;
    const referenceEvidence =
      processed &&
      entries.find((e) => {
        if (e.call.name === "analyze_surface")
          return (
            equal(identity(e.result.recipe.source), REF) &&
            equal(e.result.recipe.source.geometry, r.recipe.source.geometry)
          );
        if (
          e.call.name !== "inspect_source" ||
          e.result.file !== REF.file ||
          e.result.sha256 !== REF.source_sha256 ||
          e.call.arguments.file !== REF.file
        )
          return false;
        const c = e.result.channels?.find((c) => c.id === REF.channel);
        if (!c) return false;
        const g = Object.fromEntries(
          ["shape", "xreal", "yreal", "xoff", "yoff", "xy_unit", "z_unit"].map(
            (k) => [k, c[k]],
          ),
        );
        return (
          Object.values(g).every((v) => v !== undefined) &&
          equal(g, r.recipe.source.geometry)
        );
      });
    const valid =
      approved &&
      text(approved.fit_point_provenance).trim() &&
      processed &&
      matches(processed) &&
      equal(identity(r.recipe.source), RAW) &&
      equal(r.recipe.reference ? identity(r.recipe.reference) : null, REF) &&
      ops.length === 2 &&
      ops[0].name === "three_point" &&
      ops[0].params.radius === 1 &&
      ops[1].name === "zero_min" &&
      equal(r.recipe.source.geometry, r.recipe.output.geometry) &&
      referenceEvidence &&
      sources.every(
        (s) =>
          !equal(
            {
              file: s.file,
              source_sha256: s.source_sha256,
              channel: s.channel,
            },
            REF,
          ) ||
          !s.geometry ||
          equal(s.geometry, r.recipe.source.geometry),
      ) &&
      cp &&
      ["rmse", "mae", "max_abs", "mean_difference"].every((k) =>
        Number.isFinite(cp[k]),
      ) &&
      Number.isSafeInteger(cp.valid_count) &&
      cp.valid_count > 0;
    check(
      "reference",
      valid ? "met" : !referenceEvidence ? "missing" : "mismatch",
      "The fixed raw/worked pair requires documented fit points, radius-1 three-point then zero-min processing and finite comparison records; no discrepancy threshold is imposed.",
      valid ? [processed, referenceEvidence] : [],
    );
  }
  check(
    "run_outcomes",
    runs.length && runs.every((r) => r.status === "complete")
      ? "met"
      : "missing",
    "Every supplied run must be complete; failed or incomplete runs remain unresolved.",
  );
  return {
    schema_version: 1,
    sop: { id: record.id, version: record.version },
    status: checks.every((c) => c.status === "met")
      ? "records_complete"
      : "incomplete",
    checks,
    review_required: [
      "Review scientific suitability, calibration, masks and all warnings.",
      "Verify approval authenticity; recorded declarations are not independent approval evidence.",
      "Review deviations; declarations do not waive missing records.",
      ...(record.id === "chemist-reference"
        ? [
            "Review reference discrepancies; agreement does not establish general performance.",
          ]
        : []),
    ],
    deviations: record.deviations,
    warnings: [...warnings],
    plan_sha256: plans,
    journal_head_sha256: head,
  };
}
