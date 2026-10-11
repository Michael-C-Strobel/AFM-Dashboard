# Verified tool observations

G02e extends autonomous feedback beyond the eight existing surface-statistic claims. It does not change numerical engines, scientific recipes or the existing evidence-report contract.

## Projection boundary

`createModelObservations({manifest,journal,step_ids}, selectedSources)` snapshots finite plain inputs before asynchronous work, verifies the complete plan/journal/artifact chain with `createEvidenceReport`, then projects 1–16 explicitly named completed steps. Supported tools are `check_quality`, `segment_surface`, `measure_texture` and `analyze_sensitivity`. Unsupported, unfinished, repeated or missing step IDs reject. The output is limited to 64 KiB of UTF-8 JSON; excessive content rejects rather than silently dropping warnings or outcomes.

The output contains `schema_version`, plan and journal hashes, run status, observations and warnings. Each observation has a stable ID (`plan_sha256:step_id:tool`), step/tool/artifact identities, an exact source tuple, a typed summary and warnings. Only whitelisted fields are transmitted. No arbitrary result-object serialization is allowed.

Recorded source and reference identities must match both the verified call and selected tuples. Recipe-based tools additionally require their exact input recipe to match an earlier verified analysis/replay artifact named by the resolved call. Parameter identities must agree with the normalized call. Sensitivity baseline and successful variants retain their fixed source/reference identities. Hash verification establishes recorded integrity, not independent numerical re-analysis or calibration certification.

## Tool summaries

- **Quality:** geometry/units, valid/invalid/excluded counts, boundary sigma, row/column center/MAD/threshold and candidate counts, scalar reference-comparison metrics, and curated support information. Candidate counts are lengths of the recorded candidate lists; they are not proven defect counts. Median/difference arrays and candidate locations are excluded.
- **Segmentation:** algorithm, normalized parameters, calibrated geometry and pixel/region counts. Large accepted/excluded region tables and label arrays are excluded. Region counts do not establish particle identities or independent samples.
- **Texture:** algorithm, parameters, geometry/sampling, PSD integral/expected mean square/window energy and ACF zero lag, with definitions and units. PSD density units differ from integrated power units; the latter use the recorded squared-height ACF unit. Maps, cuts and numerical arrays remain local. This does not add a peak finder or correlation-length estimator.
- **Sensitivity:** recorded complete/partial status, calibration/model assumptions and bounded metric summaries including every outcome's status/value/delta/reason and range membership. Failed or incompatible alternatives remain visible. Full variant results, recipes and free-form exception messages are excluded. Spread remains descriptive sensitivity, not a confidence interval.

Preserve all warnings relevant to each selected result, including import/support, reference and unknown-unit warnings. Warnings from unrelated steps are not transmitted. Incomplete runs receive a generic incomplete-run notice without unrelated error text.

## Planning and execution

`proposePlan` accepts an optional `observationBundle`, verifies it locally and sends only `observationsContext`. Existing requests without this argument retain their shape. The combined request remains capped at 256 KiB, including source, history, surface evidence and observations. Credential checks inspect decoded values as well as serialized text.

A model may return exactly `{kind:"observations",observation_ids:[...]}` selecting 1–16 unique known IDs. Extra numerical values, unknown IDs and responses without supplied observations reject. The browser displays recorded summaries. Observation artifact IDs do not authorize cross-plan tool references.

Autonomous runs capture eligible completed steps after each round and supply verified observations on the next round. Surface claims remain separately available. A plan may adapt to the observations or the model may select observations as its final recorded response. An observation response is not independent proof of scientific goal achievement. Round/call limits, source scope, pause/stop and request auditing remain enforced.

## Required validation

Use synthetic production tool results for all four projections. Cover rehashed-but-inconsistent source/reference/recipe/parameter identities, artifact tampering, missing predecessors, unselected warning exclusion, failure visibility, omitted large arrays, byte bounds, pre-await snapshots and credential reflection. Exercise quality-only and mixed-tool adaptive rounds without requiring a surface claim merely to continue. Browser checks must display and export exact recorded summaries while keeping reviewed planning and existing surface evidence behavior intact.
