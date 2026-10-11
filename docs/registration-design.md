# Explicit translation registration contract

C01 adds a separate, reviewed registration result between two captured processed analyses. Existing image recipes, their engine identities, unaligned reference comparison and acquisition diagnostics remain unchanged. Each input recipe is strictly replayed against its exact source (and any recorded reference) before registration. The result records both original recipes, both calibrated grids, registration code identity, transform, interpolation, overlap, metrics and raster hashes.

## Transform and sampling

Initial support is translation, not rotation, scaling or deformation. A transform `(tx, ty)` maps moving physical coordinates into fixed physical coordinates: `p_fixed = p_moving + t`. The output grid is the fixed grid. At each fixed pixel center, sample the moving image at `p_fixed - t`. Preserve offsets and separate X/Y pitches. Require finite positive calibration and identical nonempty declared XY and Z unit strings; unknown units reject registration. Matching declared units does not certify instrument calibration.

Manual translation accepts finite physical shifts and explicit nearest-neighbor or bilinear interpolation. Nearest uses `floor(index + 0.5)` with half ties toward the higher index. Bilinear requires every strictly positive-weight contributor to be inside the moving array, finite and valid under the moving recipe selection/mask; zero-weight neighbors do not invalidate an exact grid sample. Never extrapolate, fill holes or wrap edges. Only valid fixed pixels and valid resampled moving pixels enter the common overlap. Invalid output pixels remain missing; output dimensions and calibration are fixed, not silently cropped.

Return aligned moving and fixed-minus-aligned difference rasters, a common-valid mask, valid count/fraction/physical area, common pixel bounding box and descriptive RMSE/MAE/mean difference/maximum absolute difference. Record unaligned metrics using the same interpolation at physical translation zero, including an explicit unavailable result when no common overlap exists. These metrics describe the sampled overlap, not experimental uncertainty.

## Bounded automatic proposal

An explicit automatic request searches integer shifts around coincident raster origins. Equal X/Y pitches are required within relative tolerance `1e-12`; unequal pitches remain supported only by manual resampling. Candidate `(sx, sy)` maps moving pixel `(x-sx, y-sy)` to fixed `(x,y)`, giving physical translation `fixed_offset - moving_offset + (sx*dx, sy*dy)`. Record this origin convention and every tested candidate score/count.

Search radii are integers from 0 through 64 per axis, default 4. Preflight `fixed_pixel_count * candidate_count <= 134217728` and each input at most 4,194,304 pixels. Reject excess work with a clear crop/reduce-search instruction. This budget bounds direct computation; it is not a promise of interactive latency.

Score candidates using overlap-specific Pearson normalized cross-correlation, calculated from paired valid samples with stable centered moment accumulation. Require at least three pairs and a user-recorded minimum overlap fraction (default 0.5, range `(0,1]`) relative to the smaller input's valid-pixel count. Constant/zero-variance overlap has no score. Never treat excluded or missing samples as zero. Maximize signed correlation, not absolute correlation. Rank scores within `1e-12` of the best as ties, then choose smallest squared pixel displacement, then ascending Y and X for deterministic presentation. Record ties and a warning rather than infer unique alignment. A best candidate on a search boundary warns that a broader search may be needed. No valid candidate is an explicit failure.

The automatic result is a proposal for review; it does not change either captured recipe or the main viewer. It records integer sampling without implying subpixel precision. Manual bilinear transforms provide explicit fractional translation without fitted precision claims.

## Reproducibility and acceptance

Known integer shifts, physical offset sign, anisotropic pitches, unequal-grid manual sampling, fractional bilinear interpolation, mask boundaries, missing pixels, constant images, periodic ambiguities, work-limit refusal and input nonmutation need independent tests. Reports and little-endian raster exports must preserve exact transform/interpolation and both input identities. Browser and CLI must use the same service and expose retained warnings; unsupported transforms/configurations must fail visibly.

The [Gwyddion multidata guide](https://gwyddion.net/documentation/user-guide-en/multidata.html) distinguishes correlation-based matching, mutual cropping and local displacement estimation. This milestone specifies a global translation estimator; it does not claim Gwyddion parity or estimate deformation. Any later rotational, affine or local model needs its own explicit support gate and independent validation.
