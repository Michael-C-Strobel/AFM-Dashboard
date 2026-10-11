/** Project verified surface claims only; never send local verification bundles. */
import { canonicalJSON } from "./tool-session.js";
import { createEvidenceReport } from "./evidence-report.js";
const encode = new TextEncoder();
export async function createModelEvidence(bundle, sources) {
  // Inspect descriptors before cloning so neither serialization nor cloning invokes getters.
  canonicalJSON(bundle, new Set(), 0, 128);
  canonicalJSON(sources, new Set(), 0, 128);
  const input = structuredClone(bundle),
    selected = structuredClone(sources);
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    !["manifest", "journal", "step_ids"].every((k) => Object.hasOwn(input, k))
  )
    throw new Error(
      "Evidence bundle requires exactly manifest, journal and step_ids.",
    );
  if (
    !Array.isArray(input.step_ids) ||
    input.step_ids.length < 1 ||
    input.step_ids.length > 4 ||
    new Set(input.step_ids).size !== input.step_ids.length ||
    input.step_ids.some(
      (id) =>
        typeof id !== "string" ||
        id.trim() !== id ||
        !/^[a-z][a-z0-9_-]{0,31}$/.test(id),
    )
  )
    throw new Error("Select 1–4 unique valid evidence step IDs.");
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length > 8 ||
    selected.some(
      (s) =>
        !s ||
        Array.isArray(s) ||
        typeof s.file !== "string" ||
        !s.file.length ||
        typeof s.channel !== "string" ||
        !s.channel.length ||
        typeof s.source_sha256 !== "string" ||
        s.source_sha256.length !== 64 ||
        !/^[a-f0-9]+$/.test(s.source_sha256),
    )
  )
    throw new Error("Evidence requires curated source identity tuples.");
  const report = await createEvidenceReport({
    manifest: input.manifest,
    journal: input.journal,
  });
  const claims = [],
    warnings = new Set();
  const selectedTuple = (source) =>
    selected.some(
      (s) =>
        s.file === source.file &&
        s.source_sha256 === source.sha256 &&
        s.channel === source.channel,
    );
  const addWarning = (text) => {
    if (report.warnings.includes(text)) warnings.add(text);
  };
  for (const id of input.step_ids) {
    const step = input.manifest.steps.find((s) => s.id === id),
      verified = report.claims.filter((c) => c.step_id === id);
    if (!step || !verified.length)
      throw new Error("Selected step has no verified surface claims: " + id);
    const result = step.result.artifact.content.result;
    const source = result.recipe.source;
    if (result.recipe.reference && !selectedTuple(result.recipe.reference))
      throw new Error(
        "Selected evidence reference is not among the transmitted source tuples.",
      );
    for (const values of [
      result.warnings,
      result.quality?.warnings,
      result.channel?.warnings,
    ])
      if (Array.isArray(values))
        for (const value of values)
          if (typeof value === "string") addWarning(value);
    const support = result.channel?.metadata?.["Import / support"];
    if (support !== undefined)
      addWarning(
        `Imported support status: ${typeof support === "string" ? support : canonicalJSON(support, new Set(), 0, 128)}. Artifact integrity does not certify the configuration or calibration.`,
      );
    if (result.statistics.z_unit === null || result.statistics.z_unit === "")
      addWarning(`Step ${id}: vertical units are unknown.`);
    if (result.statistics.xy_unit === null || result.statistics.xy_unit === "")
      addWarning(`Step ${id}: lateral units are unknown.`);
    if (
      !source ||
      !selected.some(
        (s) =>
          s.file === source.file &&
          s.source_sha256 === source.sha256 &&
          s.channel === source.channel,
      )
    )
      throw new Error(
        "Selected evidence source is not among the transmitted source tuples.",
      );
    for (const claim of verified)
      claims.push({
        ...claim,
        file: source.file,
        claim_id: `${report.plan_sha256}:${id}:${claim.metric}`,
      });
  }
  if (claims.length > 32)
    throw new Error("Projected evidence exceeds 32 claims.");
  if (input.manifest.status !== "complete")
    warnings.add(
      "The recorded run is incomplete; only explicitly selected verified surface claims are included.",
    );
  const evidence = {
    schema_version: 1,
    plan_sha256: report.plan_sha256,
    journal_head_sha256: report.journal_head_sha256,
    run_status: input.manifest.status,
    claims,
    warnings: [...warnings],
  };
  canonicalJSON(evidence, new Set(), 0, 128);
  if (encode.encode(JSON.stringify(evidence)).length > 65536)
    throw new Error(
      "Projected evidence exceeds 64 KiB; select fewer steps or a smaller recorded warning set.",
    );
  return evidence;
}
