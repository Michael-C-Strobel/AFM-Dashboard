# Comparing saved analyses

```sh
node scripts/compare.mjs results/run-a results/run-b --out results/comparison
node scripts/compare.mjs results/run-a results/run-b --out results/comparison --samples samples.json
```

Each input directory must contain the `recipe.json` and `analysis.json` produced by `saveResult`. The command writes `comparison.json` and `comparison.tsv`, retaining a row for **every input**, including missing files, malformed JSON, invalid metrics and duplicates. Exit status is 1 when any row is excluded; multiple valid compatibility groups are not errors. Invalid CLI arguments or sample maps fail before output. Output files are overwritten when the output directory already exists.

This is a **metadata-only summary**: source arrays are not loaded, replayed or authenticated against raw files. Artifact SHA-256 values identify the exact JSON bytes read; internal recipe hashes are reported, not independently verified. Retain raw inputs, recipes, analysis artifacts and the recorded engine sources. The pure browser-compatible API is `compareRuns(records, sampleMap={})` from `web/comparison.js`, where records contain `{run, recipe, analysis, recipe_sha256, analysis_sha256, error?}`.

## Compatibility and exclusions

Groups require exact channel title, source and output geometry (including offsets and units), engine identity, explicit operations and operation versions, selection/ROI/exclusions, profile endpoints, plateau rectangles and statistics reference. Object key order is normalized; array order and numerical values remain exact. No unit conversion or averaging occurs. History, units, geometry, sample identity, Sa/Sq, minimum/maximum/mean, valid/excluded counts, area, artifact hashes and importer support/warnings remain visible in each row.

Duplicates require identical source SHA/channel, output SHA, mask SHA, measurement SHA **and compatibility key**. The first valid input is retained. Another ROI, profile, mask or measurement is not silently discarded merely because the surface hash matches.

Missing required provenance, mismatched geometry/units/history, unknown units and invalid/nonfinite metrics are excluded with reasons. The supported lateral unit labels are `m`, `cm`, `mm`, `um`, `µm`, `μm`, `nm`, `pm`, `Å`. Vertical units additionally recognize common explicitly enumerated force, voltage, current, pressure, energy, frequency, angle, time and dimensionless `1` labels; see `Z_UNITS` in the module for the exact list. Empty, `unknown`, `Arb`, compound and unrecognized labels are excluded conservatively. Even recognized equivalent labels, such as `um` and `µm`, form separate groups. Import support status and warnings are preserved; this summary does not establish scientific validity or override an importer caveat.

## Independent samples

`samples.json` explicitly maps source SHA-256 to nonempty independent sample identifiers:

```json
{
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": "sample-A",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": "sample-A"
}
```

Counts concern included rows only. `included_count` counts retained analysis rows; `acquisition_count` counts unique source hashes, so multiple channels/regions from one source do not add acquisitions. Each group's acquisition count is similarly unique within that group; group counts should not be added to infer a global count.

`unique_explicit_independent_sample_count` counts unique supplied IDs and is **null if any included acquisition lacks one**. `unassigned_acquisition_count` counts unique unassigned source hashes; `assigned_independent_sample_id_count` reports the explicitly assigned subset. No independent-sample count is inferred from filenames, channels or pixels. Metrics remain per analysis; pixels are never pooled and no population significance tests are performed.

## TSV and validation

TSV cells containing tabs, quotes or newlines are quoted, with quotes doubled. Text beginning with spreadsheet formula triggers (including whitespace-prefixed triggers) receives an apostrophe prefix; actual numerical columns remain numerical. JSON retains original strings. Use a TSV reader that supports quoted multiline cells.

Run `node --test tests/comparison.test.mjs`. Tests cover exact grouping, sample identities, duplicate rules, missing and malformed artifacts, unknown units, metrics, importer caveats, floating-point mean tolerance, safe TSV output, exact artifact hashes and real service-produced profile recipes.
