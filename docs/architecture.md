# Architecture and implementation decisions

## Browser-native application

The maintainer requests plain HTML and JavaScript, with a Rust binary for heavier computation if needed. Use buildless ES modules, typed arrays, Canvas/SVG, and a Web Worker. No runtime dependencies, frontend framework, Python server, cloud service, or model connection are required. Node.js is only a development static server, test runner, and optional headless analysis CLI. The browser computes locally; user-selected files are not uploaded.

The GWYP adapter supplies calibrated channels. Pure analysis functions operate on copies of source arrays. The worker retains originals and exposes the same operations to the UI that the CLI imports. A recipe names every parameter and input hash so it can be replayed without chat. Benchmark representative data before introducing a Rust CLI or WebAssembly engine.

## Reproducibility and units

Recipes capture source SHA-256, channel calibration, operations, selections, versioned engine identity, and output hashes. Replay requires exact surface, mask, measurement, and geometry agreement. Cross-engine numerical discrepancies are reported; automatic tolerance-based acceptance is not implemented. The source remains unchanged. All numerical values retain stored units; only display formatting introduces SI prefixes. Unknown units stay unknown. Masked and nonfinite pixels are excluded explicitly.

## Reference pair

The user confirms `sample-input.gwy` as raw input and `_worked.gwy` as the chemist reference. The latter records three-point leveling and zero-minimum shifting on height trace. Store the selected points in an explicit recipe; evaluate independent automatic leveling separately. Do not fit automation to the reference during ordinary execution. Additional independently processed data is needed to establish general performance.

## Release boundaries



## Format adapters

`web/formats.js` detects bytes and dispatches to `gwy.js`, `nanoscope.js`, `ibw.js`, or `jpk.js`, producing the same calibrated channel interface for browser workers and CLI. `web/identity.js` lists source files contributing to each format’s replay identity. The original GWYP code identity remains unchanged; NanoScope recipes include the new reader and dispatch code. Unknown formats fail explicitly. See `docs/nanoscope-support.md` for the supported subset and independent validation.

`web/support.js` annotates readable inputs with validated/unverified configuration records. The UI keeps these visible after analysis/replay; metadata exports preserve them. Unknown encodings fail at the adapter boundary. IBW units and coordinate choices are implemented in its reader, not guessed in the UI.

## Acquisition diagnostics and saved-run comparisons

`web/quality.js` computes descriptive row/column diagnostics without changing source arrays. The worker exposes `/api/quality`; reports include the source hash, reader identity, diagnostic code hashes, selection, warnings, and optional explicit same-file reference. Diagnostics use the original channel even when the processing pipeline contains a crop or leveling step. They remain separate from analysis recipes.

`web/comparison.js` groups compatible saved-run metadata; `scripts/compare.mjs` exports complete included/excluded JSON and TSV rows. It never pools pixels or treats multiple regions as independent acquisitions. Sample independence requires an explicit source-hash-to-sample-ID map. Metadata comparison is not numerical replay verification.
