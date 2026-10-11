# NanoScope binary image support

The browser and Node CLI detect file contents, including numbered extensions such as `.001`. The native JavaScript adapter supports the documented subset below; this is not a claim of universal Bruker compatibility.

## Supported subset

- Binary `\\*File list` headers with a Ctrl-Z terminator and explicit payload bounds; `Ciao image list` AFM raster blocks.
- Tightly packed signed little-endian 16-bit or 32-bit integers; explicit per-image dimensions and two lateral extents with length units.
- Grouped Z-scale values with explicit supported units and unambiguous named sensitivities. Stored 32-bit samples with declared 16-bit resolution are accepted for NanoScope 9.x.
- Valid-data rectangles become exclusion masks. Unsupported calibration or image encodings skip that channel with a reason; corrupt payload boundaries or overlapping blocks reject the file.

ASCII, force curves, floating-point/compressed rasters, unknown units, and other acquisition layouts are unsupported. The external real fixture covers one square, full-frame 9.x acquisition; synthetic tests cover rectangular grids and invalid rectangles.

## Calibration and orientation

`output = signed_count × full_Z_scale / 2^(declared_bits) × sensitivity × unit_conversion`

Payload length determines storage width; declared resolution determines calibration. The parenthesized capture scale is retained as metadata, not substituted for the full hard value. Z offset and display magnification are not added. This follows the [NanoScope manual's height interpretation](https://nanoqam.ca/help/Multimode/Content/SoftwareGuide/FileFormats/HeightImageDataInterpertation.htm); [acquisition-dependent exceptions](https://sourceforge.net/p/gwyddion/mailman/gwyddion-users/thread/YyCVZDIMBXv7CgC5@physics.muni.cz/) prevent treating the formula as universal.

Rows are reversed once into top-down image coordinates; columns are unchanged. Pixel pitch is extent divided by pixel count. Stage offsets, scan direction, and rotation remain metadata; coordinates are image-local. Missing sensitivity units preserve declared electrical/arbitrary units with warnings. Arbitrary and log-domain channels are not converted into physical modulus, force, or energy.

## Validation

All **8,388,608 pixels across eight channels** agree with pinned pySPM output after vertical normalization and height nm-to-m conversion. Six channels match exactly; height-channel maximum differences are below `5.3e-23 m` (floating-point multiplication order). Unit labels are checked separately because the independent reader has documented fallback labels.

See [reference provenance](nanoscope-reference.md) and [full-array results](nanoscope-validation.json). Regenerate the independent arrays using the development-only Python script documented there, then run:

```sh
node scripts/validate-nanoscope.mjs /tmp/afm-nanoscope-reference
node scripts/check-compatibility.mjs
npm test
```

Missing independent arrays cause validation to fail, not silently pass. The app and CLI require no Python. Browser import/profile/replay and CLI fresh-process replay are additional integration checks. External measurement binaries remain local-only pending redistribution permission.
