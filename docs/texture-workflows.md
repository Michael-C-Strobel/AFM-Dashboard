# Reproducible spatial texture exports

Texture consumes a captured analysis recipe and strictly replays it against the exact source bytes and engine identity before measurement. The source channel and title must match. The recipe's selection remains authoritative: callers cannot supply a separate selection. Imported masks, polygon holes and nonfinite samples within the selected rectangle are rejected by the estimator, not filled silently.

Run with Node 20 or newer:

```sh
node scripts/texture.mjs --recipe analysis/recipe.json --input data/measurement.gwy \
  --out texture-result --detrend mean --window hann
```

The output directory must not exist. Add `--reference PATH` when the input recipe records a comparison reference. Options are `--detrend none|mean|plane` and `--window boxcar|hann`; their normalized values are recorded. Defaults and mathematical definitions are documented in [texture.md](texture.md). No dependencies or application build are needed.

The directory contains `report.json`, the unchanged `input-recipe.json`, `README.txt`, full-resolution `psd.f64` and `acf.f64`, and `acf_normalized.f64` when zero-lag energy is nonzero. `texture.tar` packages those same files without input measurement bytes. Original measurements are never modified.

## Numerical arrays and display reductions

Raster files are headerless little-endian IEEE-754 float64, in row-major order. Byte offset is `8 * (row * width + column)`. Dimensions, SHA-256 hashes and regular axis metadata are in `report.arrays`. Coordinates follow `start + index * step`. Frequency axes use cycles per stored lateral unit; correlation axes use physical lags. Unknown units remain `null`.

Each JSON overview has at most 256 bins per axis; directional cuts have at most 2048 bins and pass through zero frequency or lag. Half-open bins are recorded explicitly with boundaries `floor(i*N/M)`. Coordinates and values are arithmetic means within those bins. These display reductions do not replace exported numerical arrays. The normalized ACF overview divides the ACF overview by zero-lag energy; it is explicitly null when normalization is undefined.

## Integrity and reproduction

`report_sha256` hashes UTF-8 `JSON.stringify(report)` before the hash property is appended, preserving property order. Raster hashes cover exact exported bytes. Code identity records individual file hashes and the hash of UTF-8 source texts joined with one newline in this order: `fft.js`, `texture.js`, `texture-service.js`, `engine.js`. There is no new timestamp; the original recipe timestamp is retained. Import warnings remain visible. Integrity checks are not signatures or calibration certification.

The browser-compatible `textureRecipe(request, source, reference, engineIdentity, codeIdentity)` returns `{report, rasters}`; `textureBundle(result)` produces a deterministic TAR. The caller supplies code identity from its executing source files. Full arrays remain outside JSON. Verify with `node --test tests/texture-service.test.mjs`.
