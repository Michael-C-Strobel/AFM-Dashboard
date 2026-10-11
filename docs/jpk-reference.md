# Independent JPK image reference

## Executed reader and reproducibility

Executed the unmodified AFMReader JPK loader from commit **caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77**, using **tifffile 2025.5.10**, on `data/external/reference-only/afmreader-sample_0.jpk` (SHA-256 `02d0e0a57a66dd3353957e9658f4a8360ba299000de20ce135b3f14907ba8712`). Exact source hashes, environment, every TIFF tag, and per-channel evidence are recorded in [jpk-reference.json](jpk-reference.json).

The executed `jpk.py` hash is `4ee8212d76f1cb0b1f5f9ae97fac4a8e84136a92645aa17ba73a10a2e7200fdf`; `tifffile.py` hash is `42cfd527fb4bd18ef95095f04cf2245b8dcdf7d8cb2e5cd740417acf4f3cdbb5`.

For reproduction, obtain `__init__.py`, `jpk.py`, `io.py`, `logging.py`, and `default_config.yaml` from the pinned AFMReader commit into `/tmp/afm-jpk-reference/AFMReader/`. Install temporary dependencies (`numpy`, `h5py`, `tifffile==2025.5.10`, `loguru==0.7.3`, `ruamel.yaml==0.18.10`) and AFMReader package metadata. The run used AFMReader 0.0.1 installed under a lower-priority `/tmp` path **only for its distribution metadata**; executed source came from the pinned commit ahead of that path, which the validator verifies by hash. No upstream source was modified or copied into the application.

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=/tmp/afm-jpk-reference:/tmp/afm-jpk-reference/deps:/tmp/afm-nanoscope-reference/deps \
python scripts/validate-jpk-reference.py \
  data/external/reference-only/afmreader-sample_0.jpk \
  --output docs/jpk-reference.json
