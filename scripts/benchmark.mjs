/** Recompute manual-reference reproduction and independent automated baseline. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { webcrypto } from "node:crypto";
import {
  ROOT,
  RAW_NAME,
  WORKED_NAME,
  hash,
  loadSource,
  writeJSON,
} from "./inventory.mjs";
import { summarizeChannel } from "../web/gwy.js";
import { statistics } from "../web/engine.js";
import {
  analyze,
  replay,
  CHEMIST_PRESET,
  AUTOMATIC_PRESET,
} from "../web/service.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const code = await Promise.all(
  ["gwy.js", "engine.js", "service.js"].map((name) =>
    readFile(resolve(ROOT, "web", name), "utf8"),
  ),
);
const identity = hash(new TextEncoder().encode(code.join("\n")));
const raw = await loadSource(resolve(ROOT, "data", RAW_NAME)),
  worked = await loadSource(resolve(ROOT, "data", WORKED_NAME));
const before = statistics(raw.channels["0"]),
  target = statistics(worked.channels["0"]);
const outputs = [];
let recipe;
for (const [name, operations, interpretation] of [
  [
    "chemist_reference",
    CHEMIST_PRESET,
    "Reuses the chemist-selected coordinates: manual-target reproduction, not independently automated point selection.",
  ],
  [
    "automatic_baseline",
    AUTOMATIC_PRESET,
    "Independent robust plane fit and minimum-zero: does not use target pixels or manual point selection.",
  ],
]) {
  const request = {
    file: RAW_NAME,
    channel: "0",
    operations,
    reference: { file: WORKED_NAME, channel: "0" },
  };
  const start = performance.now();
  const result = await analyze(request, raw, worked, identity);
  const elapsed_ms = performance.now() - start;
  const cp = result.comparison;
  outputs.push({
    name,
    interpretation,
    operations: result.recipe.operations,
    elapsed_ms,
    statistics: result.statistics,
    errors: {
      definition: cp.definition,
      valid_count: cp.valid_count,
      rmse_m: cp.rmse,
      rmse_nm: cp.rmse * 1e9,
      mae_m: cp.mae,
      mae_nm: cp.mae * 1e9,
      max_abs_m: cp.max_abs,
      max_abs_nm: cp.max_abs * 1e9,
      mean_difference_m: cp.mean_difference,
      mean_difference_nm: cp.mean_difference * 1e9,
    },
    output_sha256: result.recipe.output.sha256,
    warnings: result.warnings,
  });
  if (name === "chemist_reference") recipe = result.recipe;
}
const replayResult = await replay(recipe, raw, worked, identity);
let native_sample;
const external = resolve(
  ROOT,
  "data/external/reference-only/gwyddion-samples.gwy",
);
try {
  const sample = await loadSource(external);
  native_sample = {
    file: "data/external/reference-only/gwyddion-samples.gwy",
    status: "imported",
    scope:
      "Native GWYP import coverage only; no general analysis or format validation claim.",
    sha256: sample.sha256,
    size_bytes: sample.size_bytes,
    channel_count: Object.keys(sample.channels).length,
    channels: Object.values(sample.channels).map(summarizeChannel),
    unsupported: sample.unsupported,
    warnings: sample.warnings,
  };
} catch (error) {
  native_sample = {
    file: "data/external/reference-only/gwyddion-samples.gwy",
    status: "failed",
    scope: "Native GWYP import coverage only",
    error: error.message,
  };
}
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  runtime: process.version,
  engine_sha256: identity,
  engine_identity_definition:
    "SHA-256 of UTF-8 text gwy.js + '\\n' + engine.js + '\\n' + service.js, matching web/worker.js",
  sources: {
    raw: { file: RAW_NAME, sha256: raw.sha256 },
    worked: { file: WORKED_NAME, sha256: worked.sha256 },
  },
  channel: "0",
  aliases: {
    chemist_reference: "manual-target reproduction",
    automatic_baseline: "independent automatic estimate",
  },
  units: {
    statistics: "stored height unit m; lateral unit m",
    error_m: "metres",
    error_nm: "nanometres (metres × 1e9)",
  },
  timing_note:
    "Single execution wall time including analysis, comparison and output hashing; environment-dependent, not a performance guarantee.",
  baseline_statistics: before,
  target_statistics: target,
  results: outputs,
  recipe_replay_verified: replayResult.replay_verified,
  native_sample,
};
await mkdir(resolve(ROOT, "docs"), { recursive: true });
await mkdir(resolve(ROOT, "recipes"), { recursive: true });
await writeJSON(resolve(ROOT, "docs/benchmark.json"), report);
await writeJSON(resolve(ROOT, "recipes/chemist-reference.json"), recipe);
const fmt = (v) => Number(v).toPrecision(7),
  rows = [
    ["Raw", before],
    ["Worked target", target],
    ...outputs.map((o) => [o.name, o.statistics]),
  ];
const markdown = `# AFM reference benchmark\n\nGenerated with Node ${process.version}. All results concern channel 0, Height_Trace, of the user-supplied raw/worked pair. The worked example is a chemist's target, not universal ground truth.\n\n## Reproduce\n\n\`\`\`bash\nnode scripts/inventory.mjs\nnode scripts/benchmark.mjs\n\`\`\`\n\nRerun after changing \`web/gwy.js\`, \`web/engine.js\`, or \`web/service.js\` to regenerate the exact worker-compatible engine identity and recipe. Identity: \`${identity}\`. Full source hashes, operations, error metrics and warnings are in [benchmark.json](benchmark.json).\n\n## Height statistics\n\nAll displayed values below are nanometres, converted from stored metres. Sa and Sq use the selected arithmetic mean as their reference.\n\n| Input / result | Mean (nm) | Sa (nm) | Sq (nm) |\n| --- | ---: | ---: | ---: |\n${rows.map(([name, s]) => `| ${name} | ${fmt(s.mean * 1e9)} | ${fmt(s.sa * 1e9)} | ${fmt(s.sq * 1e9)} |`).join("\n")}\n\n## Comparison with chemist target\n\n| Method | RMSE (nm) | Maximum absolute error (nm) | One run (ms) |\n| --- | ---: | ---: | ---: |\n${outputs.map((o) => `| ${o.name} | ${fmt(o.errors.rmse_nm)} | ${fmt(o.errors.max_abs_nm)} | ${fmt(o.elapsed_ms)} |`).join("\n")}\n\n- **chemist_reference** reuses the three saved manual points and radius 1, then zeroes the minimum. It tests reproduction of the chemist's selected processing.\n- **automatic_baseline** independently estimates a robust plane and zeroes the minimum; it does not use the worked target to fit the surface. A different result does not by itself establish which background estimate is scientifically preferable.\n\nRecipe replay hash verified: **${replayResult.replay_verified}**. Timings include analysis, comparison and output hashing and vary by machine. Original measurements remain unchanged.\n\n## External native sample import check\n\n\`data/external/reference-only/gwyddion-samples.gwy\`: **${native_sample.status}**${native_sample.status === "imported" ? `, ${native_sample.channel_count} image channels, ${native_sample.unsupported.length} other stored keys` : `: ${native_sample.error}`}. This checks native GWYP import coverage only; it does not establish successful general analysis or support for JPK, IBW or Nanoscope inputs. See the JSON report for per-channel calibration, units and warnings.\n`;
await writeFile(resolve(ROOT, "docs/benchmark.md"), markdown);
console.log(
  JSON.stringify(
    {
      engine_sha256: identity,
      results: outputs.map((o) => ({
        name: o.name,
        rmse_nm: o.errors.rmse_nm,
        elapsed_ms: o.elapsed_ms,
      })),
      replay_verified: replayResult.replay_verified,
      native_sample: {
        status: native_sample.status,
        channels: native_sample.channel_count,
        error: native_sample.error,
      },
    },
    null,
    2,
  ),
);
