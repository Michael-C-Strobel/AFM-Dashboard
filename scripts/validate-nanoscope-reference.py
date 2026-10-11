#!/usr/bin/env python3
"""Dev-only evidence generator. Requires pinned external pySPM on PYTHONPATH."""
import argparse
import hashlib
import inspect
import json
from pathlib import Path
import re
import sys

import numpy as np
import pySPM

COMMIT = "20a05dbae154bc1e8c87f64f8c094f251d0da830"
FIXTURE_SHA = "71a535e577285b6d43c1cbad134b69ab9f472806661a231f981a2c96b2d3972d"
READER_SHA = "c544e5c1279b461ea94981bfe44747e52da2b22f52800e9388b5178f81c670e5"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    payload = args.fixture.read_bytes()
    assert hashlib.sha256(payload).hexdigest() == FIXTURE_SHA, "Unexpected fixture"
    reader_path = Path(inspect.getfile(pySPM.Bruker))
    assert hashlib.sha256(reader_path.read_bytes()).hexdigest() == READER_SHA, "Unexpected reader"
    scan = pySPM.Bruker(args.fixture)
    report = {
        "fixture": str(args.fixture), "fixture_sha256": FIXTURE_SHA,
        "reader": {"name": "pySPM", "version": "0.6.3", "commit": COMMIT,
                   "Bruker.py_sha256": READER_SHA,
                   "source_url": f"https://github.com/scholi/pySPM/blob/{COMMIT}/pySPM/Bruker.py"},
        "environment": {"python": sys.version.split()[0], "numpy": np.__version__},
        "point_convention": "Zero-based raw stored [row,column]; corners, centre floor(N/2), then 10 LCG indices seeded17: state=(1664525*state+1013904223) mod2^32, index=state mod pixel_count.",
        "orientation": "pySPM output has raw file row/column order; no flip, transpose, rotation, line retrace correction or frame direction correction. AFMReader load_spm at caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77 flips rows once after pySPM.",
        "limits": "Reference-reader output is not independently established physical calibration. Unitless sensitivities give misleading V labels in pySPM. Log domain semantics unresolved; no exponentiation applied. Only this square full-frame fixture verified.",
        "images": [],
    }
    for i, layer in enumerate(scan.layers):
        text = lambda key: layer[key.encode()][0].decode("latin1")
        title = text("@2:Image Data").split('"')[1]
        raw = scan._get_raw_layer(i)
        height, width = raw.shape
        output = scan.get_channel(title, backward=text("Line Direction")=="Retrace", corr=None, lazy=False)
        points = [(0, 0), (0, width-1), (height-1, 0), (height-1, width-1), (height//2, width//2)]
        state = 17
        for _ in range(10):
            state = (1664525 * state + 1013904223) % 2**32
            points.append(divmod(state % raw.size, width))
        z = text("@2:Z scale")
        sensitivity_key = re.search(r"\[([^]]+)\]", z)[1]
        sensitivity = scan.scanners[0][("@"+sensitivity_key).encode()][0].decode("latin1")
        soft = float(sensitivity.split()[1])
        hardvalue = float(z.split()[ -2 ])
        hardscale = float(re.search(r"\(([-+0-9.eE]+) ", z)[1])
        bpp = int(text("Bytes/pixel"))
        factor = hardvalue / 256**bpp * soft
        nonzero = tuple(np.argwhere(raw != 0)[0])
        observed_ratio = float(output.pixels[nonzero]/raw[nonzero])
        array_path = Path("/tmp/afm-nanoscope-reference")/f"channel-{i}.f64"
        output.pixels.astype("<f8").tofile(array_path)
        np.testing.assert_allclose(output.pixels, raw * (hardvalue / 256**bpp) * soft, rtol=0, atol=0)
        raw_direct = np.frombuffer(payload, dtype="<i4", count=raw.size, offset=int(text("Data offset"))).reshape(raw.shape)
        np.testing.assert_array_equal(raw, raw_direct)
        stats = lambda a: {"min": float(a.min()), "max": float(a.max()), "mean": float(a.mean())}
        report["images"].append({
            "index": i, "title": title, "dimensions": {"width": width, "height": height},
            "byte_offset": int(text("Data offset")), "data_length": int(text("Data length")),
            "declared_bytes_per_pixel": bpp, "actual_storage_bytes_per_pixel": scan._get_bpp(i),
            "storage": "signed little-endian int32",
            "frame_direction": text("Frame direction"), "line_direction": text("Line Direction"),
            "header_z_scale": z, "header_z_offset": text("@2:Z offset"),
            "header_sensitivity_key": sensitivity_key, "header_sensitivity": sensitivity,
            "conversion_factor": factor, "observed_nonzero_ratio": observed_ratio,
            "ratio_probe": {"row":int(nonzero[0]),"column":int(nonzero[1]),"raw_count":int(raw[nonzero]),"reader_value":float(output.pixels[nonzero])},
            "decoded_array_path":str(array_path), "decoded_array_format":"little-endian float64, C row-major, raw stored orientation", "reader_output_unit": output.zscale,
            "header_hard_unit": z.split()[-1],
            "alternative_hardscale_times_sensitivity": hardscale*soft,
            "alternative_to_reader_factor_ratio": hardscale*soft/factor,
            "offset_applied": False, "raw_statistics": stats(raw), "decoded_statistics": stats(output.pixels),
            "extent": output.size, "pixel_pitch": {"x": output.size['real']['x']/width,"y": output.size['real']['y']/height,"unit":"nm"},
            "points": [{"row": r, "column": c, "raw_count": int(raw[r,c]), "reader_value": float(output.pixels[r,c])} for r,c in points],
            "scaling_limit": "Logarithm base and physical modulus conversion unresolved; pySPM only scales counts linearly." if title == 'LogDMTModulus' else "Numeric reader agreement only; header units and physical calibration must be reviewed separately.",
        })
    content = json.dumps(report, indent=2, allow_nan=False)+"\n"
    if args.output:
        args.output.write_text(content)
    else:
        print(content, end="")


if __name__ == "__main__":
    main()
