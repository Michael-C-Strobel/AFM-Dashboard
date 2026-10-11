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

When an SOP is selected, record its ID, version, pilot status and exact guidance with the selected source/channel identities in the goal audit. Record user-approved settings and deviations, including why they were needed, before execution. Recipes remain the executable record of actual processing; an SOP label is not evidence that every step was followed. The module provides guidance only; its caller is responsible for retaining this audit record.

Change the SOP version when scientific guidance or required steps change. Keep the version used by an existing goal instead of silently replacing its guidance. The `sopPrompt(id)` export produces deterministic text under 4,000 characters, containing every prerequisite, procedure step, quality check, output and limitation. Unknown IDs are rejected.

Run `node --test tests/workflow-sops.test.mjs` to check immutable exports, identifiers, prompt completeness and documentation consistency.
