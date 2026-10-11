import test from "node:test";
import assert from "node:assert/strict";
import { parseIbw } from "../web/ibw.js";

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const near = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.max(Math.abs(expected) * 1e-12, 1e-25),
    `${actual} != ${expected}`,
  );
const types = {
  2: { size: 4, method: "Float" },
  4: { size: 8, method: "Double" },
  8: { size: 1, method: "Int8" },
  16: { size: 2, method: "Int16" },
  32: { size: 4, method: "Int32" },
  72: { size: 1, method: "UInt8" },
  80: { size: 2, method: "UInt16" },
  96: { size: 4, method: "UInt32" },
};
function checksum(buffer, endian = "LE") {
  buffer[`writeUInt16${endian}`](0, 2);
  let sum = 0;
  for (let pos = 0; pos < 384; pos += 2)
    sum = (sum + buffer[`readUInt16${endian}`](pos)) & 65535;
  buffer[`writeUInt16${endian}`](-sum & 65535, 2);
  return buffer;
}
function fixture(options = {}) {
  const endian = options.endian ?? "LE",
    type = options.type ?? 2,
    dims = options.dims ?? [3, 2, 0, 0],
    info = types[type] ?? types[2];
  const values = options.values ?? [-3, -2, -1, 1, 2, 3],
    note = Buffer.from(options.note ?? ""),
    dataUnit = options.unit ?? "nm";
  let labels = Buffer.alloc(0);
  if (options.labels) {
    labels = Buffer.alloc((options.labels.length + 1) * 32);
    labels.write("Dimension label", 0);
    options.labels.forEach((text, i) => labels.write(text, (i + 1) * 32, 32));
  }
  const header = Buffer.alloc(384),
    payload = Buffer.alloc(values.length * info.size);
  header[`writeInt16${endian}`](5, 0);
  header[`writeInt32${endian}`](320 + payload.length, 4);
  header[`writeInt32${endian}`](note.length, 12);
  header[`writeInt32${endian}`](labels.length, 44);
  header[`writeInt32${endian}`](options.npnts ?? values.length, 76);
  header[`writeInt16${endian}`](type, 80);
  header.write("Synthetic image", 92, 32);
  dims.forEach((n, i) => header[`writeInt32${endian}`](n, 132 + i * 4));
  (options.sfA ?? [2, 3, 1, 1]).forEach((n, i) =>
    header[`writeDouble${endian}`](n, 148 + i * 8),
  );
  [120, -70, 0, 0].forEach((n, i) =>
    header[`writeDouble${endian}`](n, 180 + i * 8),
  );
  header.write(dataUnit, 212, 4);
  header.write(options.xyUnit ?? "um", 216, 4);
  header.write(options.xyUnit ?? "um", 220, 4);
  values.forEach((v, i) => {
    const method = `write${info.method}${info.size === 1 ? "" : endian}`;
    payload[method](v, i * info.size);
  });
  return Buffer.concat([checksum(header, endian), payload, note, labels]);
}
function read(options) {
  return parseIbw(ab(fixture(options)));
}
function mutate(source, fn, endian = "LE") {
  const result = Buffer.from(source);
  fn(result);
  return checksum(result, endian);
}

for (const endian of ["LE", "BE"]) {
  test(`${endian} float32 and float64 preserve signed values and reverse Y once`, () => {
    for (const type of [2, 4]) {
      const c = read({ endian, type }).channels["0"];
      assert.deepEqual(c.shape, [2, 3]);
      assert.equal(c.width, 3);
      assert.equal(c.height, 2);
      [1, 2, 3, -3, -2, -1].forEach((v, i) => near(c.data[i], v * 1e-9));
      near(c.xreal, 6e-6);
      near(c.yreal, 6e-6);
      assert.equal(c.xoff, 0);
      assert.equal(c.yoff, 0);
      assert.equal(c.xy_unit, "m");
      assert.equal(c.z_unit, "m");
      assert.match(JSON.stringify(c.metadata), /120/);
      assert.match(JSON.stringify(c.metadata), /-70/);
    }
  });
  test(`${endian} signed and unsigned integer types preserve their numeric range`, () => {
    for (const [type, low, high] of [
      [8, -128, 127],
      [16, -32768, 32767],
      [32, -2147483648, 2147483647],
      [72, 0, 255],
      [80, 0, 65535],
      [96, 0, 4294967295],
    ]) {
      const c = read({
        endian,
        type,
        values: [low, 1, 2, 3, 4, high],
        unit: "V",
      }).channels["0"];
      assert.deepEqual([...c.data], [3, 4, high, low, 1, 2]);
      assert.equal(c.z_unit, "V");
    }
  });
}

test("layer channels are first-dimension-fast and ignore bytes after label NUL", () => {
  const result = read({
    dims: [3, 2, 2, 0],
    values: [-3, -2, -1, 1, 2, 3, 10, 20, 30, 40, 50, 60],
    labels: ["HeightTrace\0e", "PhaseTrace"],
  });
  assert.deepEqual(Object.keys(result.channels), ["0", "1"]);
  assert.equal(result.channels["0"].title, "HeightTrace");
  assert.equal(result.channels["1"].title, "PhaseTrace");
  [40, 50, 60, 10, 20, 30].forEach((v, i) =>
    near(result.channels["1"].data[i], v * 1e-9),
  );
});

