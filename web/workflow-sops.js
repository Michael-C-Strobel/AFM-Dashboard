/** Pilot guidance only: no automatic scientific choices or execution. */
const freezeSop = (value) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        Array.isArray(item) ? Object.freeze(item) : item,
      ]),
    ),
  );
export const workflowSops = Object.freeze([
  freezeSop({
    id: "height-roughness",
    version: "0.1.0",
    status: "pilot",
    title: "Height roughness with a replayable baseline",
    prerequisites: [
      "Explicitly select the source hash and height channel; inspect lateral/vertical units, calibration, import support and warnings. Unknown units remain unknown.",
      "Review imported masks, nonfinite values and any user-defined ROI/exclusion polygons. Do not invent calibration, masks or selection coordinates.",
    ],
    procedure: [
      "Measure original values as a baseline, recording the exact selection and valid/excluded pixel counts.",
      "Ask the user to choose and justify appropriate leveling for the surface and analysis aim. Keep original values if no leveling is justified; do not silently apply a universal preset.",
      "Record every approved operation and parameter, then measure the processed surface using the recorded selection. Preserve the baseline for comparison.",
      "Run acquisition diagnostics on the original source with explicit diagnostic settings and selection; this report is separate from processed-surface analysis.",
      "Strictly replay the saved analysis recipe against the original bytes and recorded engine identity before accepting reproducibility.",
    ],
    qualityChecks: [
      "Review units, calibration/support warnings, masks, valid/excluded counts, selected area, and baseline versus processed Sa/Sq and range.",
      "Inspect diagnostic candidates in context: real surface steps can trigger them, and missing candidates do not certify a clean acquisition. No automatic repair or defect labels.",
      "Require exact replay verification; retain failures and unresolved warnings visibly. Do not invent acceptance thresholds.",
    ],
    outputs: [
      "Retain original bytes, source/channel identity, baseline and processed recipes, statistics with units/counts, diagnostic report and replay evidence.",
      "Record this SOP ID/version, user-approved choices, and any deviations with reasons in the goal audit.",
    ],
    limitations: [
      "Pilot guidance, not universal scientific validation or calibration certification. Leveling and selection can change roughness.",
      "Sa/Sq and within-region spreads are descriptive; pixels or repeated ROIs are not independent samples. Do not report confidence intervals from these measurements alone.",
    ],
  }),
  freezeSop({
    id: "chemist-reference",
    version: "0.1.0",
    status: "pilot",
    title: "Reproduce the supplied chemist reference processing",
    prerequisites: [
      "Select your own original and processed reference files and explicitly record their source hashes and height channels. No laboratory reference data is distributed.",
      "Inspect both channel calibrations, units, masks, geometry and import warnings. Require explicit user-reviewed fit points and all leveling parameters; if unavailable, ask rather than choose points autonomously.",
    ],
    procedure: [
      "Keep raw and worked arrays unchanged and record the original height statistics and selection.",
      "Reproduce this pair's recorded sequence: three-point leveling, then minimum-zero shifting. Store the explicit fit points and parameters in the recipe; do not infer coordinates from this SOP.",
      "Compare the processed height trace with the worked reference only after checking compatible geometry, units and common valid pixels. Record reference identity and difference metrics.",
      "Strictly replay the saved recipe against the original raw input and explicit worked reference; retain the resulting source, mask, measurement, geometry and output identities.",
      "Evaluate any independent automatic leveling separately; do not tune ordinary automation against this reference or present point reproduction as validation of an automatic estimator.",
    ],
    qualityChecks: [
      "Confirm operation order, explicit fit-point provenance, units, mask/selection treatment, valid counts, support warnings and reference binding.",
      "Report discrepancies and replay failures without silently relaxing tolerances or inventing an acceptance threshold.",
    ],
    outputs: [
      "Retain both original files, their hashes, the explicit processing recipe, baseline/processed statistics, reference differences and strict replay evidence.",
      "Record this SOP ID/version, fit-point choices, assumptions and deviations with reasons in the goal audit.",
    ],
    limitations: [
      "Pilot reconstruction of one user-supplied worked example, not universal scientific ground truth or a universally appropriate leveling method.",
      "A matching reference does not certify calibration or generalization. Additional independently processed measurements are needed to assess general performance.",
    ],
  }),
]);
export function sopPrompt(id) {
  const sop = workflowSops.find((item) => item.id === id);
  if (!sop) throw new Error("Unknown workflow SOP.");
  return [
    `SOP ${sop.id} / version ${sop.version} / status ${sop.status}`,
    sop.title,
    ...[
      ["prerequisites", "Prerequisites"],
      ["procedure", "Procedure"],
      ["qualityChecks", "Quality checks"],
      ["outputs", "Outputs"],
      ["limitations", "Limitations"],
    ].flatMap(([key, title]) => [
      title + ":",
      ...sop[key].map((text, index) => `${index + 1}. ${text}`),
    ]),
  ].join("\n");
}
