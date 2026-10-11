// Optional local-fixture validation against independently generated pySPM arrays.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSource, engineIdentity } from "./io.mjs";
import { sha256 } from "../web/engine.js";
const reference = JSON.parse(
  await readFile("docs/nanoscope-reference.json", "utf8"),
);
const source = await loadSource(reference.fixture);
if (source.sha256 !== reference.fixture_sha256)
  throw new Error("Fixture identity mismatch");
const directory = process.argv[2] ?? "/tmp/afm-nanoscope-reference";
const expectedUnits = ["m", "V", "Arb", "log(Arb)", "V", "V", "Arb", "m"];
const results = [];
for (const image of reference.images) {
  const channel = source.channels[String(image.index)];
  if (
    !channel ||
    channel.width !== image.dimensions.width ||
    channel.height !== image.dimensions.height ||
    channel.z_unit !== expectedUnits[image.index]
  )
    throw new Error("Channel geometry or unit mismatch");
  const bytes = await readFile(
    resolve(directory, `channel-${image.index}.f64`),
  );
  if (bytes.length !== channel.data.length * 8)
    throw new Error("Reference array size mismatch");
  const unitFactor = image.reader_output_unit === "nm" ? 1e-9 : 1;
  let maxError = 0,
    squaredError = 0,
    maxReference = 0;
  for (let row = 0; row < channel.height; row++)
    for (let col = 0; col < channel.width; col++) {
      const expected =
        bytes.readDoubleLE(
          ((channel.height - 1 - row) * channel.width + col) * 8,
        ) * unitFactor;
      const actual = channel.data[row * channel.width + col];
      if (!Number.isFinite(expected) || !Number.isFinite(actual))
        throw new Error("Unexpected nonfinite sample");
      const difference = Math.abs(actual - expected);
      maxError = Math.max(maxError, difference);
      maxReference = Math.max(maxReference, Math.abs(expected));
      squaredError += difference * difference;
    }
  const tolerance = 32 * Number.EPSILON * maxReference;
  if (maxError > tolerance)
    throw new Error(
      `Channel ${image.index} exceeds numerical comparison tolerance`,
    );
  results.push({
    id: channel.id,
    title: channel.title,
    pixels: channel.data.length,
    unit: channel.z_unit,
    reference_array_sha256: await sha256(bytes),
    max_absolute_error: maxError,
    rmse: Math.sqrt(squaredError / channel.data.length),
    tolerance,
    passed: true,
  });
}
const report = {
  fixture_sha256: source.sha256,
  engine_sha256: await engineIdentity(source.format),
  reference_reader: reference.reader,
  transformation:
    "Reverse reference rows once; convert height nm to m. Other values unchanged; unit labels validated separately against header.",
  limitation:
    "Reader agreement on one real fixture; not universal format coverage or manufacturer-certified calibration.",
  channels: results,
};
await writeFile(
  "docs/nanoscope-validation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(results, null, 2));