```

The optional [validator](../scripts/validate-jpk-reference.py) also checks every raw raster against direct NumPy decoding of the file's strips. All 655,360 measurement integers plus 4,096 preview indices match. Every calibrated pixel matches AFMReader output after its documented nm conversion.

## TIFF structure and calibration

This is classic **big-endian TIFF**, with eleven IFDs. IFD 0 is a 64 × 64 uint8 palette thumbnail. IFDs 1–10 are 256 × 256 signed int32, SampleFormat 2, one sample per pixel, PhotometricInterpretation 1, Compression 1 (none). Each measurement uses 32 strips of eight rows and 8,192 bytes; all strip offsets/counts and tag types are in JSON. TIFF Orientation is absent. The preview is not a calibrated measurement despite carrying shared amplitude calibration metadata.

Each channel has a default slot and named parent relationships. The executed reader applies **the default slot's multiplier and offset directly to raw integers**. Gwyddion's image importer independently follows that same rule. Parent relationships are descriptive here: composing the stored coefficients repeatedly would double-apply calibration. For example, height's path is `raw → volts → nominal → calibrated`, but the selected calibrated coefficients are already `-1.1577216212539286e-15 × raw + 2.486188249421139e-6` metres.

All measurement defaults use LinearScaling. The raw slot uses NullScaling. Phase's unused `user` slot and error's unused `distanceamplitude` slot are **UnknownCalibration**, with no conversion parameters; they were not selected or guessed. JSON records every slot's name, type, parent, encoder, unit, multiplier and offset.

| Array index / IFD | Channel | Default slot | Native unit | Minimum / maximum / mean |
| --- | --- | --- | --- | --- |
| 0 / 1 | height_retrace | calibrated | m | 3.30311395843e-06 / 3.35975971559e-06 / 3.34538176368e-06 |
| 1 / 2 | measuredHeight_retrace | nominal | m | 3.78336827548e-06 / 3.83318534004e-06 / 3.82006004846e-06 |
| 2 / 3 | amplitude_retrace | distanceamplitude | m | 2.53765854165e-08 / 2.60216795894e-08 / 2.58060283535e-08 |
| 3 / 4 | phase_retrace | degrees | deg | -9.65309685575 / -8.19620672689 / -9.00391508703 |
| 4 / 5 | error_retrace | voltsamplitude | V | -0.0103024287744 / 0.008429020499 / -0.000305974240175 |
| 5 / 6 | height_trace | calibrated | m | 3.30259182019e-06 / 3.36095004212e-06 / 3.34537052651e-06 |
| 6 / 7 | measuredHeight_trace | nominal | m | 3.7823466723e-06 / 3.83423452741e-06 / 3.81989256478e-06 |
| 7 / 8 | amplitude_trace | distanceamplitude | m | 2.53936102062e-08 / 2.60370078237e-08 / 2.57972766806e-08 |
| 8 / 9 | phase_trace | degrees | deg | -9.64865947394 / -8.23064358019 / -9.01410346465 |
| 9 / 10 | error_trace | voltsamplitude | V | -0.0113327259936 / 0.0145142323906 / 0.000321753091271 |

## Orientation, extents and identifiers

Common grid values are `uLength=vLength=3.2691651420070083e-7 m`, `iLength=jLength=256`, `x0=2.5844649317557376e-6 m`, `y0=1.6229086882629253e-6 m`, `theta=π/2`, `reflect=0`, and motion `bottomUp`. Pixel pitch is **1.2770176335964876 nm** in each direction, from length divided by 256.

AFMReader vertically flips every measurement raster; it does not transpose, reverse retrace columns, or rotate by theta. The inspected Gwyddion image importer reverses rows when reflect is false (default false where missing), stores origin offsets and extents, and likewise does not rotate the raster. Grid_Reflect exists in IFD 0; measurement IFDs omit it. AFMReader's behavior for other reflect values was not validated. Preserve the rotation as metadata if comparing these array coordinates with instrument/world coordinates.

IFDs 1–5 are retrace; IFDs 6–10 are trace. Name is `Glass in liquid`; acquisition dates span 2017-01-16 16:00:32.334–16:01:36.264 GMT. Tags 0x8000 and 0x8001 contain `6.0.41` and `2.0`; the inspected JPK-authored header names them FileFormatVersion and ProgramVersion respectively. Account is `andor`, unique ID `1484582432334`, approach ID `2017.01.03-13.01.51-00511`. Tag 0x8016 contains `c008886`; its meaning was not established and it is not asserted to be an instrument model/serial.

Feedback mode is `ac-ultra-speed-direct-drive`. Configuration text identifies the active internal tip XY scanner (30 × 30 µm) and active internal Z scanner (6.5 µm range), plus available external fast Z scanners. Full configuration and feedback strings are preserved in JSON; no instrument model is inferred.

## Array artifacts and limits

`/tmp/afm-jpk-reference/channel-N.f64` uses **native default-slot units** (m, deg, V), little-endian float64, C row-major, vertically flipped display orientation. Index N equals IFD minus one. Each contains 65,536 values (524,288 bytes). `channel-N-afmreader.f64` contains exact returned AFMReader values, which use nm for height/measuredHeight/amplitude. `channel-N-raw.i32` contains raw signed integers, converted to little-endian storage, in unflipped TIFF row order. All hashes, corners, centre and ten deterministic positions are in JSON.

No unit scaling is guessed: selected default slots explicitly provide units. These results establish agreement for this one uncompressed, signed-32-bit, reflected-false image file, not every JPK acquisition, TIFF encoding, reflect/rotation setting or unknown calibration type. Gwyddion was source-inspected, not executed.

## Primary sources

- [Pinned AFMReader JPK loader](https://github.com/AFM-SPM/AFMReader/blob/caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77/AFMReader/jpk.py) and [tag configuration](https://github.com/AFM-SPM/AFMReader/blob/caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77/AFMReader/default_config.yaml).
- [Gwyddion JPK image importer, SVN 30602](https://svn.code.sf.net/p/gwyddion/code/!svn/bc/30602/trunk/gwyddion/modules/file/jpkscan.c), SHA-256 `276707662b8d0e97bbfc0d921895478a09d87a405a8532f70a62f52c1737558b`.
- [JPK-authored tag definitions](https://svn.code.sf.net/p/gwyddion/code/!svn/bc/30602/trunk/gwyddion/modules/file/jpk.h).
- [Official tifffile source](https://github.com/cgohlke/tifffile); executed package version and source hash are pinned above.
