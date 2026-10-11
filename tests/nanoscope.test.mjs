import test from "node:test";
import assert from "node:assert/strict";
import { parseNanoscope } from "../web/nanoscope.js";
import { detectFormat, parseMeasurement } from "../web/formats.js";

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const near = (a, b) =>
  assert.ok(
    Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-13, 1e-25),
    `${a} != ${b}`,
  );
function fixture(images = [{}], options = {}) {
  const headerLength = options.headerLength ?? 4096;
  const chunks = [];
  let offset = headerLength;
  const sections = images.map((im, index) => {
    const width = im.width ?? 3,
      height = im.height ?? 2,
      stored = im.stored ?? 2,
      values = im.values ?? [-3, -2, -1, 1, 2, 3];
    assert.equal(values.length, width * height);
    const bytes = Buffer.alloc(values.length * stored);
    values.forEach((v, i) =>
      stored === 2
        ? bytes.writeInt16LE(v, i * stored)
        : bytes.writeInt32LE(v, i * stored),
    );
    chunks.push(bytes);
    const entries = [
      ["Data offset", im.offset ?? offset],
      ["Data length", im.length ?? bytes.length],
      ["Data type", im.type ?? "AFM"],
      ["Bytes/pixel", im.declared ?? stored],
      ["Samps/line", width],
      ["Number of lines", height],
      ["Scan Size", im.scan ?? "6 8 um"],
      [
        "@2:Image Data",
        `S [Signal${index}] "${im.title ?? `Signal ${index}`}"`,
      ],
      ["@2:Z scale", im.scale ?? "V (1 nm/LSB) 65536 nm"],
      ...(im.extra ?? []),
    ];
    offset += bytes.length;
    return (
      "\\*Ciao image list\r\n" +
      entries.map(([k, v]) => `\\${k}: ${v}\r\n`).join("")
    );
  });
  const text =
    "\\*File list\r\n" +
    `\\Version: ${options.version ?? "0x09000000"}\r\n\\Data length: ${headerLength}\r\n` +
    "\\*Scanner list\r\n" +
    (options.soft ?? []).map(([k, v]) => `\\@${k}: ${v}\r\n`).join("") +
    sections.join("") +
    "\\*File list end\r\n\x1a";
  const header = Buffer.from(text, "utf8");
  assert.ok(header.length <= headerLength);
  return Buffer.concat([
    header,
    Buffer.alloc(headerLength - header.length),
    ...chunks,
  ]);
}
const read = (images, options) => parseNanoscope(ab(fixture(images, options)));

test("signed little endian 16-bit values flip rows exactly once, never columns", () => {
  const c = read([{ values: [-32768, -2, -1, 1, 2, 32767] }], {
    headerLength: 1024,
  }).channels["0"];
  assert.deepEqual(c.shape, [2, 3]);
  const expected = [1, 2, 32767, -32768, -2, -1];
  c.data.forEach((v, i) => near(v, expected[i] * 1e-9));
  near(c.xreal, 6e-6);
  near(c.yreal, 8e-6);
  assert.equal(c.z_unit, "m");
});

test("signed little endian 32-bit samples use declared 32-bit denominator", () => {
  const counts = [-2147483648, -65536, -1, 1, 65536, 2147483647];
  const c = read([
    { stored: 4, values: counts, scale: "V (1 V/LSB) 4 V", scan: "600 800 nm" },
  ]).channels["0"];
  [1, 65536, 2147483647, -2147483648, -65536, -1].forEach((v, i) =>
    near(c.data[i], (v * 4) / 4294967296),
  );
  near(c.xreal, 600e-9);
  near(c.yreal, 800e-9);
  assert.equal(c.z_unit, "V");
});

test("NanoScope 9 declared16 stored32 retains denominator 65536", () => {
  const c = read([
    {
      stored: 4,
      declared: 2,
      values: [-131072, -65536, -1, 1, 65536, 131072],
      scale: "V (99 V/LSB) 2 V",
    },
  ]).channels["0"];
  [1 / 32768, 2, 4, -4, -2, -1 / 32768].forEach((v, i) => near(c.data[i], v));
  assert.ok(c.warnings.some((w) => w.includes("declared 2-byte")));
  assert.throws(
    () => read([{ stored: 4, declared: 2 }], { version: "0x08000000" }),
    /unvalidated stored\/declared/,
  );
});

test("separate named sensitivity references select correct channel calibration", () => {
  const result = read(
    [
      { scale: "V [Sens. A] (999 V/LSB) 65536 V" },
      { scale: "V [Sens. B] (999 V/LSB) 65536 V" },
    ],
    {
      soft: [
        ["Sens. A", "V 2 nm/V"],
        ["Sens. B", "V 5 nm/V"],
      ],
    },
  );
  near(result.channels["0"].data[0], 2e-9);
  near(result.channels["1"].data[0], 5e-9);
  assert.equal(result.channels["0"].z_unit, "m");
});

