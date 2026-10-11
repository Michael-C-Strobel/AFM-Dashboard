# Reproducible spatial texture exports

Texture consumes a captured analysis recipe and strictly replays it against the exact source bytes and engine identity before measurement. The source channel and title must match. The recipe's selection remains authoritative: callers cannot supply a separate selection. Imported masks, polygon holes and nonfinite samples within the selected rectangle are rejected by the estimator, not filled silently.

Run with Node 20 or newer:

```sh
node scripts/texture.mjs --recipe analysis/recipe.json --input data/measurement.gwy \
  --out texture-result --detrend mean --window hann
```

The output directory must not exist. Add `--reference PATH` when the input recipe records a comparison reference. Options are `--detrend none|mean|plane` and `--window boxcar|hann`; their normalized values are recorded. Defaults and mathematical definitions are documented in [texture.md](texture.md). No dependencies or application build are needed.

The directory contains `report.json`, the unchanged `input-recipe.json`, `README.txt`, full-resolution `psd.f64` and `acf.f64`, and `acf_normalized.f64` when zero-lag energy is nonzero. `texture.tar` packages those same files without input measurement bytes. Original measurements are never modified.

## Capture and measured domain

In Texture, review **Capture domain** before capturing. **Current viewer selection** retains the completed viewer recipe. **Full processed image** creates a separate analysis with the ROI removed, rerunning the same operations while retaining crop operations, exclusion polygons and imported masks. ROI-dependent corrections can therefore change. This never replaces the viewer baseline. Changing the selector alone does not change an existing capture or result; use **Capture processed analysis** explicitly.

The captured-image preview retains its source/channel even after viewer edits. Dashed amber marks the requested domain; after measurement, solid amber marks the exact effective rectangle. Entire invalid outer rows/columns can disappear; invalid internal pixels or holes reject instead of being filled. Smaller rectangles reduce access to long spatial wavelengths.

Every report includes `domain`: selection kind, processed geometry, requested ROI, exclusion count, effective geometry, half-open pixel bounds and physical outer-edge bounds. Pixel indices refer to the processed output, including any crop, not necessarily the original raster. The same metadata is hashed and included in JSON and TAR. Historical reports without `domain` still retain their recipe, `geometry` and `source_bounds`; new metadata changes report/code hashes, not estimator formulas.

## Numerical arrays and display reductions

Raster files are headerless little-endian IEEE-754 float64, in row-major order. Byte offset is `8 * (row * width + column)`. Dimensions, SHA-256 hashes and regular axis metadata are in `report.arrays`. Coordinates follow `start + index * step`. Frequency axes use cycles per stored lateral unit; correlation axes use physical lags. Unknown units remain `null`.

Each JSON overview has at most 256 bins per axis; directional cuts have at most 2048 bins and pass through zero frequency or lag. Half-open bins are recorded explicitly with boundaries `floor(i*N/M)`. Coordinates and values are arithmetic means within those bins. These display reductions do not replace exported numerical arrays. The normalized ACF overview divides the ACF overview by zero-lag energy; it is explicitly null when normalization is undefined.

## Integrity and reproduction

`report_sha256` hashes UTF-8 `JSON.stringify(report)` before the hash property is appended, preserving property order. Raster hashes cover exact exported bytes. Code identity records individual file hashes and the hash of UTF-8 source texts joined with one newline in this order: `fft.js`, `texture.js`, `texture-service.js`, `engine.js`. There is no new timestamp; the original recipe timestamp is retained. Import warnings remain visible. Integrity checks are not signatures or calibration certification.

The browser-compatible `textureRecipe(request, source, reference, engineIdentity, codeIdentity)` returns `{report, rasters}`; `textureBundle(result)` produces a deterministic TAR. The caller supplies code identity from its executing source files. Full arrays remain outside JSON. Verify with `node --test tests/texture-service.test.mjs`.

## Measured resource budget

Run `node --expose-gc scripts/benchmark-texture.mjs 512` for a reproducible synthetic measurement; supported benchmark sizes are 128, 512, 1024 and the rejection case 1025. Output is JSON with code hashes, timing, memory snapshots and the Parseval discrepancy. The benchmark uses calibrated sinusoidal samples plus deterministic noise, mean detrending and periodic Hann. It includes strict recipe replay, numerical computation, hashing and overview generation, but excludes file decoding and browser rendering.

Single fresh-process observations on Node v20.20.2, Xeon E5-2667 v3 (24 logical CPUs), Linux:

| Source shape | Texture + evidence | JSON / TAR generation | Peak process RSS | Compact report / TAR |
| ------------ | -----------------: | --------------------: | ---------------: | -------------------: |
| 128²         |             347 ms |            31 / 57 ms |          109 MiB |       4.33 / 7.82 MB |
| 512²         |           1,668 ms |            30 / 74 ms |          241 MiB |      4.51 / 31.79 MB |
| 1024²        |           6,613 ms |           32 / 140 ms |          466 MiB |     4.73 / 107.76 MB |

These are observations, not browser guarantees. The 512² and 1024² code identity was `aa0c5272fea613d0476435913466e9c6e044354713df5a6c6bbe09bfa4b5db64`; the 128² run preceded added estimator-description fields and warnings (`457882096ee276a389c11eb76dda208e638a7937d77b962814c9c52b7804f7f5`), with unchanged formulas. Relative Parseval discrepancies were below `1e-13`. A 1025² square requires 4096² padded cells and rejects the 4,194,304-cell budget before spectral allocation. Rectangular inputs are limited by their actual padded product.

Retain this allocation gate. Large exports temporarily retain full numerical arrays and archive copies; source-byte import limits do not bound analysis memory. JavaScript remains the implementation for this bounded workload; larger domains or lower latency need separate measurements and a revised memory strategy before considering a Rust backend.
