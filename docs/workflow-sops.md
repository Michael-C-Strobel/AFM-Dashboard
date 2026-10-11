# Pilot workflow SOPs

`web/workflow-sops.js` contains two draft standard operating procedures, both version `0.1.0` with status `pilot`. They provide reviewable guidance, not scientifically universal validation, automatic execution, or calibration certification.

| ID                  | Pilot procedure                                                                                                                                                      | Repository basis                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `height-roughness`  | Preserve an original-values baseline; explicitly choose appropriate leveling and selection; measure roughness, inspect acquisition diagnostics, and strictly replay. | [Architecture and units](architecture.md), [quality diagnostics](quality.md), [analysis sensitivity limits](sensitivity-workflows.md). |
| `chemist-reference` | Reproduce three-point leveling followed by minimum-zero shifting for the supplied raw/worked height trace pair, with explicit reviewed fit points.                   | [Reference-pair interpretation](architecture.md#reference-pair) and [recorded logs and source hashes](reference_pair.json).            |

## Scope and required choices

The reference case applies to `sample-input.gwy` and `sample-reference.gwy`, channel `0` (`Height_Trace`). The worked file records three-point leveling followed by zero-minimum processing. This SOP supplies no fit-point coordinates: the user must review and provide the points and parameters. Matching that example does not validate an independent automatic estimator or establish a universal leveling method.

The roughness procedure requires an explicit, justified processing choice. Preserve unknown units and import warnings; review masks, selections and excluded counts. Acquisition diagnostics describe the original source, separately from the processed surface. Candidates are not defect classifications. Neither SOP supplies scientific acceptance thresholds or derives confidence intervals from pixels or repeated regions.

## Versioning and deviations

When an SOP is selected, record its ID, version, pilot status and exact guidance with the selected source/channel identities in the goal audit. Record user-approved settings and deviations, including why they were needed, before execution. Recipes remain the executable record of actual processing; an SOP label is not evidence that every step was followed. The guidance module remains separate from execution; its caller is responsible for retaining this audit record. The autonomous panel now captures a structured SOP record before execution.

Change the SOP version when scientific guidance or required steps change. Keep the version used by an existing goal instead of silently replacing its guidance. The `sopPrompt(id)` export produces deterministic text under 4,000 characters, containing every prerequisite, procedure step, quality check, output and limitation. Unknown IDs are rejected.

Run `node --test tests/workflow-sops.test.mjs` to check immutable exports, identifiers, prompt completeness and documentation consistency.

## Check recorded conformance

In **Autonomous analysis**, select a pilot SOP and optionally expand **Expected SOP settings** before starting. **Start from selected source** prepares a JSON template; review the source identity, explicit operations and selection, provide a justification, and supply any reference and fit-point provenance. The template's empty operations mean no processing; they are not a leveling recommendation. The settings become part of the provider goal and the immutable local SOP record. Leaving settings blank is allowed, but the checker reports approval settings as missing.

After the goal ends, select **Check SOP records**. This verifies the journal and artifacts without executing analysis or contacting a provider. It checks original baseline, subsequent processing on the same source and selection, exact expected settings, acquisition diagnostics for roughness, and a strict replay of the processed recipe. The reference pilot additionally checks the specific source pair, operation order, radius, reference comparison and recorded fit-point provenance. Missing or conflicting evidence stays visible; declared deviations never waive checks.

The report distinguishes `met`, `missing` and `mismatch` for individual requirements. `records_complete` means the required records agree; it does not establish scientific suitability, authentic user approval, calibration, or an acceptable reference discrepancy. Those remain in `review_required`, alongside warning and deviation review. The pilots retain their `pilot` status.

**Download goal audit** includes the captured SOP and the most recent conformance report. Recheck that export locally with:

```sh
node scripts/check-sop.mjs afm-autonomous-audit.json > sop-report.json
```

Exit status is 0 for complete records, 2 for incomplete records, and 1 for invalid/unverifiable input. The command reconstructs the report from manifests and the journal; it does not trust a saved conformance result. Preserve original measurements separately for numerical replay.

Validation: 401 automated tests and the complete Chromium/Firefox/WebKit workflow pass. Synthetic positive and negative reference fixtures exercise the structural gates; a read-only supplied-pair baseline remains incomplete without reviewed fit-point settings and replay. No real provider or scientific SOP promotion is claimed.
