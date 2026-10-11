# Portable recipe interchange

Portable v2 documents wrap a complete legacy numerical recipe with canonical recipe/document SHA-256 checksums. They preserve timestamps, runtime, geometry, operation order, selections and all other values. Object keys may be reordered recursively without changing the checksums; arrays remain ordered. This format provides integrity checks, not author authentication or calibration certification.

## Migrate and verify

```sh
node scripts/recipe.mjs migrate --recipe run/recipe.json --input data/source.gwy --out portable.json
node scripts/recipe.mjs verify --recipe portable.json --input data/source.gwy
```

Add `--reference PATH` when the recipe records a reference measurement. Migration validates the complete recipe and strictly replays it before writing. The output file must be new; its parent must exist. Existing files, including raw inputs reached by the same path, are not overwritten. Re-migrating a portable document first verifies its checksums and decodes its recipe.

Verification accepts legacy recipes or portable documents and prints the verified source, channel, engine/output identities and portable checksums where applicable. Portable replay checks the actual source title as well as source, engine, calibration and output/mask/measurement integrity. Checksum validity alone is not scientific replay. Unsupported versions, unknown/missing portable fields, changed values and incorrect checksums reject explicitly. Existing legacy replay behavior remains unchanged.

## Existing CLI workflows

These commands accept portable inputs at their recipe file boundary:

```sh
node scripts/afm.mjs replay portable.json --data-dir data --out replay
node scripts/afm.mjs batch portable.json data/sample-a.gwy data/sample-b.gwy --out batch
node scripts/segment.mjs --recipe portable.json --input data/source.gwy --out regions --threshold 2e-9
node scripts/texture.mjs --recipe portable.json --input data/source.gwy --out texture
node scripts/register.mjs --fixed-recipe fixed-portable.json --moving-recipe moving-portable.json --fixed data/fixed.gwy --moving data/moving.gwy --out registered
```

Batch applies compatible template settings to create **new recipes**; it does not replay the template's original source. Existing engine/channel/title/geometry gates remain. Resume compares operation/selection/profile/plateau settings canonically, preserving array order; saved legacy recipes still undergo strict replay.

A sensitivity `--request` may contain a portable document in `baseline_recipe`. That field is decoded before execution. Sensitivity `--report` input is passed unchanged to saved-report verification: hashed report/journal records are never silently reordered or migrated.

Decoded schema-1 recipes continue through the existing scientific services. Their report serializers and engine hashes are unchanged. When a portable document was supplied, output directories also retain it as `input-recipe-document.json`; registration uses `fixed-input-recipe-document.json` and `moving-input-recipe-document.json`. These are separate provenance sidecars, outside existing derived reports and TAR contents. Keep them with the derived output. A later sensitivity report-only re-export cannot recreate an absent sidecar; it retains the verified embedded legacy recipe.

## Wire format and tests

See [recipe-interchange-design.md](recipe-interchange-design.md) for exact v2 fields, canonicalization, schema checks and bounded JSON rules. Portable envelopes do not include original measurement bytes. Preserve the exact sources/references and application version needed for replay.

```sh
node --test tests/recipe-interchange-cli.test.mjs
```

Tests generate GWYP measurements at runtime and cover migration, recursively reordered documents, strict tamper/wrong-source rejection, exclusive creation, batch compatibility/resume, all derivation CLI boundaries and unchanged sensitivity report replay. They do not require laboratory fixtures.
