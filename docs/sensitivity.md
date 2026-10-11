# Processing and selection sensitivity

`web/sensitivity.js` provides pure request normalization, a work estimate, and descriptive summaries. It performs no analysis, replay, file access or source modification. The service must strictly replay the captured baseline and execute each complete variant definition against the original source/channel.

## Request contract

`normalizeSensitivityRequest({baseline_recipe,variants,assumptions})` accepts at most 256 KiB of finite plain JSON, rejects accessors, prototypes, cycles, sparse arrays and depth over 64, and returns a detached copy. Baseline recipe key order is preserved; replay semantics belong to the service.

Provide 1–16 variants, each exactly `{id,label,operations,selection}`. IDs match `[a-z][a-z0-9_-]{0,31}`, are unique and cannot be `baseline`; labels contain 1–120 characters. Operation lists contain at most 32 entries, normalized through the existing engine. Selections use its ROI/polygon rules. Assumptions have exactly `calibration_note` and `model_note`, each a string of at most 2000 characters. Notes are not numerical calibration evidence.

`sensitivityWork(request,sourcePixelCount)` counts source pixels times the sum of `max(1,operations.length)` over baseline and variants. Limits are 4,194,304 source pixels and 134,217,728 estimated pixel passes. This conservative gate is not a runtime prediction or a complete cost model for iterative operations.

## Summary contract

`summarizeSensitivity(baselineCompact,variantRecords)` returns `{metrics,warnings}`. Variant records contain `id,label,status,result,error`; status is `succeeded` or `failed`. Metrics cover Sa, Sq, mean, minimum, maximum, peak-to-valley, area, valid count and excluded count, with plateau height and reference RMSE when present in the baseline.

Each metric records its unit, baseline, all values including baseline first, signed deltas and relative deltas `(value-baseline)/abs(baseline)`. Zero baselines, missing/failed measurements and arithmetic overflow yield nulls with reasons. Ranges include every finite successful value with explicit member IDs and count; range reasons distinguish unavailable values from overflow. No variant is deduplicated by raster hash: selection changes can alter measurements without changing stored raster bytes.

Warnings identify changed selections, output geometry and valid/excluded populations. Alternatives are not independent observations. Their spread is not a confidence interval, standard error, p-value or calibration uncertainty. Unknown units remain null. Measurements with units differing from the baseline are excluded from summary values, deltas and ranges with explicit reasons; their raw values remain in the compact result. Labels must contain non-whitespace text, and IDs reject all trailing whitespace. Run `node --test tests/sensitivity.test.mjs` for contract, arithmetic, resource and immutability checks.
