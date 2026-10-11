# Acquisition diagnostics

`web/quality.js` reports potential scan-line boundaries without changing the measurement. Import `qualityReport(channel, { selection, boundary_sigma: 6 }, reference)` to obtain row/column medians, adjacent differences, candidate boundaries, counts, units and optional comparison metrics. Selections use the engine's physical-coordinate ROI and exclusion polygons; imported masks and nonfinite pixels are excluded.

A candidate has a median difference whose distance from the median of all usable adjacent differences exceeds the larger of:

- `boundary_sigma × 1.4826 × MAD(differences)`;
- `64 × Number.EPSILON × max(abs(selected values))`.

The comparison is strict (`>`). A boundary index identifies the second row or column, starting at zero. Differences, center and threshold use the channel's stored vertical units. Missing medians/differences are `null`; absent usable adjacent pairs produce warnings and no candidates. Physical steps and sample structure can trigger candidates. Sparse lines, short images, alternating artifacts and pervasive defects may escape this heuristic. No automatic repair or defect classification occurs.

Counts `invalid` and `imported_mask` describe the entire input and may overlap. `selected` counts valid unmasked pixels inside the selection; `selection_excluded_valid` counts otherwise valid pixels removed by the ROI/polygons.

An explicit reference produces input-minus-reference metrics on common valid pixels. Geometry and units must match; no registration or trace/retrace alignment is inferred. `findTracePairs(channels)` suggests only unique exact case-insensitive title families ending in `Trace`/`Retrace`, preserving separators. Duplicates and different signal names remain unpaired.

```bash
node scripts/quality.mjs data/example.gwy --channel 0 --reference-channel 1 --out quality-report.json
node --test tests/quality.test.mjs
```

The CLI uses the default full-image selection and threshold, records input SHA-256, format/support classification, channel IDs and titles, import warnings, normalized parameters, the format-specific reader/engine identity and hashes of `quality.js` and `engine.js`. Source and reference calibration warnings remain visible; missing units receive an explicit warning without an assumed height unit. Output must be a new file; existing paths are never overwritten. Unit declarations and geometric agreement are not certification of acquisition accuracy.

## Browser workflow

Use **Check acquisition** below the viewer. It checks the original source channel using the current ROI/polygon selection, independently of processing and crop previews. Choose an optional same-file reference explicitly; a matching trace/retrace name is only a suggestion. The panel shows the first 20 candidates per axis and exports all candidates in **Export quality JSON**. Source/channel/selection and diagnostic-setting changes invalidate stale reports. This separate report does not add a processing operation or modify the analysis recipe.
