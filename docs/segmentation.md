# Reviewed threshold segmentation

`segmentSurface(channel, options)` in `web/segmentation.js` identifies connected regions from an explicit threshold. It returns calibrated descriptive measurements and a `Uint32Array` label image without modifying source data or masks. Thresholds are not chosen automatically, and regions do not identify materials, defects, particles, or independent experimental samples.

## Options and selection

`threshold` is required and finite, in the channel's stored vertical unit. Other accepted options are `direction: 'above' | 'below'` (default `above`), `connectivity: 4 | 8` (default 4), `min_pixels` (positive integer, default 1), `boundary: 'include' | 'exclude'` (default `include`), and the existing engine `selection` object. Unknown fields and invalid options fail explicitly.

Threshold membership is inclusive: `value >= threshold` or `value <= threshold`. Imported masks, nonfinite pixels, ROI exclusions and exclusion polygons are removed before connectivity is evaluated. No valid pixels is an error; a valid selection with no foreground produces empty tables and zero labels.

Iterative flood filling visits candidates in row-major scan order. Candidate IDs start at one and remain unchanged after filtering, so accepted labels may have gaps. Label zero includes background, invalid/unselected pixels and rejected regions; it is not a separate validity class. Candidates smaller than `min_pixels` are retained in `excluded_regions` with reason `min_pixels`. With `boundary: 'exclude'`, contact with the image edge or selection boundary also excludes a candidate, recording `image_boundary` and/or `selection_boundary`.

An image boundary is the outermost row or column. A selection boundary is a **four-neighbor** contact with an in-image invalid pixel, including masked/nonfinite pixels and ROI/polygon exclusions. This definition remains four-neighbor even when region connectivity is eight-neighbor. An ordinary below-threshold valid neighbor is not a selection boundary.

## Measurements and labels

The result includes `schema_version: 1`, `algorithm: 'threshold_components_v1'`, normalized parameters, engine geometry, counts, accepted/excluded region tables, warnings and labels. Counts `valid` and `invalid` partition the entire input; invalid includes pixels outside the selection. `threshold_pixels` counts all candidate pixels before filtering; `accepted_pixels` counts labeled pixels after filtering.

Each region reports its original `id`, `pixel_count`, projected `area`, `area_unit`, bounds, centroid, `min`, `max`, `mean`, threshold excursion and boundary flags. `bbox_pixel` is `[x0, y0, x1_exclusive, y1_exclusive]`. Physical `bbox` uses pixel **edges**, offsets and separate X/Y pitches; `width` and `height` are physical bounding-box extents. The centroid averages physical pixel **centers**. Area is pixel count multiplied by both pitches; it is not a surface-area estimate. `excursion_height` is `max - threshold` above the threshold, or `threshold - min` below it. Despite its field name, it remains a value difference in the declared Z unit; electrical or arbitrary channels do not become topography.

Mean updates use compensated increments, with a finite weighted fallback for overflowing intermediate differences. Pixel-index centroid sums remain exactly representable at the image-size limit. Nonfinite derived metrics raise an explicit range error. Unit declarations must be strings or null; missing/nonmetre units generate warnings rather than an assumed conversion. No perimeter, equivalent radius or volume is estimated.

The [Gwyddion grain-analysis guide](https://gwyddion.net/documentation/user-guide-en/grain-analysis.html) provides background on threshold marking and projected-area concepts. This implementation uses the pixel methods specified above; no numerical or algorithmic parity with Gwyddion is claimed.

## Limits and measured JavaScript cost

The implementation rejects images above **4,194,304 pixels** and more than **65,536 candidate components**, including candidates later rejected by filters. Dense queue/label/eligibility arrays require approximately 10 additional bytes per pixel during processing, excluding input arrays, result objects and engine selection work. Returning only labels retains four bytes per pixel; garbage collection determines when scratch arrays are reclaimed. Many small regions or complex polygons add time and object memory beyond the dense-image measurements below.

Single cold executions measured on Linux x86-64, Node **v20.20.2**, an Intel Xeon **E5-2667 v3 @ 3.20 GHz**, in a 24-vCPU KVM environment. Each image ran in a fresh `node --expose-gc` process after `global.gc()`: a Float64 image filled with 2, threshold 1, default options, one component covering the full image. No browser rendering, import, export or region-table serialization was included.

| Image       |    Pixels |   Elapsed | RSS before → after | Peak process RSS | ArrayBuffers before → after |
| ----------- | --------: | --------: | -----------------: | ---------------: | --------------------------: |
| 1024 × 1024 | 1,048,576 |  306.8 ms |    48.9 → 66.7 MiB |         66.7 MiB |            8.01 → 18.01 MiB |
| 2048 × 2048 | 4,194,304 | 1275.3 ms |   72.9 → 121.0 MiB |        122.5 MiB |           32.01 → 72.01 MiB |

These are measured examples, not latency guarantees or a browser memory budget. Both run on the JavaScript implementation; the largest supported dense image still takes over a second in this environment.

```bash
node --test tests/segmentation.test.mjs
```

Tests cover calibrated rectangular regions, anisotropy, offsets, connectivity, inclusive thresholds, masked holes, ROI/polygon boundaries, filtering, deterministic IDs, limits, input immutability and extreme finite numeric inputs.
