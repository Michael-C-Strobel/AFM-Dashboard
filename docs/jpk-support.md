# JPK TIFF image support

## Supported subset and configuration gate

The native JavaScript reader accepts classic TIFF with JPK image metadata, a common thumbnail directory, positive calibrated scan extents, and measurement directories. Ordinary TIFF, BigTIFF, force spectroscopy, compressed/tiled rasters, predictors, color data, unsupported orientations and reflected/non-bottom-up grids are rejected or individually omitted with visible reasons. Corrupt bounds, duplicate tags, cyclic directory links and overlapping strips reject the entire input.

Uncompressed signed/unsigned 16/32-bit rasters have synthetic coverage in both byte orders. The independently validated configuration is the supplied **big-endian signed32 JPK image version 6.0.41**, tag 0x8001 value 2.0, `ac-ultra-speed-direct-drive`, active internal tip XY scanner and internal Z scanner. Other readable configurations receive a persistent **Unverified configuration** warning. No instrument model is inferred from serial-like strings.

## Calibration and coordinates

Each image selects its named default calibration slot. The conversion is:

`value = raw_integer × default_slot_multiplier + default_slot_offset`

Coefficients already describe the full raw-to-selected-slot conversion. Parent slots are checked and retained as provenance; their coefficients are **not applied again**. Missing, ambiguous, cyclic or unknown selected calibration is rejected. Unused unknown slots remain metadata. Explicit units are preserved; recognized length prefixes become metres. Missing units remain unknown and unfamiliar unit strings carry warnings.

The preview is never used as a measurement. Extent comes from common JPK grid tags; pitch is extent divided by measurement pixel count. Rows are reversed once for this bottom-up, non-reflected subset. Retrace columns are unchanged. Coordinates are image-local; original grid origin and rotation remain metadata. This fixture records π/2 rotation, which is not silently applied to the array.

## Evidence

The fixture contains ten 256 × 256 channels: height, measured height, amplitude, phase and error, each in trace/retrace. Selected units are explicitly **m**, **deg**, and **V**. All **655,360 calibrated values match exactly** against independently generated arrays from pinned AFMReader/tifffile; every raw integer was independently cross-checked against the TIFF strips.

See [reference provenance](jpk-reference.md), [numerical validation](jpk-validation.json), [browser checks](browser-validation.md), and [support matrix](supported-inputs.md). One file does not establish compatibility with every JPK instrument or acquisition mode.

```sh
# Generate independent arrays as documented in jpk-reference.md, then:
node scripts/validate-jpk.mjs /tmp/afm-jpk-reference
node scripts/afm.mjs analyze data/external/reference-only/afmreader-sample_0.jpk \
  --preset automatic --out artifacts/jpk-automatic
node scripts/afm.mjs replay artifacts/jpk-automatic/recipe.json \
  --data-dir data/external/reference-only --out artifacts/jpk-replay
```

Python is optional development validation tooling only. Runtime parsing and analysis remain JavaScript. External fixture binaries are local-only pending redistribution permission.
