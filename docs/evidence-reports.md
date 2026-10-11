# Artifact-linked scientific evidence reports

`await createEvidenceReport({manifest, journal})` from `web/evidence-report.js` creates a deterministic JSON report and Markdown presentation from a `runPlan` manifest and the associated `createToolSession().journal()` snapshot. It performs no file access, network calls, image processing or new analysis.

## Verification before reporting

The function rejects the entire report if any integrity check fails:

- Every journal record must have continuous sequence numbers, matching tool versions, the correct previous-record hash, a valid canonical content hash, and a matching journal head.
- The plan must match `validatePlan` normalization and its SHA-256 over **JSON.stringify(normalizedPlan)**. Manifest step IDs and order must match the plan.
- Each completed step must contain a successful record identical to its journal entry and an artifact whose ID, SHA-256, version, canonical content and normalized call agree. Step references are resolved only through preceding verified artifacts.
- Completed analysis results must agree with the verified call's source identity, source/channel identity, output geometry and units. Analyze calls also bind their exact operations, selection, profile, plateaus and reference. Replay results must be explicitly marked replay-verified and contain exactly the recipe of a preceding verified analysis artifact in the same manifest. A replay-only manifest referencing an artifact outside the manifest lacks the necessary evidence and is rejected.
- Statistics must be finite, pixel counts must match image dimensions, and area must agree with valid pixel count and calibration. Unknown units remain unknown.

Artifact and journal hashes use the existing runtime `canonicalJSON` definition: sorted object keys, preserved array order, UTF-8 JSON. The serializer rejects nonfinite, cyclic and non-JSON data. The existing serializer is exported rather than replaced by a separate hash implementation.

**Integrity verification is not a signature, proof of authorship, or calibration certification.** Anyone who can replace all artifacts and recompute their hashes can construct another internally consistent record. This report does not reload raw data or independently replay numerical analysis. Retain the manifest, journal, artifact envelopes, recorded application version and exact raw inputs.

## Claims and caveats

Only completed `analyze_surface` and `replay_recipe` results produce claims. Each claim records `step_id`, `artifact_id`, `source_sha256`, `channel`, `metric`, `value`, `unit`, and `definition`. The allowed metrics are Sa, Sq, mean, minimum, maximum, valid pixel count, excluded pixel count and selected area. Height-value units come from the verified statistics; counts use `pixels`, and area uses the recorded area unit. A null vertical unit stays null.

The report does not infer uncertainty, confidence intervals, independent sample counts, causal explanations, defect identities or instrument accuracy. Profiles, plateau measurements and quality diagnostics do not become additional numeric claims in this version. Recorded analysis, channel and quality warnings are deduplicated; importer support status explicitly remains a caveat rather than a certification.

Failed, canceled, pending, running and not-run statuses remain visible. Failed steps never produce claims. A completed prefix of a canceled plan can produce verified claims; unexecuted later steps cannot. Callback errors that occurred before a tool record was created remain explicitly described as failures without fabricated records or artifacts.

## Markdown and integration

Markdown includes plan/journal hashes, step statuses, source hashes, exact recorded operations and selection/ROI, a metric table and artifact references. Links use local `#artifact-<sha>` anchors; artifact headings provide those targets in renderers that generate standard heading anchors. Untrusted titles, rationale, source names, warnings and error strings are escaped; raw HTML is not emitted.

The returned report is detached from its inputs. It contains:

```js
const { schema_version, plan_sha256, journal_head_sha256, claims, warnings, markdown } =
  await createEvidenceReport({ manifest, journal });
```

Run `node --test tests/evidence-report.test.mjs`. Tests exercise real sessions, plans and analysis outputs, failed/canceled plans, unknown units, deterministic Markdown, artifact and journal tampering, source/unit/geometry inconsistencies even after hashes are recomputed, and replay step references.
