/** Dev-only independent NumPy comparison. Run: node scripts/validate-line-polynomial.mjs
 * Optional AFM_REFERENCE_PYTHON selects an existing Python with NumPy; never installs.
 * Writes docs/line-polynomial-validation.json only after every comparison passes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { applyOperation } from "../web/engine.js";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (v) =>
  Number.isNaN(v)
    ? "NaN"
    : v === Infinity
      ? "Infinity"
      : v === -Infinity
        ? "-Infinity"
        : v;
const decode = (v) =>
  v === "NaN"
    ? NaN
    : v === "Infinity"
      ? Infinity
      : v === "-Infinity"
        ? -Infinity
        : v;
const cases = [];
for (const axis of ["rows", "columns"])
  for (let degree = 0; degree <= 3; degree++) {
    for (const scenario of [
      "polynomial",
      "feature_roi_exclusion",
      "nonfinite_empty_line",
      ...(degree > 0 ? ["underdetermined"] : []),
    ]) {
      const width = 17,
        height = 13,
        xoff = 2e-6,
        yoff = -3e-6,
        dx = 0.4e-6,
        dy = 0.7e-6;
      const rows = axis === "rows",
        length = rows ? width : height,
        lines = rows ? height : width;
      const data = Array.from({ length: width * height }, (_, i) => {
        const x = i % width,
          y = Math.floor(i / width),
          j = rows ? x : y,
          line = rows ? y : x,
          t = (2 * j) / (length - 1) - 1;
        let value = (15 + line * 0.3) * 1e-9;
        for (let k = 1; k <= degree; k++)
          value += (k % 2 ? -1 : 1) * (k + 1) * 1e-9 * t ** k;
        if (scenario !== "polynomial")
          value +=
            Math.sin(i * 1.734 + degree) * 0.03e-9 +
            (j >= 6 && j < 9 ? 4e-9 : 0);
        return value;
      });
      const mask = Array(width * height).fill(0),
        selection = { roi: null, exclude_polygons: [] };
      const rectangle = (j0, j1, l0, l1) =>
        rows
          ? [xoff + j0 * dx, yoff + l0 * dy, xoff + j1 * dx, yoff + l1 * dy]
          : [xoff + l0 * dx, yoff + j0 * dy, xoff + l1 * dx, yoff + j1 * dy];
      if (scenario === "feature_roi_exclusion") {
        selection.roi = rectangle(1, length - 1, 1, lines - 1);
        const [a, b, c, d] = rectangle(6, 9, 0, lines);
        selection.exclude_polygons = [
          [
            [a, b],
            [c, b],
            [c, d],
            [a, d],
          ],
        ];
        mask[rows ? 2 * width + 3 : 3 * width + 2] = 1;
      }
      if (scenario === "nonfinite_empty_line") {
        for (let j = 0; j < length; j++)
          mask[
            rows
              ? Math.floor(lines / 2) * width + j
              : j * width + Math.floor(lines / 2)
          ] = 1;
        data[0] = NaN;
        data[width + 1] = Infinity;
        data[2 * width + 2] = -Infinity;
        mask[3 * width + 3] = 1;
      }
      if (scenario === "underdetermined")
        selection.roi = rectangle(0, degree, 0, lines);
      cases.push({
        id: axis + "-" + degree + "-" + scenario,
        parameters: { axis, degree },
        scenario,
        selection,
        channel: {
          id: "0",
          title: "Synthetic polynomial",
          width,
          height,
          xreal: width * dx,
          yreal: height * dy,
          xoff,
          yoff,
          xy_unit: "m",
          z_unit: "m",
          data: data.map(encode),
          mask,
        },
      });
    }
  }
let python = process.env.AFM_REFERENCE_PYTHON;
if (!python) {
  try {
    await access("/tmp/afm-workflow-reference-env/bin/python");
    python = "/tmp/afm-workflow-reference-env/bin/python";
  } catch {
    python = "python";
  }
}
const request = JSON.stringify({ cases }),
  referencePath = fileURLToPath(
    new URL("line-polynomial-reference.py", import.meta.url),
  );
const child = spawnSync(python, [referencePath], {
  input: request,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (child.error || child.status !== 0)
  throw new Error(
    "Independent NumPy reference failed (no skipping or installation): " +
      (child.error?.message || child.stderr),
  );
const reference = JSON.parse(child.stdout);
assert.equal(reference.request_sha256, digest(request));
assert.equal(reference.results.length, cases.length);
const results = [];
for (let n = 0; n < cases.length; n++) {
  const item = cases[n],
    oracle = reference.results[n],
    input = {
      ...item.channel,
      data: Float64Array.from(item.channel.data, decode),
      mask: Uint8Array.from(item.channel.mask),
    };
  const fingerprint = () =>
    digest(
      Buffer.concat([
        Buffer.from(input.data.buffer),
        Buffer.from(input.mask.buffer),
        Buffer.from(JSON.stringify({ ...input, data: null, mask: null })),
      ]),
    );
  const source_sha256 = fingerprint();
  let actual, error;
  try {
    actual = applyOperation(
      input,
      { name: "line_polynomial", params: item.parameters },
      item.selection,
    );
  } catch (e) {
    error = e.message;
  }
  assert.equal(fingerprint(), source_sha256, item.id + " changed source");
  const common = {
    id: item.id,
    parameters: item.parameters,
    scenario: item.scenario,
    geometry: {
      shape: [input.height, input.width],
      xreal: input.xreal,
      yreal: input.yreal,
      xoff: input.xoff,
      yoff: input.yoff,
      xy_unit: input.xy_unit,
      z_unit: input.z_unit,
    },
    selection: item.selection,
    source_sha256,
    source_after_sha256: fingerprint(),
    source_unchanged: true,
  };
  if (oracle.status === "rejected") {
    assert.ok(error, item.id + " must reject");
    assert.equal(item.scenario, "underdetermined");
    results.push({
      ...common,
      status: "rejected",
      engine_reason: error,
      reference_reason: oracle.reason,
    });
    continue;
  }
  assert.equal(error, undefined, item.id + " unexpectedly rejected");
  assert.equal(oracle.status, "succeeded");
  assert.deepEqual(
    Array.from(actual.channel.mask),
    oracle.mask,
    item.id + " masks",
  );
  assert.deepEqual(
    actual.details.skipped_lines,
    oracle.skipped_lines,
    item.id + " skipped lines",
  );
  const expected = oracle.data.map(decode),
    maxAbs = Math.max(...expected.filter(Number.isFinite).map(Math.abs)),
    tolerance = 1e-15 + 1e-9 * maxAbs;
  let maxError = 0,
    finite_count = 0,
    nonfinite_count = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = actual.channel.data[i],
      b = expected[i];
    if (!Number.isFinite(b)) {
      assert.equal(encode(a), encode(b), item.id + " nonfinite " + i);
      nonfinite_count++;
      continue;
    }
    assert.ok(Number.isFinite(a));
    const error = Math.abs(a - b);
    maxError = Math.max(maxError, error);
    assert.ok(
      error <= tolerance,
      item.id + " value " + i + " error " + error + " > " + tolerance,
    );
    finite_count++;
  }
  results.push({
    ...common,
    status: "passed",
    finite_count,
    nonfinite_count,
    max_abs_reference: maxAbs,
    max_absolute_error: maxError,
    tolerance,
    selected_counts: oracle.selected_counts,
    skipped_lines: oracle.skipped_lines,
    mask_exact: true,
    nonfinite_exact: true,
  });
}
const files = [
  "web/engine.js",
  "scripts/validate-line-polynomial.mjs",
  "scripts/line-polynomial-reference.py",
];
const code = await Promise.all(
  files.map(async (name) => ({
    name,
    sha256: digest(await readFile(new URL("../" + name, import.meta.url))),
  })),
);
const report = {
  schema_version: 1,
  kind: "independent_line_polynomial_validation",
  generated_at: new Date().toISOString(),
  method:
    "Independent NumPy numpy.linalg.lstsq; no application imports in Python; selected-position normalized pixel coordinates; full finite-line correction",
  tolerance: "1e-15 + 1e-9 * maxabs(reference finite processed values)",
  fixture_definition:
    "17x13 calibrated anisotropic grid; line-dependent polynomial degree 0–3; deterministic sinusoidal noise and stepped feature; see generator code hash",
  environment: {
    node: process.version,
    platform: platform(),
    architecture: arch(),
    cpu: cpus()[0]?.model ?? null,
    reference: reference.environment,
  },
  code,
  request_sha256: digest(request),
  summary: {
    cases: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    rejected: results.filter((r) => r.status === "rejected").length,
  },
  limitations: [
    "Synthetic numerical agreement only; no instrument calibration or scientific background-choice validation.",
    "Independent reference uses the same documented selection semantics and normalization basis but a different least-squares implementation.",
    "Fixed absolute tolerance may dominate nearly zero residuals.",
    "No ill-conditioned large-offset stress or performance certification.",
  ],
  results,
};
await writeFile(
  new URL("../docs/line-polynomial-validation.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
