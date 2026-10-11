import test from "node:test";
import assert from "node:assert/strict";
import { parseGwy, summarizeChannel } from "../web/gwy.js";

const str = (v) =>
  Buffer.concat([Buffer.isBuffer(v) ? v : Buffer.from(v), Buffer.from([0])]);
const uint = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
function item(key, type, value) {
  let payload;
  if (type === "s") payload = str(value);
  else if (type === "o") payload = value;
  else if (type === "D") {
    const b = Buffer.alloc(8 * value.length);
    value.forEach((v, i) => b.writeDoubleLE(v, i * 8));
    payload = Buffer.concat([uint(value.length), b]);
  } else if (type === "S")
    payload = Buffer.concat([uint(value.length), ...value.map(str)]);
  else {
    payload = Buffer.alloc(type === "d" ? 8 : 4);
    type === "d" ? payload.writeDoubleLE(value) : payload.writeInt32LE(value);
  }
  return Buffer.concat([str(key), Buffer.from(type), payload]);
}
function object(type, ...items) {
  const content = Buffer.concat(items);
  return Buffer.concat([str(type), uint(content.length), content]);
}
function field({
  width = 3,
  height = 2,
  values = [0, 1, 2, 3, 4, 5],
  units = true,
  xreal = 6e-6,
} = {}) {
  const parts = [
    item("xres", "i", width),
    item("yres", "i", height),
    item("xreal", "d", xreal),
    item("yreal", "d", 8e-6),
    item("xoff", "d", 1e-6),
    item("yoff", "d", -2e-6),
    item("data", "D", values),
  ];
  if (units)
    for (const key of ["si_unit_xy", "si_unit_z"])
      parts.push(
        item(key, "o", object("GwySIUnit", item("unitstr", "s", "m"))),
      );
  return object("GwyDataField", ...parts);
}
function fixture(data = field(), extra = []) {
  return Buffer.concat([
    Buffer.from("GWYP"),
    object("GwyContainer", item("/7/data", "o", data), ...extra),
  ]);
}
function parse(bytes) {
  return parseGwy(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

test("non-square data retains orientation, calibration and offsets", () => {
  const channel = parse(fixture()).channels["7"];
  assert.deepEqual(channel.shape, [2, 3]);
  assert.deepEqual([...channel.data], [0, 1, 2, 3, 4, 5]);
  assert.equal(channel.width, 3);
  assert.equal(channel.height, 2);
  assert.equal(channel.xreal / channel.width, 2e-6);
  assert.equal(channel.yreal / channel.height, 4e-6);
  assert.equal(channel.xoff, 1e-6);
  assert.equal(channel.yoff, -2e-6);
  assert.equal(channel.z_unit, "m");
  assert.equal(summarizeChannel(channel).max, 5);
});

test("missing units remain unknown with warning", () => {
  const channel = parse(fixture(field({ units: false }))).channels["7"];
  assert.equal(channel.xy_unit, null);
  assert.equal(channel.z_unit, null);
  assert.ok(channel.warnings.length);
});

test("metadata, logs, masks and selected points survive import", () => {
  const result = parse(
    fixture(field(), [
      item(
        "/7/meta",
        "o",
        object("GwyContainer", item("mode", "s", "Tapping")),
      ),
      item(
        "/7/data/log",
        "o",
        object("GwyStringList", item("strings", "S", ["proc::fix_zero()"])),
      ),
      item("/7/mask", "o", field({ values: [0, 1, 0, -2, 0, 0] })),
      item(
        "/7/select/point",
        "o",
        object(
          "GwySelectionPoint",
          item("max", "i", 3),
          item("data", "D", [1e-6, 2e-6]),
        ),
      ),
      item("/7/base/palette", "s", "Gold"),
    ]),
  );
  const channel = result.channels["7"];
  assert.deepEqual(channel.metadata, { mode: "Tapping" });
  assert.deepEqual(channel.log, ["proc::fix_zero()"]);
  assert.deepEqual([...channel.mask], [0, 1, 0, 1, 0, 0]);
  assert.equal(summarizeChannel(channel).mask_count, 2);
  assert.deepEqual(channel.selections.point, {
    type: "GwySelectionPoint",
    max: 3,
    data: [1e-6, 2e-6],
  });
  assert.deepEqual(result.unsupported, ["/7/base/palette"]);
});

test("invalid text bytes are visible with warning", () => {
  const result = parse(
    fixture(field(), [
      item(
        "/7/meta",
        "o",
        object("GwyContainer", item("phase", "s", Buffer.from([56, 0xb0]))),
      ),
    ]),
  );
  assert.equal(result.channels["7"].metadata.phase, "8\\xb0");
  assert.ok(result.warnings.length);
  assert.ok(result.channels["7"].warnings.length);
});

test("nonfinite image pixels are counted and warned about", () => {
  const ch = parse(fixture(field({ values: [NaN, Infinity, 1, 2, 3, 4] })))
    .channels["7"];
  assert.equal(summarizeChannel(ch).finite_count, 4);
  assert.equal(summarizeChannel(ch).min, 1);
  assert.ok(ch.warnings.length);
});

test("truncation, trailing bytes, legacy headers and absent images reject", () => {
  const source = fixture();
  for (const count of [0, 3, 8, 20, source.length - 1])
    assert.throws(() => parse(source.subarray(0, count)));
  assert.throws(() => parse(Buffer.concat([source, Buffer.from("extra")])));
  assert.throws(() =>
    parse(Buffer.concat([Buffer.from("GWYO"), source.subarray(4)])),
  );
  assert.throws(() =>
    parse(Buffer.concat([Buffer.from("GWYP"), object("GwyContainer")])),
  );
  assert.throws(() => parseGwy(source), TypeError);
});

test("malformed shapes, calibration and masks reject", () => {
  for (const options of [
    { width: 0 },
    { width: 4 },
    { xreal: NaN },
    { xreal: -1 },
  ])
    assert.throws(() => parse(fixture(field(options))));
  assert.throws(() =>
    parse(
      fixture(field(), [item("/7/mask", "o", field({ width: 2, height: 3 }))]),
    ),
  );
  assert.throws(() =>
    parse(
      fixture(field(), [
        item("/7/mask", "o", field({ values: [0, 0, 0, 0, 0, NaN] })),
      ]),
    ),
  );
});

test("unknown type, enormous array, duplicate keys and nesting reject", () => {
  for (const payload of [
    Buffer.from("x\0Z"),
    Buffer.concat([Buffer.from("x\0D"), uint(0xffffffff)]),
  ]) {
    assert.throws(() =>
      parse(
        Buffer.concat([Buffer.from("GWYP"), object("GwyContainer", payload)]),
      ),
    );
  }
  assert.throws(() => parse(fixture(field(), [item("/7/data", "o", field())])));
  let obj = object("Deep");
  for (let n = 0; n < 66; n++) obj = object("Deep", item("child", "o", obj));
  assert.throws(() => parse(fixture(field(), [item("nested", "o", obj)])));
});

test("reserved JavaScript names cannot modify prototypes", () => {
  const channel = parse(
    fixture(field(), [
      item(
        "/7/meta",
        "o",
        object("GwyContainer", item("__proto__", "s", "safe")),
      ),
    ]),
  ).channels["7"];
  assert.equal(Object.getPrototypeOf(channel.metadata), Object.prototype);
  assert.equal(
    Object.getOwnPropertyDescriptor(channel.metadata, "__proto__").value,
    "safe",
  );
  assert.equal({}.polluted, undefined);
});
