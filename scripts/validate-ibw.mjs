// Optional independent-array check. Missing local reference arrays are an error.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSource, engineIdentity } from "./io.mjs";
import { sha256 } from "../web/engine.js";
const reference = JSON.parse(await readFile("docs/ibw-reference.json", "utf8"));
const source = await loadSource(reference.fixture);
if (source.sha256 !== reference.fixture_sha256)
  throw new Error("Fixture identity mismatch");
const expectedUnits = ["m", "m", null, null, "V", "V", "V", "V"],
  results = [];
for (const image of reference.channels) {
  const c = source.channels[String(image.index)];
  if (
    !c ||
    c.title !== image.label_c_string ||
    c.width !== image.dimensions.width ||
    c.height !== image.dimensions.height ||
    c.z_unit !== expectedUnits[image.index]
  )
    throw new Error("Channel metadata mismatch");
  if (Math.abs(c.xreal / c.width - 1.5655577299412918e-9) > 1e-23)
    throw new Error("Pixel pitch mismatch");
  const bytes = await readFile(
    resolve(
      process.argv[2] ?? "/tmp/afm-ibw-reference",
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
      `Channel ${image.index} differs from independent float32 decoding`,
    );
  results.push({
    id: c.id,
    title: c.title,
    pixels: c.data.length,
    unit: c.z_unit,
    pitch_m: c.xreal / c.width,
    max_absolute_error: maxError,
    reference_array_sha256: image.array_sha256,
    passed: true,
  });
}
const report = {
  fixture_sha256: source.sha256,
  engine_sha256: await engineIdentity(source.format),
  reference_reader: reference.reader,
  support: source.support,
  transformation:
    "Reference arrays already transpose+reverse Y; no value scaling applied for this fixture. Physical units checked separately, ZSensor retained as unknown.",
  channels: results,
};
await writeFile(
  "docs/ibw-validation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `PASS: ${results.length} channels, ${results.reduce((n, c) => n + c.pixels, 0)} values match exactly.`,
);
