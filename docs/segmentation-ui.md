# Features: captured-surface segmentation

The Features inspection tab measures explicit threshold regions on a captured **processed** analysis. It is independent of the main viewer and its current controls. It does not identify particles, defects, materials, or independent samples.

## Workflow

1. Recalculate the main viewer, then select Capture current processed analysis. Capture refuses dirty or pending results. The detached snapshot records source/channel, calibration, source/output hashes, processing recipe, and ROI/polygon selection.
2. Enter a finite threshold in the displayed stored vertical unit. No threshold is proposed or accepted automatically. Choose inclusive above/below, 4/8 connectivity, minimum pixels, and boundary inclusion/exclusion.
3. Segment captured surface explicitly. The worker strictly replays the captured recipe before segmentation. Main viewer edits remain independent of the snapshot. Capturing another result or changing segmentation parameters clears previous measurements.
4. Inspect accepted regions, or enable Show excluded regions to review rejection reasons. Region buttons highlight the selected label and its pixel-cell bounding box. Tables render 100 rows per page; JSON/TSV exports include every accepted and excluded region.

## Preview and measurements

The dedicated canvas preserves calibrated physical aspect ratio, including non-square pixel pitch, and displays pixels without interpolation. Deterministic colors indicate accepted labels. Grayscale indicates eligible background; amber indicates threshold pixels rejected by region filters; slate indicates finite ROI/polygon-excluded pixels. Checkerboard indicates missing or source-masked values; those two cases cannot be distinguished from the exported processed matrix. Eligibility uses the existing engine's validMask and captured selection.

Area is projected pixel count times calibrated pixel area, not reconstructed surface area. Width/height describe bounding-box extents using pixel edges. Mean and threshold excursion retain the declared vertical unit, including electrical/arbitrary or unknown units. Excursion is max minus threshold for above, and threshold minus min for below. Source/import warnings and segmentation limitations remain visible. JSON exports retain the strict input recipe, code identity, parameters, report, labels, and report/label hashes; TSV contains complete region measurements and source/output/report identities.

## Validation

Start a local server and run the optional synthetic browser suite with an existing Playwright installation:

```sh
PORT=4174 node scripts/serve.mjs
AFM_BASE_URL=http://127.0.0.1:4174/web/ node tests/browser-segmentation.mjs
```

Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE for external cached installations. No packages or external data are downloaded. Fixtures are small GWYP containers built in memory and imported through the real file picker against an empty sample manifest.

Chromium 151 checks verify a 3×2 surface: three accepted pixels, 3e-12 m² area, 3e-6 m width and 1e-6 m height. Additional assertions cover diagonal 4/8 connectivity, boundary rejection, masks and ROI, refusal of dirty captures, independence from later main processing, byte-identical main maps during segmentation, source/report/code hashes, JSON/TSV exports, 578-region pagination, keyboard tab access, and responsive layouts. No browser console errors were observed. Local screenshots are /tmp/afm-features-desktop.png and /tmp/afm-features-mobile.png.
