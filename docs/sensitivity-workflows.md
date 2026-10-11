# Reproducible analysis sensitivity

Sensitivity runs compare one captured baseline with explicit processing and selection alternatives on the **same original source/channel**. They describe dependence on analysis choices, not independent replicates, confidence intervals or a calibration uncertainty budget. Calibration and model notes are retained as assumptions; calibration uncertainty remains `not_evaluated`.

## Request

A request contains exactly `baseline_recipe`, `variants`, and `assumptions`. Each of 1–16 variants supplies a unique `id`, readable `label`, complete `operations` list and `selection`. Profile, plateau and reference settings stay fixed to the baseline recipe. See [sensitivity-design.md](sensitivity-design.md) for schema, metric definitions and limits.

```json
{
  "baseline_recipe": "Replace this placeholder with the captured recipe object",
  "variants": [
    {
      "id": "mean",
      "label": "Subtract mean",
      "operations": [{ "name": "mean", "params": {} }],
      "selection": { "roi": null, "exclude_polygons": [] }
    }
  ],
  "assumptions": {
    "calibration_note": "Not evaluated",
    "model_note": "Processing alternatives"
  }
}
```

The baseline must strictly replay before alternatives execute. Work is preflighted against source pixel and estimated pass limits. Variants run sequentially from original data; a scientific failure becomes an explicit failed row and later variants still run. The baseline keeps its original captured recipe; successful alternatives retain their actual generated timestamps and environments. No source or image matrix is stored in the report.

## Execute or verify with the CLI

```sh
node scripts/sensitivity.mjs --request request.json --input data/source.gwy --out sensitivity-run
node scripts/sensitivity.mjs --report sensitivity-run/report.json --input data/source.gwy --out verified-export
```

Add `--reference PATH` when the baseline requires a reference. Choose exactly one of `--request` or `--report`. The output directory must not exist and its parent must exist. Outputs include `report.json`, normalized `request.json`, `baseline-recipe.json`, each successful `variant-ID-recipe.json`, `summary.tsv`, `README.txt` and deterministic `sensitivity.tar`. Raw data remain unchanged. Failed variant definitions and errors remain in the report/request even though they have no recipe export.

TSV contains baseline and every variant for each metric, including units, status, signed/relative delta and unavailable-value reasons. Tabs/newlines are escaped and formula-leading text is neutralized. Changed populations and missing results remain explicit. Ranges include recorded baseline/variant membership; they are not uncertainty intervals.

## Verification and integrity

`sensitivityReport(...)` executes a normalized request. `verifySensitivityReport(...)` verifies a detached saved report against the current source, reference, engine and exact sensitivity code identity. It strictly replays the baseline and every successful saved recipe, binds operations/selections and fixed settings to the recorded definitions, and re-evaluates every failed alternative. A failure that now succeeds or changes reason is rejected. Rebuilt compact results, summaries, warnings and all report fields must match exactly. Saved recipe timestamps are preserved during verification.

`report_sha256` hashes UTF-8 `JSON.stringify` of the unsigned report in recorded property order. The code digest covers UTF-8 `sensitivity.js`, `sensitivity-service.js`, and `engine.js` joined with one newline; individual hashes are retained. Integrity hashes are not signatures. `sensitivityBundle(report)` only serializes: callers must verify previously saved reports first. The CLI does this automatically in `--report` mode.

```sh
node --test tests/sensitivity-service.test.mjs
```

Tests cover known mean/ROI alternatives, isolated/all failures, strict source/reference binding, immutable requests, preserved creation times, independently rehashed metric/definition tampering, safe TSV, deterministic archives and CLI verification/re-export.
