# Explicit translation registration

`registerSurfaces(fixed, moving, options)` in `web/registration.js` returns a separate result; it never changes either input. The transform maps `fixed = moving + translation`. Output aligned and fixed-minus-aligned rasters use the fixed grid and contain NaN outside their common `valid` mask. Bounds are exclusive pixel indices `[x0,y0,x1,y1]`, area uses fixed pixel pitches, and area units are `(${xy_unit})²`.

## Manual sampling

Defaults are `{mode:'manual',tx:0,ty:0,interpolation:'bilinear'}`. Explicit `nearest` rounds half-index ties upward. Bilinear sampling requires every positive-weight contributor to be valid and inside the moving grid; zero-weight neighbors are ignored. Separate `fixed_selection` and `moving_selection` are normalized using the existing ROI/polygon rules, including imported masks and nonfinite pixels. Unequal dimensions, offsets and pitches are supported. No extrapolation or hole filling occurs.

Metrics include valid count, each input's valid count, fixed-grid overlap fraction, area, bounds, RMSE, MAE, mean difference and maximum absolute difference. Output overlap fraction is common-valid fixed pixels divided by valid fixed pixels, including when resampling produces more output samples than moving pixels. Baseline metrics use zero physical translation and the same interpolation, or explicitly report unavailable overlap.

## Automatic proposal

Use `{mode:'automatic',radius_x:4,radius_y:4,min_overlap_fraction:0.5}`. Only equal pitches (relative tolerance `1e-12`) are supported. Integer `(sx,sy)` means moving `(x-sx,y-sy)` maps to fixed `(x,y)`; offsets remain part of the physical transform. Every candidate records signed Pearson correlation, valid count and overlap fraction relative to the smaller valid input count. Scoring uses scaled centered moment accumulation, at least three pairs, and positive variance. Missing values are never zeros.

Scores within `1e-12` of the maximum tie; rank by squared displacement, then Y, then X. Record all ties and boundary warnings. Constant overlaps have null scores; no eligible score fails explicitly. Automatic baseline requires zero physical translation to coincide with integer pixel lattices within `1e-12` index units; otherwise it is unavailable, never nearest-rounded.

## Limits and interpretation

Each input is limited to 4,194,304 pixels. Radius bounds are 0–64, and fixed pixels times candidates cannot exceed 134,217,728. Options must be plain finite JSON. Declared XY and Z units must match and be nonempty. Numerical overflow, absent overlap and unsupported configurations fail visibly. Matching unit strings does not certify calibration. Interpolation may alter roughness; translation does not establish deformation, uncertainty or subpixel precision.

Run `node --test tests/registration.test.mjs`. A single cold synthetic 512×512 automatic self-registration with radii 4 (81 candidates) took 527 ms on Node v20.20.2/Linux, Intel Xeon E5-2667 v3 3.20 GHz. RSS was 50.1 MB before and 57.0 MB after; process peak RSS was 55.7 MiB. These measurements include runtime allocation and are not latency guarantees.
