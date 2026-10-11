# Spatial texture core

`textureSurface(channel, options)` measures a two-sided power spectral density (PSD) and linear autocorrelation (ACF) on a complete calibrated rectangle. This is a pure JavaScript numerical module; UI and recipe integration are separate work. It does not infer correlation lengths, ISO Sal, material identities or independent observations.

## Domain and preprocessing

Options are exactly `detrend` (`none`, `mean`, `plane`; default `mean`), `window` (`boxcar`, `hann`; default `boxcar`) and `selection` (engine ROI/exclusion polygons). The selected valid pixels define a bounding rectangle, recorded as `source_bounds: [x0,y0,x1exclusive,y1exclusive]`. Internal masks, nonfinite pixels or polygon holes are rejected; invalid edge strips may reduce the rectangle. At least 2 × 2 pixels must remain. Offsets, separate X/Y pitches and cropped physical extent are retained.

Detrending uses the existing engine on that rectangle; its history is returned. It changes low-frequency content and correlation estimates. Source data, masks and supplied options are not mutated. The maximum original image size and maximum padded FFT size are each 4,194,304 cells. Padding uses the next powers of two at least `2W-1` and `2H-1`, preflighted before spectral allocation.

## Definitions

For residual `r`, pixel pitches `dx,dy`, and separable window `w`, the PSD is

```text
P = dx * dy * |FFT(w*r)|² / sum(w²)
```

Hann means **periodic** Hann: each axis is `0.5*(1-cos(2*pi*i/N))`. Frequencies are cycles per stored lateral unit, ordered negative through zero to positive, and data are a flat row-major fftshifted array. Both signs and DC remain. The discrete PSD integral with bin area `dfx*dfy` equals `sum((w*r)²)/sum(w²)`, also returned for checking. Zero padding refines frequency sampling; it does not improve physical resolving power.

ACF uses the **unwindowed** residual. Zero-padded inverse squared FFT gives linear product sums, divided at integer lag `(m,n)` by `(W-|m|)*(H-|n|)`. All signed lags are returned in physical coordinates, in flat row-major order. `normalized` divides by zero-lag residual mean square; it is `null` for exactly zero energy. Off-zero estimates may exceed unity and are not clamped or interpreted as bounded correlation coefficients.

Known units are retained: PSD `(Z)²*(XY)²`, ACF `(Z)²`; frequency units are cycles/XY. Unknown units remain `null`. Nonfinite results and unusable pitch/scaling underflow or overflow raise errors. These estimators and their validation follow the repository's [texture design contract](texture-design.md); no external-package numerical parity is claimed.

## Verification

```sh
node --test tests/texture.test.mjs
```

Tests compare small nonsquare arrays to independent direct DFT and direct overlapping-product sums, and cover anisotropic sinusoidal bins, periodic-Hann/boxcar Parseval identities, constants, plane detrending, impulses, ROI geometry, holes, unknown units, immutability and allocation limits.

A local Node 20 synthetic benchmark measured approximately 95 ms for 128² input (256² padded FFT) and 1.08 s for 512² input (1024² padded FFT), including preprocessing and both outputs. These are single-machine observations, not browser performance guarantees.
