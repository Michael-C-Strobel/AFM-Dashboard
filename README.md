# AFM Workbench

A local AFM viewer and reproducible surface-analysis workbench built with plain HTML and JavaScript. Measurements are parsed and processed in a browser worker; local imports are not uploaded. No framework, runtime packages, model connection, or Python server is required. A Rust engine can be added if measured workloads justify it.

## Run

With Node.js 20 or later:

```sh
npm run dev
```

Open **http://127.0.0.1:4173/web/**. There is no installation or build step. Node serves static files only. You can instead serve `web/` and `data/` with another static server on localhost or HTTPS; opening `index.html` directly through `file://` will not provide the worker/module environment. The development server binds only to loopback.

The supplied `.gwy` measurements appear in the file selector. Use **Import local files** for native GWYP, supported NanoScope binary images, calibrated Igor v5 image waves, and the supported JPK TIFF image subset. Detection uses file contents, including numbered Bruker extensions such as `.001`. Browser limits are 64 MiB per file and 256 MiB of source bytes per session; reload to clear the session. These byte limits do not estimate total working memory.

## First analysis

1. Select the raw `sample-input.gwy`, channel **Height_Trace**.
2. Choose **Robust plane + zero minimum** for an independent automatic baseline, or **Replay chemist points** to reuse the three manually chosen points stored in the supplied worked example.
3. Compare original and processed images. Choose a reference file and channel, then enable comparison to inspect the chemist’s output, another compatible loaded measurement, or the residual map. Independent color scales are the default; enable shared scales for a common numerical mapping.
4. Draw an ROI, exclusion polygon, or line profile, then recalculate. Exact-coordinate inputs provide a keyboard alternative. Coordinates and display limits use stored units, usually metres; labels use readable SI prefixes.
5. Save two separate ROIs as plateaus A and B to measure their mean-height difference and descriptive spreads. Plateau measurements use their own regions, independently of the global statistics ROI.
6. Save a recipe or export the analysis TAR. Replay the recipe with the same input files and application version.

An analysis ROI controls fitting and statistics. If it excludes a recorded three-point leveling point, that operation is rejected. Gaussian filtering excludes masked/nonfinite pixels and drawn exclusion polygons; the ROI does not truncate its kernel. Source arrays are never edited.

## Available analysis

- Calibrated channel inspection, pan/zoom, palettes, scale bars, physical coordinates, metadata, stored selections, and processing logs.
- Mean, plane, quadratic, robust-plane, and three-point leveling; zero-minimum shifting; row/column offset correction; calibrated cropping; opt-in Gaussian filtering.
- Mean-referenced areal Sa and Sq, height distributions, extrema, valid area/counts, bilinear profiles, and two-plateau step heights.
- Matched-grid reference comparison with residuals, RMSE, MAE, and maximum absolute difference.
- Ordered recipes, branch/undo, strict replay verification, and headless batch processing.
- On-demand original-acquisition diagnostics with selected-pixel counts, row/column boundary candidates, explicit channel comparison, and a separate provenance report.
- Headless saved-run comparison tables with compatibility groups, exclusions, and explicit independent-sample IDs.

Sa and Sq are computed relative to the selected mean after the explicit preprocessing pipeline. Non-height channels retain their own units. Plateau standard deviations describe pixel spread; they are not confidence intervals or calibration uncertainty. Automatic leveling is a starting point requiring scientific review, particularly when the background occupies little of an image.

## Reproducibility and exports

Recipes record source SHA-256, channel identity/calibration, explicit operations and defaults, physical selections, profile/plateau coordinates, reference identity, software version, and analysis-code, surface, mask, and measurement hashes. History includes parent/artifact identifiers. Randomness is not used.

Replay rejects changed inputs, calibration, engine code, or output hashes. Cross-browser floating-point differences can produce an output-hash mismatch; they are reported rather than accepted silently. Preserve the matching application version alongside important recipes. Changing source formatting also changes the strict engine identity. Reader identities are format-specific; existing GWYP recipe identities remain unchanged. Configuration gating updates the NanoScope identity; older NanoScope recipes need their original application snapshot.

