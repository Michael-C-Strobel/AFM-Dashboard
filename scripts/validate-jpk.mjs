// Local-only full-array agreement with independently generated TIFF/JPK results.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSource, engineIdentity } from "./io.mjs";
import { sha256 } from "../web/engine.js";
const reference = JSON.parse(await readFile("docs/jpk-reference.json", "utf8"));
const source = await loadSource(reference.fixture);
if (source.sha256 !== reference.fixture_sha256)
  throw new Error("Fixture identity mismatch");
const results = [];
for (const image of reference.channels) {
  const c = source.channels[String(image.index)];
  if (
    !c ||
    c.title !== image.name ||
    c.width !== image.width ||
    c.height !== image.height ||
    c.z_unit !== image.native_unit
  )
    throw new Error("Channel metadata mismatch");
  if (Math.abs(c.xreal - 3.2691651420070083e-7) > 1e-22 || c.yreal !== c.xreal)
    throw new Error("Lateral extent mismatch");
  const bytes = await readFile(
    resolve(
      process.argv[2] ?? "/tmp/afm-jpk-reference",
      `channel-${image.index}.f64`,
    ),
  );
  if (
    bytes.length !== c.data.length * 8 ||
    (await sha256(bytes)) !== image.array_sha256
  )
    throw new Error("Reference array identity mismatch");
  let maxError = 0;
  for (let i = 0; i < c.data.length; i++) {
    const expected = bytes.readDoubleLE(i * 8),
      actual = c.data[i];
    if (!Number.isFinite(expected) || !Number.isFinite(actual))
      throw new Error("Unexpected nonfinite sample");
    maxError = Math.max(maxError, Math.abs(expected - actual));
  }
  if (maxError !== 0)
    throw new Error(
      `Channel ${image.index} differs from independent calibration`,
    );
  results.push({
    id: c.id,
    title: c.title,
    pixels: c.data.length,
    unit: c.z_unit,
    max_absolute_error: maxError,
    reference_array_sha256: image.array_sha256,
    passed: true,
  });
}
const report = {
  fixture_sha256: source.sha256,
  engine_sha256: await engineIdentity(source.format),
  reference_reader: reference.reader,
  tiff_reader: reference.tiff_reader,
  support: source.support,
  transformation:
    "Reference arrays already have one Y flip and native selected-slot units; no further scaling. Direct raw multiplier/offset applied once, parent coefficients not reapplied.",
  channels: results,
};
await writeFile(
  "docs/jpk-validation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `PASS: ${results.length} channels, ${results.reduce((n, c) => n + c.pixels, 0)} calibrated values match exactly.`,
);
