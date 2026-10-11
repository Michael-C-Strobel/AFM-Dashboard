# Independent Nanoscope reference evidence

## Scope and reproducibility

Executed unmodified **pySPM 0.6.3**, commit `20a05dbae154bc1e8c87f64f8c094f251d0da830`, on `data/external/reference-only/afmreader-sample_0.spm`. The fixture SHA-256 is `71a535e577285b6d43c1cbad134b69ab9f472806661a231f981a2c96b2d3972d`. This is reader agreement evidence, not manufacturer-certified calibration.

[nanoscope-reference.json](nanoscope-reference.json) records each of eight image blocks: dimensions, offsets/lengths, declared/storage widths, scale and sensitivity strings, direct observed value/count ratio, min/max/mean, four corners, centre and ten deterministic positions. All raw counts were cross-checked against NumPy little-endian int32 decoding. Entire decoded arrays matched the reference formula exactly.

[validate-nanoscope-reference.py](../scripts/validate-nanoscope-reference.py) is development-only Python tooling; it is not an application dependency. It checks fixture and reader-source hashes, calls the external reader, and writes evidence. Run with the pinned pySPM checkout and its dependencies on `PYTHONPATH`:

```sh
MPLCONFIGDIR=/tmp/afm-nanoscope-reference/mpl \
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=/tmp/afm-nanoscope-reference/deps:/tmp/afm-nanoscope-reference/pySPM-20a05dbae154bc1e8c87f64f8c094f251d0da830 \
python scripts/validate-nanoscope-reference.py \
  data/external/reference-only/afmreader-sample_0.spm \
  --output docs/nanoscope-reference.json
```

External source remains in `/tmp`; no upstream reader code was copied into the application. Temporary additional packages were scikit-image 0.25.2, lazy-loader 0.4, networkx 3.4.2, imageio 2.37.0 and tifffile 2025.5.10; NumPy/Python versions are in JSON.

## Storage and calibration

Every image is 1024 × 1024 with 4,194,304 data bytes: actual storage is **signed little-endian int32**. Peak Force Error **and Height** declare `Bytes/pixel: 2`; the other six declare 4. The reference independently derives storage width from data length divided by pixel count, but uses the declared width for calibration:

`value = raw_count × (Z-scale full hard value / 256^declared_bytes_per_pixel) × referenced sensitivity`

The reference parses Z offset but does not add it. No levelling or display magnification is applied. The following factors are verified by nonzero raw/value ratios, not merely inferred from parameter names.

| Channel | Declared/storage bytes | Factor per raw count | pySPM output label | Min / max / mean |
| --- | --- | ---: | --- | --- |
| 0 Height Sensor | 4/4 | 3.28388500214e-07 | nm | 132.125594921 / 152.096621031 / 142.844142715 |
| 1 Peak Force Error | 2/4 | 6.25e-05 | V | -0.02325 / 0.05375 / -3.51675152779e-05 |
| 2 DMTModulus | 4/4 | 9.53674316406e-07 | V | 0 / 2047.99999905 / 3.40423652485 |
| 3 LogDMTModulus | 4/4 | 7.45058059692e-09 | V | -12.3861522675 / -0.0908635556698 / -1.47797520053 |
| 4 Adhesion | 4/4 | 5.72204589844e-09 | V/Arb | -0.0101838226318 / 0.0529411754608 / 0.00168573564331 |
| 5 Deformation | 4/4 | 9.31322574615e-10 | V | 0 / 0.0225128997117 / 0.00304392727932 |
| 6 Dissipation | 4/4 | 9.53674316406e-07 | V | -0.0356273651123 / 0.055136680603 / -0.00423172467163 |
| 7 Height | 2/4 | 0.00834260178721 | nm | 21.2152363449 / 37.1245779531 / 29.2733852275 |

For example, Peak Force Error raw `4` becomes `0.00025 V`; Height raw `2630` becomes `21.941042700354494 nm`. Both use denominator 65536, not 2^32. Header parenthesized hardscale and fullscale/denominator agree within rounding for this fixture. No 65536-fold discrepancy exists here.

## Orientation and extents

pySPM retains raw stored rows/columns, with no flip, transpose, retrace reversal or scan rotation. All blocks say `Frame direction: Up`; Height says `Trace`, the other seven say `Retrace`. `get_channel` uses direction to select a block, not to reverse pixels. Arrays `/tmp/afm-nanoscope-reference/channel-N.f64` contain little-endian float64, C row-major, in this raw order. Each is 8,388,608 bytes.

The inspected AFMReader wrapper applies `np.flipud` once after pySPM. This wrapper was source-inspected, not executed. Thus AFMReader `[r,c]` corresponds to this report's `[1023-r,c]`. A Gwyddion maintainer describes Nanoscope stored rows as bottom-to-top; this supports that vertical normalization, but should not be generalized to all acquisition layouts without more fixtures.

pySPM returns extents 505.859 × 505.859 nm, with pitch `505.859/1024 = 0.4940029296875 nm`. These are field extents divided by pixel count, not endpoint separation divided by 1023. It does not apply instrument X/Y offset or rotation. Its nonsquare size/resolution behavior is unverified by this square fixture.

## Interpretation limits

All eight channels were numerically decoded. Physical unit interpretation is narrower: Height Sensor and Height have explicit nm/V sensitivities; Peak Force Error has a unitless sensitivity with hard units V. DMTModulus, LogDMTModulus and Dissipation are labelled V by pySPM because the sensitivity has no unit and its fallback uses the header type token. Their hard units are Arb, log(Arb), and Arb. Adhesion's reader label is V/Arb. These labels must not be presented as verified physical modulus, force or energy units.

LogDMTModulus is only linearly scaled **log-domain** counts in this reference. Logarithm base, physical modulus conversion, and any exponentiation remain unresolved. No exponentiation was performed. The reference formula is not universal: a Gwyddion maintainer describes competing calibration formulas and acquisition-dependent exceptions.

## Primary sources

- [Pinned pySPM Bruker reader](https://github.com/scholi/pySPM/blob/20a05dbae154bc1e8c87f64f8c094f251d0da830/pySPM/Bruker.py): storage, scale and channel selection.
- [Pinned pySPM image class](https://github.com/scholi/pySPM/blob/20a05dbae154bc1e8c87f64f8c094f251d0da830/pySPM/SPM.py): array retention, extents and pixel pitch.
- [Pinned AFMReader wrapper](https://github.com/AFM-SPM/AFMReader/blob/caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77/AFMReader/spm.py): vertical flip.
- [Gwyddion maintainer on calibration](https://sourceforge.net/p/gwyddion/mailman/gwyddion-users/thread/YyCVZDIMBXv7CgC5@physics.muni.cz/): hardvalue/hardscale distinctions and limits.
- [Gwyddion maintainer on stored row order](https://sourceforge.net/p/gwyddion/mailman/gwyddion-users/thread/20130914150104.GA26473%40edge/): bottom-to-top rows.
