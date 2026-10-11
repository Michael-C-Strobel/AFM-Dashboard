# Recipe interchange audit (R04)

R04 is in progress. This evidence packet identifies existing serialization dependencies; it does not define or ship a migration. Reviewed against the code retained at `2376643`.

## Structural comparisons affected by key order

- `web/service.js` replay compares serialized source geometry and output geometry. Reordering identical geometry members can reject an otherwise unchanged recipe. Arrays, numeric calibration values and units must still match exactly.
- `scripts/afm.mjs` batch resume compares serialized operations, selection, profile and plateaus. Equivalent object key order can fail the saved/template comparison; operation and point array order is scientifically meaningful.
- `web/evidence-report.js` requires a saved plan to equal its normalized JSON serialization before separately checking the recorded plan hash. This is distinct from recipe geometry replay.

## Identities that must remain exact

Operation artifacts and measurement hashes in `web/service.js` use their generated JSON bytes. Raster/mask hashes use numerical bytes. Format-specific engine identities cover ordered module source texts (`web/identity.js`, `scripts/io.mjs`). These are integrity records, not disposable key-order comparisons.

Tool artifacts/journals already use canonical object-key serialization, preserving array order. `web/tool-session.js` nevertheless stores detached recipes with their original object order so schema-1 replay remains usable. Registration, texture and sensitivity report hashes intentionally cover recorded JSON order, and their verifiers check complete saved evidence.

## Existing compatibility boundary

Recipe schema is 1 and numerical engine version is 0.1.0. Core replay requires the current format-specific engine SHA, input/reference SHA, exact output/mask/measurement hashes and geometry. Core replay does not itself bind `engine.name` or `source.title`; several higher-level services already add those checks. A migration must define these semantics explicitly rather than accidentally weakening them.

The next implementation step is a versioned interchange design with reordered-key fixtures, malformed/missing/extra-field rejection, strict source/reference binding and unchanged scientific identities. Preserve old recipe/report replay behavior and document which bytes are migrated versus retained. Do not rewrite legacy numerical modules merely to change JSON comparison semantics.
