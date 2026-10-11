# Spatial texture measurement contract (implementation in progress)

This contract defines the next M04 implementation; it does not advertise an already available tool. Existing image processing and recipe identities remain unchanged. Texture measurements will consume a captured recipe through strict replay and record their own code identity.

## Sampling and supported domain

Use a complete calibrated rectangular pixel region, extracted from the recipe selection with recorded pixel bounds and offsets. Reject internal mask/nonfinite/polygon holes rather than silently fill them. A later masked-estimator extension must define its spectral window and pair counts explicitly. Keep separate X/Y pitches; frequencies use cycles per stored lateral unit, never radians per unit by implication. Unknown units remain unknown.

## Explicit definitions

Let residual samples be `r[y,x]`, rectangular dimensions `H,W`, pitches `dy,dx`, and a separable window `w`. Detrending is explicit (`none`, `mean`, or `plane`) before windowing. Window choices are boxcar and periodic Hann, `0.5*(1-cos(2*pi*i/N))` on each axis. Let `S = sum(w²)` and `F` be the unnormalized 2D DFT of `w*r`, zero-padded to recorded power-of-two dimensions `Ky,Kx`.

The two-sided density is `P = dx*dy*|F|²/S`, with units `(Z unit)²*(XY unit)²`. Frequency bin area is `1/(Kx*dx*Ky*dy)`. Its discrete integral must equal `sum((w*r)²)/S`; for a boxcar this is the residual mean square. Zero padding refines displayed frequency sampling, not physical resolving power. Preserve both frequency signs and DC explicitly.

Linear autocorrelation uses the **unwindowed** residual and zero padding of at least `2H-1` by `2W-1`. At lag `(m,n)`, divide the overlapping product sum by `(W-|m|)*(H-|n|)`. Return this overlap-normalized estimate and its ratio to zero-lag mean square. A zero-energy surface has undefined normalized ACF, represented explicitly without nonfinite JSON. Off-zero estimates can exceed unity; do not clamp or describe them as independent-pair correlation coefficients. No fitted correlation length or ISO texture parameter is inferred in this milestone.

## Evidence and implementation boundaries

The [Gwyddion statistical-analysis guide](https://gwyddion.net/documentation/user-guide-en/statistical-analysis.html) motivates reporting preprocessing, directional sampling and masking assumptions. It also warns that leveling affects correlation estimates. Our formulas and validation are explicit; no Gwyddion numerical parity is claimed.

SciPy's [periodogram documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.periodogram.html) distinguishes density from squared-spectrum scaling and documents window-energy normalization for one-dimensional data. The two-dimensional scaling above is our specified extension, to be checked by Parseval's identity. SciPy's [correlate definition](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.correlate.html) supplies an independent direct-sum reference with zero values outside the data domain; overlap normalization is an additional explicit choice here.

Acceptance tests require direct-DFT/direct-correlation checks on small nonsquare arrays, constants and impulses, anisotropic sinusoidal peak coordinates, windowed Parseval integration, normalization at zero lag, zero-energy behavior, ROI geometry, invalid/masked-domain rejection and source nonmutation. Benchmark representative sizes before increasing browser limits or choosing Rust. Full-resolution numerical exports and labeled overview plots must distinguish any display reduction from the measured arrays.
