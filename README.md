# AFM Workbench

A local AFM viewer and reproducible surface-analysis workbench built with plain HTML and JavaScript. Measurements are parsed and processed in a browser worker; local imports are not uploaded. No framework, runtime packages, model connection, or Python server is required. A Rust engine can be added if measured workloads justify it.

The main toolbar’s **Documentation** link opens the [in-app guide and pilot SOPs](web/help.html), also available as [repository help](docs/help.md).

## Run

With Node.js 20 or later:

```sh
npm run dev
```

Open **http://127.0.0.1:4173/web/**. There is no installation or build step. Node serves static files only. You can instead serve `web/` and `data/` with another static server on localhost or HTTPS; opening `index.html` directly through `file://` will not provide the worker/module environment. The development server binds only to loopback.

For automatic browser refresh during development, run `AFM_LIVE_RELOAD=1 npm run dev`. It watches HTML, CSS and JavaScript in `web/`; imported session data is cleared on reload, so download runs before editing code.

The demo's network policy permits local requests only by default. Optional model planning will require an explicit provider origin at startup, for example `AFM_MODEL_ORIGIN=https://api.openai.com npm run dev` or `AFM_MODEL_ORIGIN=http://127.0.0.1:11434 npm run dev`. This permits that exact origin in the browser policy; it does not configure a model, send a request or store a credential. Other static hosts must configure their own CSP and the provider must allow browser CORS.

The supplied `.gwy` measurements appear in the file selector. Use **Import local files** for native GWYP, supported NanoScope binary images, calibrated Igor v5 image waves, and the supported JPK TIFF image subset. Detection uses file contents, including numbered Bruker extensions such as `.001`. Browser limits are 64 MiB per file and 256 MiB of source bytes per session; reload to clear the session. These byte limits do not estimate total working memory.

In **Measurements**, hover or drag over the histogram for bin bounds/counts, or over a line profile for recorded distance, height and source X/Y. Focus a plot and use arrows/Home/End for keyboard inspection. **Recalculate** sits in the inspection toolbar and remains available in expanded mode; cursor inspection does not recompute or change results.

## Measure threshold regions

In **Features**, capture the current processed analysis, enter a threshold in the displayed stored Z unit, choose four/eight-neighbor connectivity and boundary/minimum-size rules, then segment. The worker strictly replays the captured recipe before measuring. Regions retain calibrated areas, bounding dimensions, centroids and threshold-relative value differences; rejected candidates remain reviewable. A separate label preview leaves the main maps unchanged. JSON/TSV exports preserve provenance and exclusions. Regions are descriptive components, not material identifications or independent samples.

The same workflow runs locally from a saved recipe:

```sh
node scripts/segment.mjs --recipe artifacts/automatic/recipe.json \
  --input data/sample-input.gwy --threshold 1e-8 \
  --reference data/sample-reference.gwy \
  --out artifacts/threshold-regions
```

The threshold above is a command example, not a recommended threshold for this sample. See [measurement definitions and limits](docs/segmentation.md) and [reproducible segmentation exports](docs/segmentation-workflows.md).

## Measure spatial texture

In **Texture**, capture the processed analysis, choose detrending (`none`, `mean`, `plane`) and a PSD window (`boxcar`, periodic `hann`), then measure. Inspect calibrated two-sided PSD, linear autocorrelation and X/Y cuts. Display normalization and log colors do not change the evidence. Plots show labeled bin means; the TAR download retains full-resolution little-endian float64 arrays, axes, hashes and the captured recipe.

```sh
node scripts/texture.mjs --recipe artifacts/automatic/recipe.json \
  --input data/sample-input.gwy \
  --reference data/sample-reference.gwy \
  --out artifacts/spatial-texture --detrend mean --window hann
```

The selected domain must be a complete rectangle without internal missing/masked pixels. Zero-energy surfaces have no normalized ACF. Finite scan area and leveling affect estimates; no fitted correlation length is claimed. See [definitions and limits](docs/texture.md) and [exports and measured resource costs](docs/texture-workflows.md).

## Register captured surfaces

In **Registration**, capture a processed analysis as the fixed grid, select/process the other measurement in the main viewer, then capture it as moving. Choose a physical translation with nearest/bilinear interpolation, or explicitly request an integer correlation search. Review the transform, overlap, candidate ties, boundary warnings and residual map. Registration is separate from ordinary reference comparison and does not change either captured analysis.

```sh
node scripts/register.mjs --fixed-recipe fixed/recipe.json \
  --moving-recipe moving/recipe.json --fixed data/fixed.gwy --moving data/moving.gwy \
  --out registration-result --mode automatic --radius-x 4 --radius-y 4
```

Recorded references require `--fixed-reference` or `--moving-reference`. Automatic search requires equal pixel pitches and a bounded candidate workload; manual resampling supports different grids. Only compatible declared units are accepted. Rotations, scaling and local deformation are unsupported. JSON and verified TAR exports retain both recipes, transform, common-valid mask and full numerical rasters. See [registration definitions](docs/registration.md) and [replay/export workflow](docs/registration-workflows.md).