Browser exports contain `recipe.json`, `analysis.json`, calibrated `surface.tsv`, optional `profile.tsv`, and PNG/SVG figures. Original inputs remain external and are identified by hash. CLI exports include numerical records but omit browser-rendered figures. The TSV has one row per scan row, in stored vertical units; blank cells are imported masks or nonfinite values. ROI and polygon geometry remain in the recipe. Export is not a native `.gwy` round trip.

## Headless commands

```sh
# Independent automatic baseline and comparison
node scripts/afm.mjs analyze data/sample-input.gwy \
  --preset automatic --reference data/sample-reference.gwy \
  --out artifacts/automatic

# Verify the supplied manual-choice recipe on the exact original
node scripts/afm.mjs replay recipes/chemist-reference.json \
  --data-dir data --out artifacts/replay

# Save a batch template without a reference comparison
node scripts/afm.mjs analyze data/sample-input.gwy \
  --preset automatic --out artifacts/batch-template

# Apply a saved recipe to new compatible inputs; each gets a new provenance record
node scripts/afm.mjs batch artifacts/batch-template/recipe.json \
  data/sample-input.gwy --out artifacts/batch --resume

# Inspect original acquisition quality without processing it
node scripts/quality.mjs data/sample-input.gwy \
  --channel 0 --out artifacts/quality.json

# Compare saved runs; duplicates/incompatible records remain documented
node scripts/compare.mjs artifacts/automatic artifacts/replay \
  --out artifacts/comparison
```

Batch requires matching channel ID/title, geometry, units, and engine identity; it never silently rescales selections. Templates containing reference comparisons are rejected explicitly. Failures and unprocessed files are listed in `batch.json`. Ctrl-C stops between files. Resume verifies saved recipe replay before reusing a completed result. Batch application is distinct from verifying the original input's recipe.

Quality boundary candidates are descriptive flags, not identified defects or automatic repairs. Browser checks use the current ROI/polygons on the original channel and export a separate JSON report. Saved-run comparison reads metadata only; it does not replay arrays or infer sample independence. See [quality diagnostics](docs/quality.md) and [comparison tables](docs/comparison.md).

## Browser batch processing

After a successful analysis, disable reference comparison and recalculate before capturing a batch template. Select files in the batch panel, check compatibility, then start the queue. The captured template is a snapshot: later interactive changes do not change the job. Progress and per-file warnings/errors remain visible; cancellation finishes the current file and marks remaining files unprocessed.

Download the batch JSON manifest and each completed recipe or analysis TAR. A TAR download verifies the saved run by strict replay before export. Batch application generates a new recipe for each input; it is not verification of the original template against a new source. Browser results are session-local and have no persistent resume; download records before reloading. CLI `--resume` remains available. See [browser batch workflow](docs/browser-batch.md).

## Validation and reference evidence

```sh
npm test
npm run inventory
npm run benchmark
```

Synthetic numerical/importer tests do not require sample files or network access. CI runs these checks; the hosted CI workflow has not been executed in this checkout. Optional browser checks use an existing Playwright/Chromium installation; see [browser validation](docs/browser-validation.md).



## Compatibility and project status

Supported inputs are native **GWYP image data**, a validated **NanoScope binary image subset**, **Igor Binary Wave v5 image data**, and a validated **JPK TIFF image subset**. See [NanoScope support and limitations](docs/nanoscope-support.md) for storage, calibration, orientation, and independent numerical checks. See [IBW calibration and limits](docs/ibw-support.md), [JPK limitations](docs/jpk-support.md), and the [supported configuration matrix](docs/supported-inputs.md). Untested readable instrument configurations receive a persistent warning; unsupported formats/encodings are rejected. Legacy GWYO, older IBW, ordinary TIFF, spectroscopy, and other scientific objects are not yet supported. Unknown objects/fields are reported; units are preserved or marked unknown. Invalid instrument text bytes remain visible with warnings.

Four additional public reference files cover GWYP, SPM, IBW, and JPK. The GWYP sample imports three channels and the NanoScope and IBW samples each import eight channels, and the JPK sample imports ten. Provenance, local-only downloads, and redistribution gaps are recorded in [compatibility samples](docs/compatibility-samples.md). These external binaries are ignored and must not be included in releases without resolving their terms. The supplied laboratory data also needs redistribution approval before publication.



## Contributing