test("generic image missing vertical units stays unknown and warns", () => {
  const result = read({ unit: "" });
  const c = result.channels["0"];
  assert.equal(c.z_unit, null);
  assert.deepEqual([...c.data], [1, 2, 3, -3, -2, -1]);
  assert.ok(
    [...result.warnings, ...c.warnings].some((w) => /unit|calibrat/i.test(w)),
  );
});

test("generic calibration is explicitly unverified for an instrument", () => {
  const result = read({});
  assert.ok(
    [...result.warnings, ...result.channels["0"].warnings].some((w) =>
      /unverified|not.*verified|generic/i.test(w),
    ),
  );
});

test("nonfinite float pixels remain available for engine exclusion and warn", () => {
  const result = read({ type: 4, values: [NaN, Infinity, -Infinity, 1, 2, 3] });
  const c = result.channels["0"];
  assert.ok(Number.isNaN(c.data[3]));
  assert.equal(c.data[4], Infinity);
  assert.equal(c.data[5], -Infinity);
  assert.ok(
    [...result.warnings, ...c.warnings].some((w) => /non.?finite/i.test(w)),
  );
});

test("checksum corruption and payload or auxiliary truncation reject", () => {
  const data = fixture();
  const corrupt = Buffer.from(data);
  corrupt[92] ^= 1;
  assert.throws(() => parseIbw(ab(corrupt)), /checksum/i);
  assert.throws(() => parseIbw(ab(data.subarray(0, data.length - 1))));
  const withNote = fixture({ note: "Instrument: generic" });
  assert.throws(() => parseIbw(ab(withNote.subarray(0, withNote.length - 1))));
  const withLabels = fixture({ dims: [3, 2, 1, 0], labels: ["Height"] });
  assert.throws(() =>
    parseIbw(ab(withLabels.subarray(0, withLabels.length - 1))),
  );
});

test("point product mismatch, complex or text waves, and four dimensions reject", () => {
  assert.throws(() => read({ npnts: 7 }));
  assert.throws(() => read({ dims: [3, 3, 0, 0] }));
  assert.throws(() => read({ type: 3 }));
  assert.throws(() => read({ type: 0 }));
  assert.throws(() => read({ dims: [3, 2, 1, 1] }));
});

test("zero, negative or nonfinite lateral pitches and unknown units reject", () => {
  for (const sfA of [
    [0, 3, 1, 1],
    [-2, 3, 1, 1],
    [2, 0, 1, 1],
    [2, -3, 1, 1],
    [NaN, 3, 1, 1],
    [2, Infinity, 1, 1],
  ])
    assert.throws(() => read({ sfA }));
  for (const xyUnit of ["", "foo", "V"]) assert.throws(() => read({ xyUnit }));
});

test("unsupported options and invalid layer label sizes reject", () => {
  for (const offset of [52, 56, 60]) {
    const bytes = mutate(fixture(), (b) => b.writeInt32LE(1, offset));
    assert.throws(() => parseIbw(ab(bytes)));
  }
  const bytes = mutate(
    fixture({ dims: [3, 2, 1, 0], labels: ["Height"] }),
    (b) => b.writeInt32LE(63, 44),
  );
  assert.throws(() => parseIbw(ab(bytes)));
});

test("Asylum channel units follow explicit notes, warn on missing ZSensor, and never use a universal height conversion", () => {
  const input = fixture({
    dims: [3, 2, 3, 0],
    values: Array(18).fill(1),
    unit: "",
    labels: ["HeightTrace", "ZSensorTrace", "UserIn0Trace"],
    note: "UserIn0Unit: V\r",
  });
  const parsed = parseIbw(ab(Buffer.concat([input, Buffer.from("MFP3D")])));
  assert.equal(parsed.support.status, "validated");
  assert.equal(parsed.channels[0].z_unit, "m");
  assert.match(parsed.channels[0].warnings.join(" "), /convention/);
  assert.equal(parsed.channels[1].z_unit, null);
  assert.match(parsed.channels[1].warnings.join(" "), /Unknown vertical unit/);
  assert.equal(parsed.channels[2].z_unit, "V");
  assert.equal(parsed.channels[2].data[0], 1);
});
test("conflicting Asylum unit entries stay unknown instead of falling back to metres", () => {
  const input = fixture({
    dims: [3, 2, 1, 0],
    unit: "",
    labels: ["HeightTrace"],
    note: "HeightUnit: V\rHeightUnit: m\r",
  });
  const c = parseIbw(ab(Buffer.concat([input, Buffer.from("MFP3D")])))
    .channels[0];
  assert.equal(c.z_unit, null);
  assert.match(c.warnings.join(" "), /Ambiguous/);
});
