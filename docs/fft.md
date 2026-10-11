# Two-dimensional FFT foundation

`web/fft.js` exports:

```js
fft2D(real, width, height, ({ imag = null, inverse = false } = {}));
// { real: Float64Array, imag: Float64Array, width, height }
```

Inputs are finite `Float64Array` samples in row-major order, with exactly `width × height` entries. An omitted imaginary array means zero imaginary input. Dimensions must be positive powers of two, including one, with at most **4,194,304 total samples**. Unknown options, accessor properties, nonboolean inverse settings, invalid arrays and unsupported dimensions fail explicitly. Source arrays are copied and never modified.

The forward transform is the **unnormalized** DFT:

`F[ky,kx] = Σy Σx (real[y,x] + i·imag[y,x]) exp(-2πi(kx·x/W + ky·y/H))`.

The inverse uses the positive exponent and divides both outputs by `W × H`. Output order is the natural DFT order, with DC at index zero; there is no frequency shift. Physical-frequency axes, window-energy normalization, detrending, padding and overlap normalization belong to the caller. No automatic padding or spectral normalization occurs. The numerical interface follows [the texture measurement contract](texture-design.md).

## Implementation and numerical limits

The implementation applies iterative radix-2 butterfly stages along rows, then columns. Row transforms operate on copied output arrays. Columns use reusable contiguous real/imaginary scratch arrays. Twiddle factors are calculated directly with `Math.cos` and `Math.sin`; each axis shares its factors across all rows or columns. Butterflies and bit reversal allocate no per-element objects. There are no external dependencies or runtime services.

The output arrays require 16 bytes per sample. Twiddle and column scratch storage grows with `W + H`, not image area. Callers retaining input, forward output and inverse output will retain substantially more memory than one transform alone. Nonfinite transform arithmetic raises `RangeError`; an inverse whose unnormalized intermediate transform overflows is rejected even when a differently scaled algorithm might represent its final mathematical answer. The implementation does not silently clamp or rescale extreme data.

## Independent tests

```bash
node --test tests/fft.test.mjs
```

Tests compare with independent nested-loop complex DFTs on `1×1`, `1×8`, `8×1`, `2×4` and `4×8` arrays for both transform signs. They check impulses, DC, real/complex sinusoidal peak bins and signs, complex round trips at scales `1e-100`, `1` and `1e100`, Parseval energy equality on small and deterministic `256×512` inputs, strict validation, overflow rejection and input immutability. Round-trip and direct-reference tolerances account for input scale and floating-point accumulation.

## Measured resource use

Measured in fresh Node **v20.20.2** processes on Linux x86-64 with an Intel Xeon **E5-2667 v3 @ 3.20 GHz**, in a 24-vCPU KVM environment. Each process created deterministic real input in `[-0.5,0.5)` using a 32-bit linear congruential generator seeded with 123456. `global.gc()` ran before the forward transform and before the inverse; timing excludes input generation and those explicit collections. Forward results remained live during inverse measurement. These are single execution measurements, not guarantees or browser latency estimates.

| Shape |   Forward |   Inverse | RSS before / after forward / after inverse | Peak process RSS | ArrayBuffers before / after forward / after inverse |
| ----- | --------: | --------: | -----------------------------------------: | ---------------: | --------------------------------------------------: |
| 512²  |   51.6 ms |   58.5 ms |                     47.8 / 53.2 / 58.5 MiB |         59.9 MiB |                             2.01 / 6.03 / 10.03 MiB |
| 1024² |  292.1 ms |  310.3 ms |                     53.3 / 70.4 / 87.7 MiB |         87.7 MiB |                            8.01 / 24.04 / 40.04 MiB |
| 2048² | 1262.8 ms | 1305.3 ms |                   77.8 / 143.2 / 208.4 MiB |        209.1 MiB |                          32.01 / 96.07 / 160.03 MiB |

Maximum absolute real round-trip errors were `5.55e-16`, `5.55e-16` and `7.22e-16`, respectively. Maximum imaginary residuals were `5.31e-16`, `5.80e-16` and `6.81e-16`. Import, padding, PSD/ACF arithmetic, plotting and export incur additional time and memory. A 2048² transform alone took over a second in this environment, which informs the caller's workload budget without prescribing a different runtime.
