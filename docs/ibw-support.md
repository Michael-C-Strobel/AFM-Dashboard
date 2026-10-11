# Igor Binary Wave image support

## Supported boundary

`web/ibw.js` reads IBW **version 5** calibrated 2D rasters and 3D image-channel stacks. It validates the 384-byte additive header checksum, every declared payload/auxiliary boundary, dimension products, sample type, and decoded-memory limits before allocation. Both byte orders and float32/float64 or signed/unsigned 8/16/32-bit samples have synthetic coverage.

The independently checked instrument subset is **Asylum Research MFP-3D, little-endian float32 v5 image stacks**, identified by the `MFP3D` footer. Other readable instrument/configuration combinations receive an **Unverified configuration** warning. This is reader validation, not certification of instrument accuracy.

Older versions, text/complex waves, 1D/4D data, nonpositive spatial steps, missing/unsupported lateral units, string-index sections and extended options are rejected. Force spectroscopy and volumes are not supported. Dependency formulas are recorded but never executed; appended thumbnails are reported and skipped.

## Values, labels and calibration

Dimension 0 is X, dimension 1 is Y, and dimension 2 is the channel. The adapter reverses Y once for display without reversing retrace columns. Coordinates are image-local; original `sfA`, `sfB`, units and acquisition notes remain metadata.

Header `sfA` determines pixel spacing. Field extent is pixel count × spacing. The reference file therefore spans **801.5655577299414 nm** in pixel-cell bounds, while its first-to-last sample span and nominal note scan size are **800 nm**. A visible warning explains this distinction; note width divided by pixel count is not substituted silently.

Labels are 32-byte NUL-terminated strings. Bytes after NUL are ignored: the sample's first channel is `HeightTrace`, despite an independent reader returning `HeightTracee` from trailing garbage.

Stored values are preserved, with explicit length units normalized to metres. For MFP-3D, a unique channel-specific note unit takes precedence when global units are absent. Height uses the documented reader convention of metres, with its provenance and a warning. Missing or conflicting units remain unknown. In this sample, ZSensor is **unknown**, UserIn0/1 are **V**. Display scales, offsets, plane fits and generic height multipliers are never applied.

## Evidence and replay

All **2,097,152 values in eight channels match exactly** against igor2 0.5.12 after the documented axis transformation. This numerical agreement does not resolve missing physical calibration. See [independent evidence](ibw-reference.md), [results](ibw-validation.json), and [support policy](supported-inputs.md).

```sh
# Generate reference arrays as documented in ibw-reference.md, then:
node scripts/validate-ibw.mjs /tmp/afm-ibw-reference
node scripts/afm.mjs analyze data/external/reference-only/afmreader-sample_0.ibw \
  --preset automatic --out artifacts/ibw-automatic
node scripts/afm.mjs replay artifacts/ibw-automatic/recipe.json \
  --data-dir data/external/reference-only --out artifacts/ibw-replay
```

Synthetic tests need no external files or Python. The independent validator is optional development tooling; application and CLI remain JavaScript-only. External binary redistribution remains unresolved.
