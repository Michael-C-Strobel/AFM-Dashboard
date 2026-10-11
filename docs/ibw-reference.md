# Independent Igor Binary Wave reference

## Executed reference and reproduction

Executed **igor2 0.5.12** on `data/external/reference-only/afmreader-sample_0.ibw`. Fixture SHA-256: `5dddfebc5ba226c5e8cb4aaa93d985b5067b747e9b8b0ace068bc1d4a5583b97`. The wheel SHA-256 is `1d99b30a3b82710578aafb21fbe02572c59f77ad4daba6d13a952115d200bac6`; `binarywave.py` SHA-256 is `26edce79f3acc46592607cf53095240e0bb0bdcb23dd1588f25b64103ab9fde4`.

The external wheel was extracted in `/tmp/afm-ibw-reference/deps`; no reader source or runtime dependencies were added to the application. [validate-ibw-reference.py](../scripts/validate-ibw-reference.py) verifies fixture/source hashes, calls igor2, and cross-checks all 2,097,152 samples with independent NumPy float32 decoding. All match exactly. The first 384 bytes also pass the 16-bit additive header checksum (sum modulo 65536 equals zero); igor2's own checksum enforcement is commented out.

```sh
python -m pip install --target /tmp/afm-ibw-reference/deps --no-deps igor2==0.5.12
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/tmp/afm-ibw-reference/deps \
python scripts/validate-ibw-reference.py \
  data/external/reference-only/afmreader-sample_0.ibw \
  --output docs/ibw-reference.json
```

NumPy is needed for this optional development validator. Exact Python/NumPy versions are recorded in [ibw-reference.json](ibw-reference.json).

## Header and labels

The file is little-endian **IBW v5**, type **2 (float32)**, wave name `dna1_pll0015`, dimensions `[512,512,8,0]`, 2,097,152 points. Data start at byte 384 and occupy 8,388,608 bytes. Dimension 0 varies fastest, then dimension 1, then channel: igor2 returns `wData[x,y,channel]` with Fortran storage order.

Binary header `wfmSize=8388928`, `noteSize=13257`, `dimLabelsSize=[0,0,288,0]`; formula, extended units, string indices and option sizes are zero. `sfA=[1.5655577299412918e-9,1.5655577299412918e-9,1,1]`, `sfB=[0,0,0,0]`. First two dimension units are `m`; global data units are empty. All exact header fields, raw label slots and note text appear in JSON.

Label slots begin at byte **8,402,249**. The first slot is the dimension label; the next eight identify channels. Each 32-byte slot is a NUL-terminated C string. Channel 0 is therefore **HeightTrace**, followed by a stray `e` after its terminator. igor2 concatenates non-NUL bytes and returns **HeightTracee**; the AFMReader wrapper documents and uses that artifact. Both names are recorded; array files use stable numeric indices.

After labels, 131,415 trailing bytes remain. The tail includes preview image descriptors and ends **MFP3D**, matching Gwyddion's Asylum-producer detection. These trailing bytes are not part of the float32 image cube.

## Values, units and notes

No scale, offset, planefit, display range, or calibration transform was applied to the values below. All samples are finite.

| Index | C-string channel | Minimum | Maximum | Mean | Unit evidence |
| --- | --- | ---: | ---: | ---: | --- |
| 0 | HeightTrace | -8.45112879233e-07 | -8.2185545125e-07 | -8.31953045056e-07 | m (reader fallback only) |
| 1 | HeightRetrace | -8.45114243475e-07 | -8.21718742827e-07 | -8.32004644187e-07 | m (reader fallback only) |
| 2 | ZSensorTrace | 0.605163574219 | 1.18225097656 | 0.985788818216 | m (reader fallback only) |
| 3 | ZSensorRetrace | 0.615234375 | 1.25640869141 | 0.985807727557 | m (reader fallback only) |
| 4 | UserIn0Trace | -2.83966064453 | 6.53045654297 | -0.0360080646351 | V (explicit note) |
| 5 | UserIn0Retrace | -2.59674072266 | 6.39831542969 | 0.0867918937001 | V (explicit note) |
| 6 | UserIn1Trace | 5.85571289062 | 9.68780517578 | 6.73621247406 | V (explicit note) |
| 7 | UserIn1Retrace | 5.97717285156 | 9.75494384766 | 6.76740572671 | V (explicit note) |

Notes explicitly give `UserIn0Unit: V`, `UserIn1Unit: V`; no `HeightUnit` or `ZSensorUnit` is present. Gwyddion's inspected importer defaults Height and ZSensor names to metres, after checking a channel-specific note unit. This is a software convention, not explicit measurement calibration. ZSensor values around 1 would represent approximately 1 m under that fallback; their physical interpretation remains unresolved. AFMReader applies `*1e9` to every channel, which is inappropriate as a universal nm conversion for the explicit voltage channels.

The JSON preserves note entries in original order, including duplicate keys and string values such as `NaN`, `-inf`, and `*ERROR*`. It also retains full note text with Latin-1 byte-preserving decoding; the date contains non-ASCII bytes whose intended character encoding was not established. Relevant acquisition notes include Fast/SlowScanSize `8e-7`, ScanPoints/ScanLines `512`, ScanAngle `0`, ScanDown `1`, X/YScanDirection `1`, plus per-channel display and planefit settings. These settings were recorded, not replayed.

## Orientation and coordinates

`channel-N.f64` under `/tmp/afm-ibw-reference/` contains `flipud(wData[:,:,N].T)` as little-endian float64 in C row-major order, **without unit conversion**. Display `[row,column]` equals Igor `[column,511-row,N]`. Each file is 2,097,152 bytes. Companion `channel-N-wave-order.f64` preserves the reader's `[x,y]` axes in C order. JSON includes SHA-256, statistics, corners, centre, and ten deterministic sample positions for each channel.

The orientation follows AFMReader's inspected transpose/vertical-flip sequence. Gwyddion independently reads contiguous channel rasters and vertically inverts them. Neither cited image import path adds a direction-dependent horizontal flip. AFMReader and Gwyddion were source-inspected, not executed for this packet; igor2 was executed.

Header coordinates follow `coordinate=sfA*index+sfB`: first-to-last span is **800 nm**, spacing **1.5655577299412918 nm**, and pixel-cell extent `512*sfA` is **801.5655577299414 nm**. AFMReader instead divides note scan size by 512, returning **1.5625 nm**. Gwyddion uses `sfA*dimension` for field extents. These are distinct conventions; the report preserves both rather than treating them as equal.

## Primary sources

- [Pinned igor2 release](https://pypi.org/project/igor2/0.5.12/) and [official source](https://github.com/AFM-analysis/igor2/blob/master/igor2/binarywave.py); executed release is pinned by wheel/source hashes above.
- [Pinned AFMReader IBW wrapper](https://github.com/AFM-SPM/AFMReader/blob/caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77/AFMReader/ibw.py).
- [Gwyddion igorfile.c SVN revision 27984](https://svn.code.sf.net/p/gwyddion/code/!svn/bc/27984/trunk/gwyddion/modules/file/igorfile.c), SHA-256 `9a587932d971374f2c5aed3a720b913688dd9758a5c89ed7ab9e9ad6f0320a43`: Asylum marker, NUL-terminated labels, channel-unit defaults, extent and orientation rules.
- [WaveMetrics importing documentation](https://docs.wavemetrics.com/igorpro/data/importing-and-exporting-data): binary waves preserve numeric contents, dimension scaling, units, and notes.
