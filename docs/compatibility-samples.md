# Compatibility samples

Four public reference files were downloaded on 2026-10-11 (49,536,959 bytes, 47.24 MiB). They broaden the available test inputs; **they do not establish dashboard support for additional formats**. Native GWYP, the documented NanoScope binary raster subset, calibrated IBW v5 images, and the documented JPK TIFF image subset are supported.

## Local reference corpus

Files are in `data/external/reference-only/`, excluded by `data/external/.gitignore`. Do not commit these binaries or bundle them in a release: data-specific redistribution permission was not established. The tracked [manifest](../data/external/manifest.json) records exact source URLs, SHA-256 checksums, sizes, signatures, licensing evidence, and limitations. AFMReader URLs are pinned to commit `caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77`.

| Local filename | Format | Bytes | Coverage evidence |
| --- | --- | ---: | --- |
| `gwyddion-samples.gwy` | Gwyddion GWYP | 4,720,871 | Three surfaces: BIPM, Chip, ZnTe; no channel metadata or mask key markers found. |
| `afmreader-sample_0.spm` | Bruker Nanoscope | 33,635,392 | 1024 × 1024 multichannel file with height, error, modulus, adhesion and deformation header labels. |
| `afmreader-sample_0.ibw` | Igor Binary Wave v5 | 8,533,952 | MFP3D-footer, little-endian float32 stack; eight trace/retrace channels independently checked. ZSensor units remain unknown. |
| `afmreader-sample_0.jpk` | JPK TIFF | 2,646,744 | Big-endian TIFF signature; Ten signed32 channels; default-slot calibration and orientation independently checked. |

## Sources and licensing

[Gwyddion's official download page](https://gwyddion.net/download.php) explicitly offers native sample data. Its [GPL licensing description](https://gwyddion.net/documentation/user-guide-en/licensing.html) concerns software and does not explicitly license these measurements.

[AFMReader](https://github.com/AFM-SPM/AFMReader) publishes its fixtures under `tests/resources/`. Its [COPYING](https://github.com/AFM-SPM/AFMReader/blob/caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77/COPYING) contains GPLv3, but reviewed documentation does not separately establish measurement ownership or fixture permissions. These are local research references pending clarification.

An additional [Gwyddion book dataset collection](https://gwyddion.net/qspm/) explicitly uses **CC BY-NC-SA 4.0**. It was not downloaded or mixed into this corpus because the noncommercial restriction matters for unrestricted redistribution.

## Validation and gaps

Every download passed expected magic-byte checks and an HTML-error-page check; hashes describe the actual downloaded bytes. Header inspection is not numerical calibration validation. For imported formats, compare dimensions, channel names, physical extents, units, height statistics, and orientation against an independent reader before declaring compatibility. Unsupported formats should produce a clear error.

These four files do not cover masks, force curves, big-endian Igor, older GWYO, Park, malformed files, or every vendor/version. Missing native metadata was checked by byte markers, not a complete semantic parser. Do not treat this small corpus as broad compatibility certification.

## Implemented adapter evidence

The external GWYP file imports three calibrated surfaces. The NanoScope fixture imports eight channels; every pixel was compared against pinned pySPM output with explicit orientation and unit conversion. See [NanoScope scope](nanoscope-support.md) and [numerical results](nanoscope-validation.json). Browser import, profile extraction, and strict recipe replay also pass. These results validate this fixture and the tested synthetic cases, not every vendor variant.

The IBW fixture now imports eight channels with exact independent agreement across 2,097,152 values. ZSensor units remain unknown, explicitly warned. See [IBW support](ibw-support.md) and [configuration matrix](supported-inputs.md).

The JPK fixture imports ten channels; all 655,360 calibrated values match independent arrays exactly. Browser and automatic CLI replay pass. See [JPK support](jpk-support.md).
