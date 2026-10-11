# Portable recipe document v2

R04 adds a versioned interchange envelope around the existing schema-1 numerical recipe. Do not edit `engine.js`, `service.js` or existing report serializers: their source/byte identities remain valid. Legacy recipes continue through their existing replay path; portable documents are explicitly migrated and strictly replayed.

## Wire contract

Exactly `{kind:"afm_recipe_document",schema_version:2,canonicalization:"afm-json-v1",recipe,recipe_sha256,document_sha256}`. `recipe` is the complete schema-1 recipe. Recipe SHA-256 hashes UTF-8 canonical JSON of that recipe; document SHA-256 hashes canonical JSON of the complete envelope except `document_sha256`. Canonical JSON sorts object keys by JavaScript UTF-16 lexical order and uses JSON number/string encoding; array order stays significant. Accept only finite plain JSON, depth ≤64 and ≤1 MiB UTF-8. Reject cycles, accessors, symbols, sparse/extended arrays and non-JSON descriptors before invoking getters or serialization. Hashes are lowercase 64-digit hexadecimal, not signatures.

Canonical equality cannot discard fields or invent defaults. Normalize only property ordering. Unknown/missing recipe/envelope fields are errors. A verified document can be reordered recursively without changing either digest. Changed values, missing fields, reordered arrays, mismatched checksums and unsupported versions fail. Independently rehashed scientific changes must still fail strict replay when inconsistent with the loaded source/output.

## Embedded recipe validation

Require exactly the fields emitted by `service.analyze`: schema_version, engine, source, operations, selection, profile, plateaus, reference, output, environment, created_at, random_seed. Engine is exactly `{name:"afm-dashboard-js",version:"0.1.0",sha256}`. Source has exactly file/hash/channel/title/geometry; reference is null or exactly file/channel/hash (the hash property is `sha256`). Filenames are nonempty basenames (no slash, backslash, NUL, `.` or `..`). Channel IDs are nonempty strings; titles are strings. Geometry has exactly shape/xreal/yreal/xoff/yoff/xy_unit/z_unit: positive integer shape [height,width], positive finite extents, finite offsets, nullable string units. Reconstruct geometry in legacy engine field order.

Operations: 0–32 exact `{name,params}` entries; existing `normalizeOperation` must produce a canonically equal value (all emitted parameters present; no injected defaults). Selection has exactly roi/exclude_polygons and must equal existing normalization. Profile is null or two finite [x,y] points. Plateaus are null or two nullable ordered rectangle bounds structurally. The current numerical engine cannot replay a pair containing a null entry; migration/replay rejects such a configuration without repairing it. Reference/output/engine/source hashes must be valid; mask hash may be null. Output has exactly sha256/mask_sha256/measurement_sha256/geometry. Environment is exactly `{runtime:string}`; created_at is a valid ISO timestamp string retained verbatim; random_seed must be null. Preserve every value and all point/operation/polygon ordering.

## Module API (`web/recipe-interchange.js`)

- `canonicalRecipeJSON(value)`: bounded finite-JSON canonical representation; no IO.
- `normalizeLegacyRecipe(recipe)`: strict, detached schema-1 validation/reordering only.
- `decodeRecipeInput(value)`: async `{recipe,document}`. Portable input verifies both digests and returns normalized embedded recipe plus detached verified envelope. Schema-1 input is bounded/detached with original order preserved and document=null; unsupported kinds/versions reject. Legacy scientific validation remains in replay.
- `migrateRecipe(recipe,source,reference,engineIdentity)`: snapshot/validate before first await, normalize, bind source channel title and engine name, strictly replay original source/reference/calibration/output/mask/measurement, then return v2 document. No timestamps are generated; recorded recipe time/environment remain unchanged.
- `replayRecipeInput(input,source,reference,engineIdentity,fileOverride=null)`: legacy delegates unchanged to core replay. V2 decodes/verifies, requires actual source title and rejects a differing filename override, strictly replays the normalized embedded recipe, retains that saved recipe in result.recipe, and adds `interchange:{schema_version:2,document_sha256,recipe_sha256}`. Numerical arrays/statistics/warnings remain core results.

Validation of document checksums alone is not scientific replay. Derivation tools may decode portable recipe inputs and then use their existing strict replay/title binding. Batch reuses compatible settings to create new recipes; it is not replay of the template source.

## Integration and evidence

Browser: explicit **Save portable recipe** verifies the captured current analysis via POST `/api/recipe-document` with exactly `{recipe}`. Existing **Save recipe** remains legacy. Load recipe accepts both; restoration uses the verified result.recipe, including selection/profile/plateaus/reference. Dirty analyses cannot be migrated. `/api/replay` accepts either format and keeps ordinary JSON transport.

CLI: `scripts/recipe.mjs migrate --recipe PATH --input PATH [--reference PATH] --out NEWFILE` verifies and writes portable JSON without overwrite; `verify` accepts either format and prints bound identity/verification. Existing replay, batch, segment, texture, register and sensitivity-request CLI recipe inputs accept portable documents by decoding at their IO boundary. Saved report/journal hashes are not silently normalized. CLI batch template semantic comparison uses canonical JSON while preserving arrays; stored legacy recipes still require normal replay.

Tests must cover recursive key reordering, unknown/missing fields, nonfinite/nonplain input, limits, getter nonexecution, immutable async snapshots, geometry/unit/title/engine/source/reference/output/mask/measurement tampering (including recomputed envelope hashes), preserved timestamps, ordinary and missing-pixel fixtures, legacy behavior, browser/CLI source loading and dirty gating. Document checksums are integrity evidence, not author authentication. Plan manifests and derived report envelopes retain their existing byte-hash contracts.
