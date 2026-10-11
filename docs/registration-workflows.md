# Reproducible translation registration

Registration compares two captured processed analyses without changing either recipe or source. Both recipes must strictly replay against exact input/reference hashes, analysis engine identities, calibrated geometry and processed output hashes. The service additionally verifies recorded channel identifiers and titles. Matching unit strings and successful replay do not certify calibration.

## CLI

```sh
node scripts/register.mjs \
  --fixed-recipe fixed-run/recipe.json --moving-recipe moving-run/recipe.json \
  --fixed data/fixed.gwy --moving data/moving.gwy --out registration \
  --mode manual --tx 2e-9 --ty 0 --interpolation bilinear
```

`tx,ty` use the stored lateral unit: **fixed physical position = moving position + translation**. The fixed grid remains unchanged. Difference means fixed minus aligned moving. No extrapolation or missing-pixel filling occurs. Use `--fixed-reference PATH` and/or `--moving-reference PATH` when the corresponding recipe records a reference.

For a bounded integer-shift proposal, replace manual parameters with:

```sh
--mode automatic --radius-x 4 --radius-y 4 --min-overlap-fraction 0.5
```

Do not mix manual and automatic parameters. Review automatic candidate scores, ties, boundary warnings and overlap rather than assuming a unique alignment. Unknown or incompatible units and unsupported grid/search configurations fail explicitly. See [registration-design.md](registration-design.md) for sampling and scoring definitions.

The output directory must be new and its parent must exist. The CLI writes `report.json`, `fixed-recipe.json`, `moving-recipe.json`, `README.txt`, `aligned.f64`, `difference.f64`, `valid.u8` and `registration.tar`. Existing targets are refused; raw inputs are never overwritten.

## Report and binary format

The report retains both original recipes, normalized parameters, transform, both geometries, aligned and unaligned descriptive metrics, search candidates, code identity and source/configuration warnings. Overview cells average **only common-valid pixels** in explicit half-open `x_bins`/`y_bins`, with per-bin valid counts and `null` for empty cells. Overview coordinates are bin-center physical means; overviews are not replacement numerical rasters.

Full arrays use the fixed grid, row-major order and no header. Aligned and difference values are little-endian float64; missing cells use canonical quiet NaN bytes `00 00 00 00 00 00 f8 7f`. `valid.u8` stores 1 for common-valid pixels and 0 otherwise. Array metadata records shape, dtype, units, center-axis `start/step/count` and SHA-256. Source bytes are not included in the archive.

The code SHA-256 covers UTF-8 `registration.js`, `registration-service.js`, and `engine.js` joined by one newline, in that order; each individual file hash is also retained. To verify `report_sha256`, remove that property and hash UTF-8 `JSON.stringify` of the remaining report in recorded property order. Archives have deterministic entry order and timestamps. Both input recipes retain their original timestamps; no new timestamp is introduced. Hashes establish integrity, not digital signatures.

## JavaScript service and tests

`registrationRecipe(request, fixedSource, movingSource, fixedReference, movingReference, engineIdentities, codeIdentity)` returns `{report, rasters}`. Request keys are exactly `fixed_recipe`, `moving_recipe`, `parameters`; both selections come only from their recipes. `engineIdentities` is exactly `{fixed, moving}`. `registrationBundle(result)` creates the same deterministic archive used by the CLI. Binary rasters remain outside the JSON report.

```sh
node --test tests/registration-service.test.mjs
```

Synthetic tests cover dual strict replay, title/calibration/hash failures, both references, immutable captured requests, valid-only overview means, canonical missing bytes, independent report/raster hashes, deterministic TAR contents and fresh-directory refusal.
