#!/usr/bin/env python3
"""Independent NumPy least-squares oracle; stdin/stdout JSON, no application imports."""
import hashlib
import json
import platform
import sys
import numpy as np


def decode(value):
    return {"NaN": np.nan, "Infinity": np.inf, "-Infinity": -np.inf}.get(value, value) if isinstance(value, str) else value


def encode(value):
    return "NaN" if np.isnan(value) else "Infinity" if value == np.inf else "-Infinity" if value == -np.inf else float(value)


def calculate(case):
    c = case["channel"]
    w, h = c["width"], c["height"]
    data = np.array([decode(v) for v in c["data"]], dtype=np.float64).reshape(h, w)
    output = data.copy()
    mask = np.array(c["mask"], dtype=np.uint8).reshape(h, w)
    yy, xx = np.indices((h, w))
    x = c["xoff"] + (xx + 0.5) * c["xreal"] / w
    y = c["yoff"] + (yy + 0.5) * c["yreal"] / h
    valid = np.isfinite(data) & (mask == 0)
    selection = case["selection"]
    roi = selection.get("roi")
    if roi is not None:
        valid &= (x >= roi[0]) & (x <= roi[2]) & (y >= roi[1]) & (y <= roi[3])
    # Independent vectorized even-odd ray casting at physical pixel centers.
    for polygon in selection.get("exclude_polygons", []):
        inside = np.zeros((h, w), dtype=bool)
        for i, a in enumerate(polygon):
            b = polygon[i - 1]
            cross = (a[1] > y) != (b[1] > y)
            if a[1] != b[1]:
                inside ^= cross & (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])
        valid &= ~inside
    degree, rows = case["parameters"]["degree"], case["parameters"]["axis"] == "rows"
    selected_counts, skipped = [], []
    try:
        if not np.any(valid):
            raise ValueError("No valid selected pixels")
        for line in range(h if rows else w):
            take = valid[line, :] if rows else valid[:, line]
            values = data[line, :] if rows else data[:, line]
            positions = np.flatnonzero(take)
            selected_counts.append(int(len(positions)))
            if not len(positions):
                skipped.append(line)
                continue
            if len(positions) < degree + 1:
                raise ValueError("Underdetermined line")
            origin = (positions[0] + positions[-1]) / 2
            scale = (positions[-1] - positions[0]) / 2 or 1
            t = (positions - origin) / scale
            design = np.polynomial.polynomial.polyvander(t, degree)
            coefficients, _, rank, _ = np.linalg.lstsq(design, values[take], rcond=None)
            if rank < degree + 1:
                raise ValueError("Rank deficient line")
            coordinate = (np.arange(len(values)) - origin) / scale
            corrected = values - np.polynomial.polynomial.polyval(coordinate, coefficients)
            finite = np.isfinite(values)
            destination = output[line, :] if rows else output[:, line]
            destination[finite] = corrected[finite]
        return {"status": "succeeded", "data": [encode(v) for v in output.ravel()], "mask": mask.ravel().tolist(), "selected_counts": selected_counts, "skipped_lines": skipped}
    except ValueError as error:
        return {"status": "rejected", "reason": str(error), "selected_counts": selected_counts, "skipped_lines": skipped}


raw = sys.stdin.buffer.read()
request = json.loads(raw)
print(json.dumps({"environment": {"python": sys.version, "executable": sys.executable, "numpy": np.__version__, "platform": platform.platform()}, "request_sha256": hashlib.sha256(raw).hexdigest(), "results": [calculate(case) for case in request["cases"]]}, allow_nan=False))
