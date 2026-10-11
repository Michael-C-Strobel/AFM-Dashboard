# Row and column polynomial correction

Choose **Line polynomial correction** in Data & processing, select Rows or Columns and degree 0–3, then **Add operation & apply**. Degree 0 subtracts each selected line mean; higher degrees remove independently fitted slope, quadratic bow or cubic background. Minimum-zero shifting is a separate operation. Save an unprocessed baseline first and compare the resulting map, profiles and roughness; use Undo to restore the preceding pipeline.

## Fit and application domains

The fit uses finite pixels inside the current ROI, excluding imported masks and drawn exclusion polygons. Every fitted line is corrected across its full finite extent, including outside the fit region. Excluded pixels remain excluded; nonfinite values and the original mask are retained. No line is interpolated from its neighbors.

A line with zero selected pixels remains unchanged and appears in `skipped_lines`. A line with 1 through `degree` selected pixels rejects the entire operation. Numerically rank-deficient fits and nonfinite corrections also reject; the input data is never modified. A failure does not return a partially corrected image.

The current selection controls both fitting and measurements. Changing it and recalculating refits the pipeline; it is not a separate frozen background mask. Separate named fit/measurement selections remain V05 work. Narrow fit intervals require extrapolation and can greatly amplify uncertainty. This operation is ordinary least squares, not robust outlier rejection or automatic scar detection.

## Numerical definition and records

Each line solves a degree-0–3 least-squares problem using streaming Givens QR, without forming normal equations. Heights are centered before fitting. Zero-based pixel indices are normalized to the midpoint and half-span of selected indices; a one-pixel degree-0 fit uses index scale 1. Rank rejection uses a diagonal threshold of `1e-12` relative to the largest QR diagonal.

History records each line’s selected count, index origin/scale, height origin, ascending polynomial coefficients and end-exclusive fit-index bounds. The polynomial is `height_origin + sum(coefficients[k] * t^k)`, where `t = (index - index_origin) / index_scale`. Physical pixel centers follow `axis_offset + (index + 0.5) * axis_pitch`; lateral/vertical units and these calibration fields are recorded. Coefficients use the stored vertical unit. Index normalization avoids loss of precision when an image has a large physical offset.

The operation is `line_polynomial` with `{axis: "rows"|"columns", degree: 0|1|2|3}`; defaults are rows and degree 1. The typed-agent catalog uses the same validation. All choices survive recipes, batch templates and strict replay.

## Evidence and scope

The general method is described in [Gwyddion’s scan-line correction guide](https://gwyddion.net/documentation/user-guide-en/scan-line-defects.html), reviewed 2026-10-11. Our explicit empty-line, rank, selection and application rules above define this implementation; agreement with a description is not numerical parity with a particular Gwyddion release.

Validation includes known polynomial backgrounds, excluded features, both axes/degrees, offset/anisotropic geometry, underdetermined rejection and input nonmutation. The [independent NumPy report](line-polynomial-validation.json) covers 30 generated cases: 24 full-array comparisons pass and six underdetermined cases reject in both implementations. Maximum observed absolute difference is 4.79765e-23 m; the fixed acceptance tolerance is `1e-15 + 1e-9 * maxabs(reference)`. This tolerance can dominate nearly zero residuals. Masks/nonfinite values match exactly and source fingerprints remain unchanged. `tests/line-polynomial.test.mjs` adds 15 analytic, precision, rank, mask and replay checks; `tests/browser-line-polynomial.mjs` exercises the real worker and controls.

Reproduce with an existing Python environment containing NumPy (the recorded run uses Python 3.11.15 and NumPy 2.4.6):

```sh
node --test tests/line-polynomial.test.mjs
AFM_REFERENCE_PYTHON=/path/to/python node scripts/validate-line-polynomial.mjs
```

The validator writes `docs/line-polynomial-validation.json` only after all cases pass; missing Python/NumPy fails rather than silently skipping. Python is development-only and is not needed by the viewer. The Q02 published roughness procedure still needs additional methods and a fresh matched-workflow comparison; this synthetic check alone does not close that gap. Broader P06 background/facet fitting, previews, robust line estimators and scientific validation of sample-specific corrections remain separate work.

## Strict engine compatibility

This addition changes `engine.js`, and thus every format’s strict engine SHA-256. Engine semantic version remains 0.1.0; the exact source hash is authoritative. Existing recipes must be replayed with their matching application snapshot. Never edit an old recipe’s hash to make it load. Reapplying settings to the same original source with current code produces a new record. The supplied chemist example is regenerated and checked against its prior numerical output; this does not silently migrate saved user recipes.
