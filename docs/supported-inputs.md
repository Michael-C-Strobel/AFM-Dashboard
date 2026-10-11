# Supported inputs and configuration warnings

Import detection uses bytes rather than extensions. Successful decoding is separate from validation of an instrument/configuration. The viewer keeps a support panel visible through analysis and recipe replay; channel unit warnings also remain visible. CLI analysis and exported records include warnings and support metadata.

| File type / configuration | Status and behavior |
| --- | --- |
| Native Gwyddion GWYP image objects | Supported calibrated container, independent of instrument. Uses stored units, dimensions and masks; does not certify the acquisition instrument. |
| NanoScope binary AFM images, version `0x09300201`, scanner `Dim 4000`, Image mode, `PeakForce QNM` | Independently checked configuration. Electrical/arbitrary-unit channels retain their own interpretation limits. |
| Other NanoScope configurations within the readable binary raster subset | Persistent **Unverified configuration** warning. No claim of instrument validation; unsupported calibration encodings are omitted with reasons. |
| Asylum MFP-3D, little-endian float32 IBW v5 image stack | Independently checked subset. Height unit convention is disclosed. Missing ZSensor units remain unknown; explicit UserIn voltage units are preserved. |
| Other calibrated IBW v5 image configurations | Persistent **Unverified configuration** warning. Explicit dimensions/units are read; no blanket height calibration is inferred. |
| TIFF/JPK, older GWYO/IBW, force spectroscopy, unidentified formats | Rejected with an unsupported-format/configuration message. No guessed image is produced. |
| Corrupt/truncated headers, impossible dimensions or ambiguous required calibration | Rejected; unsupported individual channels may be omitted only when their boundaries are sound and the omission is reported. |

“Validated” refers to the documented import subset and numerical evidence, not every model, firmware release, acquisition mode, or physical quantity. A channel with missing units is visibly unverified even when its file configuration is recognized. Structurally readable but unverified inputs may be inspected with warnings; measurements retain their stored/unknown units.

See [NanoScope limitations](nanoscope-support.md), [IBW limitations](ibw-support.md), and [sample provenance](compatibility-samples.md). Add a configuration to the validated list only with identifiable provenance, independent numerical comparison, unit/orientation checks, and malformed-input regression coverage. Downloads alone do not establish support.

Support details are recorded in channel metadata (`Import / support`) and exports. Numerical recipes retain source and engine hashes. The addition of configuration gating changes the NanoScope engine identity: older NanoScope recipes require their original application snapshot and are rejected by this version. Regenerate a recipe to start a new analysis record; do not edit its stored hash. Existing GWYP chemist recipes remain replayable.
