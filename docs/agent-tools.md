# Typed local analysis tools

The worker exposes eight versioned tools through `POST /api/tool` with `{name, arguments}`. `GET /api/tools` returns their input schemas and operation parameters. Inputs are plain finite JSON, limited to 256 KiB and 32 processing operations; unknown tools, fields, invalid ranges and prototype/accessor objects are rejected. The original engine and reader identities remain unchanged.

- `list_sources`: loaded files, hashes, channels and import support.
- `inspect_source`: calibrated channel metadata and reader identity for a loaded file.
- `analyze_surface`: explicit operations, selection, optional profile/plateaus/reference.
- `check_quality`: original-channel diagnostics with optional same-file reference.
- `replay_recipe`: strict replay of a recipe from an earlier artifact.
- `get_artifact`: retrieve an immutable result by identifier.
- `segment_surface`: threshold regions from a strictly replayed analysis artifact.
- `measure_texture`: calibrated PSD/ACF from a strictly replayed analysis artifact.

Numerical tools require the source filename, channel where applicable, and SHA-256 returned by inspection. Reference analyses bind both input hashes. Tools cannot import arbitrary URLs, execute scripts, rewrite raw files, or infer missing calibration. Import files through the existing viewer first. Compatibility warnings remain in results.

A tool response contains a `record` (`succeeded` or `failed`) and an `artifact` or `null`. Scientific failures are recorded outcomes, even when HTTP succeeds. Artifacts hold compact channel metadata, recipe, statistics, history, diagnostics and warnings; raster matrices are not retained. Recipes preserve key order for compatibility with the existing strict replay implementation.

Artifact identifiers are `artifact:<SHA-256>` over canonical sorted-key JSON of `{tool_version,call,result}`. Each journal record includes the preceding record hash and its own hash; timestamps are recorded separately from artifact identity. These hashes detect changes but are not digital signatures or proof of external authorship. `GET /api/tool-journal` returns the chain; `GET /api/tool-artifact?id=...` returns a stored artifact without creating another execution record.

The session serializes calls, permits at most 256 requests and retains at most 32 MiB of unique canonical artifact content. Invalid calls receive a generic failure without storing their raw arguments. Credential fields are excluded from retained results. Session state is memory-only: download the plan/results/journal before reloading. This is a local execution interface, not a model connection.

## Segmentation extension

`segment_surface` accepts a source filename/hash, `recipe_artifact` referring to a prior analysis artifact, and explicit threshold parameters. It strictly replays the captured recipe before measuring connected regions, retaining its ROI/mask and calibration. Plan references use `"$step:analyze"` in `recipe_artifact`, just as replay does. Compact tool artifacts retain region tables, excluded candidates, code identity, label hash and report hash; raster labels are available through the Features/CLI report. The generic evidence report still emits its documented eight surface-statistic claims; segmentation tables are separate attributed outputs, not inferred particle identities.

## Spatial texture extension

`measure_texture` takes `{file, source_sha256, recipe_artifact, parameters}`. Parameters are `detrend: none|mean|plane` and `window: boxcar|hann`, defaulting to mean and boxcar when omitted from the required parameters object. A plan can reference a prior analysis using `recipe_artifact: "$step:analyze"`. The captured recipe fixes channel, preprocessing and selection; the tool cannot override them.

Reports retain code/source/recipe identities, estimator definitions, calibrated sampling, bin-mean display overviews, directional cuts and hashes for full numerical rasters. Complete float64 arrays are exported through Texture or the CLI. Texture summaries remain attributed artifacts; the generic evidence report does not manufacture claims beyond its documented surface statistics. See [texture workflow and resource limits](texture-workflows.md).