test("direct calibrated scale needs no sensitivity and ignores display transforms", () => {
  const c = read([
    {
      scale: "V (9000 nm/LSB) 65536 nm",
      extra: [
        ["@2:Z offset", "V 900 nm"],
        ["Z magnify", 100],
        ["Z offset", 1234],
      ],
    },
  ]).channels["0"];
  near(c.data[0], 1e-9);
  near(c.data[3], -3e-9);
  const details = JSON.parse(c.metadata["Import / count-to-unit calibration"]);
  assert.equal(details.z_offset_applied, false);
});

test("volts, arbitrary and log-arbitrary units remain explicit without exponentiation", () => {
  for (const unit of ["V", "Arb", "log(Arb)"]) {
    const c = read([{ scale: `V (500 ${unit}/LSB) 65536 ${unit}` }]).channels[
      "0"
    ];
    assert.equal(c.z_unit, unit);
    assert.deepEqual([...c.data], [1, 2, 3, -3, -2, -1]);
  }
});

test("valid-data rectangle is translated through vertical row reversal", () => {
  const extra = [
    ["Valid data start X", 1],
    ["Valid data start Y", 0],
    ["Valid data len X", 2],
    ["Valid data len Y", 1],
  ];
  const c = read([{ extra }]).channels["0"];
  assert.deepEqual([...c.mask], [1, 1, 1, 1, 0, 0]);
});

test("missing and incompatible named soft calibration references fail explicitly", () => {
  const image = { scale: "V [Sens. Missing] (1 V/LSB) 65536 V" };
  assert.throws(() => read([image]), /soft scale.*missing/i);
  assert.throws(
    () => read([image], { soft: [["Sens. Missing", "V 2 nm/A"]] }),
    /denominator does not match/,
  );
  assert.throws(() => read([{ scale: "V (1 V/LSB) 65536" }]), /unit|calibrat/i);
});

test("unitless sensitivity retains explicit electrical or arbitrary units with warning", () => {
  for (const unit of ["V", "Arb", "log(Arb)"]) {
    const result = read(
      [{ scale: `V [Sens. Count] (1 ${unit}/LSB) 65536 ${unit}` }],
      { soft: [["Sens. Count", "V 2"]] },
    );
    const c = result.channels["0"];
    assert.equal(c.z_unit, unit);
    assert.deepEqual([...c.data], [2, 4, 6, -6, -4, -2]);
    assert.ok(c.warnings.some((w) => w.includes("Sensitivity has no unit")));
  }
});

test("partially unsupported images preserve original IDs and report omission", () => {
  const result = read([{ type: "Force" }, { title: "Accepted" }]);
  assert.deepEqual(Object.keys(result.channels), ["1"]);
  assert.equal(result.channels["1"].title, "Accepted");
  assert.equal(result.unsupported_channels[0].id, "0");
  assert.ok(result.warnings.length);
  assert.match(result.unsupported_channels[0].reason, /only AFM raster/);
});

test("duplicate fields and overlapping or truncated ranges reject entire import", () => {
  assert.throws(
    () => read([{ extra: [["Samps/line", 3]] }]),
    /duplicate header/,
  );
  assert.throws(() => read([{}, { offset: 4096 }]), /overlapping/);
  assert.throws(() => read([{ offset: 4095 }]), /offset/);
  const bytes = fixture();
  assert.throws(
    () => parseNanoscope(ab(bytes.subarray(0, bytes.length - 1))),
    /truncated/,
  );
  assert.throws(() => read([{ length: 999 }]), /truncated/);
});

test("required complete header, Ctrl-Z and spatial calibration are validated", () => {
  const bytes = fixture();
  const noEnd = Buffer.from(bytes);
  noEnd[noEnd.indexOf(26)] = 32;
  assert.throws(() => parseNanoscope(ab(noEnd)), /terminator/);
  assert.throws(() => read([{ scan: "6 um" }]), /X and Y extents/);
  assert.throws(() => read([{ scan: "6 8 V" }]), /length units/);
  const noMarker = Buffer.from(bytes);
  const at = noMarker.indexOf("\\*File list end");
  noMarker.write("\\*Other section", at);
  assert.throws(() => parseNanoscope(ab(noMarker)), /file-list header/);
});

test("byte detection needs no extension and gives clear unsupported-format errors", () => {
  const bytes = ab(fixture());
  assert.equal(detectFormat(bytes), "NANOSCOPE");
  assert.equal(parseMeasurement(bytes).format, "NANOSCOPE");
  for (const [magic, format, message] of [
    [[5, 0, 0, 0], "IGOR_IBW", /Igor Binary Wave/],
    [[0, 5, 0, 0], "IGOR_IBW", /Igor Binary Wave/],
    [[73, 73, 42, 0], "TIFF", /TIFF\/JPK/],
    [[77, 77, 0, 42], "TIFF", /TIFF\/JPK/],
    [[71, 87, 89, 79], "GWYO", /Legacy Gwyddion/],
    [[0, 1, 2, 3], "UNKNOWN", /not supported yet/],
  ]) {
    const source = Uint8Array.from(magic).buffer;
    assert.equal(detectFormat(source), format);
    assert.throws(() => parseMeasurement(source), message);
  }
});