Use **Expand inspection** above the analysis tabs for a full-window view of plots, tables and evidence. **Return to viewer** or Escape restores the viewer and keyboard focus; captured results and processing settings remain unchanged.

## Review processing and selection sensitivity

In **Sensitivity**, capture a completed baseline, then add current processing/selection or an explicit baseline-plus-mean/plane alternative. Review the complete JSON definitions and assumption notes before selecting **Run reviewed alternatives**. Current processing can be copied only from the same source file, hash and channel; baseline profile, plateau and reference settings remain fixed. Captures stay independent of later viewer edits.

Inspect every successful or failed alternative, valid-pixel counts, signed/relative deltas and the recorded range membership. Selection changes can alter the measured population. These alternatives are not independent observations, and their spread is not calibration uncertainty. JSON retains the report; TSV and TAR downloads verify saved recipes and recorded failures before exporting.

```sh
node scripts/sensitivity.mjs --request request.json --input data/source.gwy --out sensitivity-run
node scripts/sensitivity.mjs --report sensitivity-run/report.json --input data/source.gwy --out verified-export
```

Add `--reference PATH` when required by the baseline; use new output directories. See [sensitivity definitions](docs/sensitivity.md) and [request, strict replay and export workflow](docs/sensitivity-workflows.md).

## Reviewed analysis plans

Open **Assistant**, refresh loaded sources, then choose a starter or expand **Ask for a plan**. Local starters require no model. Review the arguments, validate the plan, and select **Run reviewed plan**. Completed steps expose recipes and artifacts; **Verify evidence report** produces linked numeric claims and Markdown/JSON exports, including partial results after a failure or cancellation.

Optional model features require the provider origin configured above. Choose an OpenAI, Gemini or Groq preset, or a custom full Chat Completions endpoint, then enter its model ID and session-only API key. Use **Add current channel** to select up to eight source/channel contexts. Requests transmit your messages and those metadata; optionally select up to four verified surface-result steps to include compact recorded claims. Raw image arrays, recipes and journals stay local. The model may ask a clarification, draft a plan, or select exact evidence claims with artifact links; reviewed-mode execution remains a separate explicit action. Credentials stay in memory and are excluded from conversation exports. Provider CORS and JSON-mode support are required; only mocked provider responses have been tested. See [model configuration and audit](docs/model-provider.md), [local plans](docs/assistant-plans.md), and [evidence verification](docs/evidence-reports.md).

**Autonomous analysis** starts a bounded goal once, then proposes and executes plans automatically, passing verified surface evidence into subsequent rounds. Select sources, set round/tool limits, optionally select a pilot SOP and specify scientific choices/deviations, then Start goal. Pause/Stop act between local tools. Download the goal audit to retain requests, plans, artifacts and journal. Budget exhaustion is not goal completion. **Help agent** uses the same connection to explain the interface and pilot SOPs; it receives no selected measurements and has no tools. See [autonomous mode](docs/autonomous-agent.md), [help agent](docs/help-agent.md), [provider compatibility](docs/provider-compatibility.md), and [pilot SOPs](docs/workflow-sops.md).

## Local preview package

Build a deterministic local evaluation archive with `npm run preview:package -- --out NEW_DIRECTORY` (its parent must exist). It includes the application, runtime CLIs, a generated 16×16 surface, strict replay recipes and a file/engine verifier. No laboratory or external instrument measurements are bundled. See [build, clean-install verification and current release gates](docs/local-preview.md). Public licensing and hosted CI remain outstanding.

## First analysis

1. Select the raw `sample-input.gwy`, channel **Height_Trace**.
2. Choose **Robust plane + zero minimum** for an independent automatic baseline, or **Replay chemist points** to reuse the three manually chosen points stored in the supplied worked example.
3. Compare original and processed images. Choose a reference file and channel, then enable comparison to inspect the chemist’s output, another compatible loaded measurement, or the residual map. Independent color scales are the default; enable shared scales for a common numerical mapping.
4. Draw an ROI, exclusion polygon, or line profile, then recalculate. Exact-coordinate inputs provide a keyboard alternative. Coordinates and display limits use stored units, usually metres; labels use readable SI prefixes.
5. Save two separate ROIs as plateaus A and B to measure their mean-height difference and descriptive spreads. Plateau measurements use their own regions, independently of the global statistics ROI.
6. Save a recipe or export the analysis TAR. **Save portable recipe** adds verified canonical checksums that survive JSON object-key reordering; **Load recipe** accepts both formats. Replay requires the same input files and application version. See [portable recipe migration and verification](docs/recipe-interchange.md).

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




Performance and accessibility checks are documented in [browser performance](docs/browser-performance.md) and [accessibility audit](docs/accessibility-audit.md). Optional test tooling stays outside application dependencies. The synthetic workflow passes Chromium, Firefox and WebKit locally; screen-reader task review remains outstanding. Explicit performance budgets cover generated 512²–2048² images on the recorded workstation, with larger-image loading pauses documented.
