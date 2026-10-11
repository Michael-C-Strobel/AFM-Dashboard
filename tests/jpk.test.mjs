import test from "node:test";
import assert from "node:assert/strict";
import { parseJpk } from "../web/jpk.js";

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const near = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.max(Math.abs(expected) * 1e-12, 1e-25),
    `${actual} != ${expected}`,
  );
const sizes = { 2: 1, 3: 2, 4: 4, 8: 2, 9: 4, 12: 8 };
const entry = (tag, type, values) => ({
  tag,
  type,
  values: type === 2 ? values : Array.isArray(values) ? values : [values],
});

/** Independently construct a classic TIFF: IFD tables first, strips and values after. */
function fixture(images = [{}], options = {}) {
  const endian = options.endian ?? "LE",
    buffer = Buffer.alloc(65536),
    positions = new Map(),
    strips = [];
  let cursor = 8194;
  const u16 = (value, at) => buffer[`writeUInt16${endian}`](value, at);
  const u32 = (value, at) => buffer[`writeUInt32${endian}`](value, at);
  const globals = [
    entry(256, 4, 1),
    entry(257, 4, 1),
    entry(258, 3, 16),
    entry(259, 3, 1),
    entry(262, 3, 1),
    entry(273, 4, 8192),
    entry(277, 3, 1),
    entry(278, 4, 1),
    entry(279, 4, 2),
    entry(0x8000, 2, options.software ?? "JPK SPM Control"),
    entry(0x8030, 2, options.mode ?? "Image"),
    entry(0x8050, 2, "thumbnail"),
    entry(0x8042, 12, options.xreal ?? 6e-6),
    entry(0x8043, 12, options.yreal ?? 9e-6),
    entry(0x8046, 9, options.width ?? 3),
    entry(0x8047, 9, options.height ?? 3),
    entry(0x804b, 2, "bottomUp"),
    entry(0x8045, 8, 0),
    entry(0x8040, 12, 2e-6),
    entry(0x8041, 12, -3e-6),
    entry(0x8044, 12, 20),
  ];
  if (options.noJpk) globals.splice(2);
  if (options.duplicate) globals.push(entry(0x8042, 12, 6e-6));
  const tables = [globals];
  images.forEach((image, index) => {
    const width = image.width ?? 3,
      height = image.height ?? 3,
      bits = image.bits ?? 16,
      signed = image.signed ?? true,
      rows = image.rows ?? 2;
    const values = image.values ?? [-3, -2, -1, 0, 1, 2, 3, 4, 5];
    assert.equal(values.length, width * height);
    const offsets = [],
      counts = [],
      ranges = [];
    for (let row = 0; row < height; row += rows) {
      const length = (Math.min(rows, height - row) * width * bits) / 8;
      offsets.push(cursor);
      counts.push(length);
      ranges.push([cursor, length]);
      for (let i = 0; i < length / (bits / 8); i++)
        buffer[`write${signed ? "Int" : "UInt"}${bits}${endian}`](
          values[row * width + i],
          cursor + (i * bits) / 8,
        );
      cursor += length;
    }
    strips.push(ranges);
    const slots = image.slots ?? [
      {
        name: "raw",
        unit: "V",
        multiply: 2,
        offset: 1,
        scaling: "NullScaling",
      },
      {
        name: "calibrated",
        unit: image.unit ?? "m",
        multiply: image.multiply ?? 3,
        offset: image.offset ?? -1,
        parent: "raw",
      },
      { name: "unused", unit: "deg", multiply: 999, offset: 999 },
    ];
    const tags = [
      entry(256, 4, width),
      entry(257, 4, height),
      entry(258, 3, bits),
      entry(259, 3, image.compression ?? 1),
      entry(262, 3, 1),
      entry(273, 4, offsets),
      entry(277, 3, 1),
      entry(278, 4, rows),
      entry(279, 4, counts),
      entry(339, 3, signed ? 2 : 1),
      entry(274, 3, image.orientation ?? 1),
      entry(0x8050, 2, image.name ?? `Height ${index}`),
      entry(0x8051, 8, image.retrace ?? 0),
      entry(0x8080, 9, slots.length),
      entry(0x8081, 2, image.defaultSlot ?? "calibrated"),
    ];
    slots.forEach((slot, i) => {
      const base = 0x8090 + 0x30 * i;
      tags.push(
        entry(base, 2, slot.name),
        entry(
          base + 1,
          2,
          slot.parent ? "RelativeCalibration" : "AbsoluteCalibration",
        ),
        entry(base + 0x11, 2, signed ? "SignedInteger" : "UnsignedInteger"),
        entry(base + 0x13, 2, slot.scaling ?? image.scaling ?? "LinearScaling"),
      );
      if (slot.parent) tags.push(entry(base + 2, 2, slot.parent));
      if (slot.unit !== null) tags.push(entry(base + 0x12, 2, slot.unit ?? ""));
      tags.push(
        entry(base + 0x14, 12, slot.multiply ?? 1),
        entry(base + 0x15, 12, slot.offset ?? 0),
      );
    });
    tables.push(tags);
  });
  buffer.write(endian === "LE" ? "II" : "MM", 0);
  u16(42, 2);
  u32(8, 4);
  const ifds = [];
  let start = 8;
  for (const tags of tables) {
    ifds.push(start);
    start += 2 + tags.length * 12 + 4;
  }
  assert.ok(start < 8192);
  tables.forEach((tags, index) => {
    const sorted = tags.sort((a, b) => a.tag - b.tag),
      at = ifds[index];
    u16(sorted.length, at);
    sorted.forEach((tag, j) => {
      const pos = at + 2 + j * 12;
      positions.set(`${index}:${tag.tag}`, pos);
      u16(tag.tag, pos);
      u16(tag.type, pos + 2);
      const count =
        tag.type === 2 ? Buffer.byteLength(tag.values) + 1 : tag.values.length;
      u32(count, pos + 4);
      const length = count * sizes[tag.type];
      let target = pos + 8;
      if (length > 4) {
        target = cursor;
        u32(target, pos + 8);
        cursor += length;
      }
      if (tag.type === 2) buffer.write(tag.values + "\0", target, "utf8");
      else
        tag.values.forEach((value, k) => {
          const methods = {
            3: "UInt16",
            4: "UInt32",
            8: "Int16",
            9: "Int32",
            12: "Double",
          };
          buffer[`write${methods[tag.type]}${endian}`](
            value,
            target + k * sizes[tag.type],
          );
        });
    });
    u32(ifds[index + 1] ?? 0, at + 2 + tags.length * 12);
  });
  return {
    buffer: buffer.subarray(0, cursor),
    positions,
    strips,
    ifds,
    endian,
    tables,
  };
}
const parse = (f) => parseJpk(ab(f.buffer));
function patch(f, index, tag, value, item = 0) {
  const pos = f.positions.get(`${index}:${tag}`),
    count = f.buffer[`readUInt32${f.endian}`](pos + 4),
    type = f.buffer[`readUInt16${f.endian}`](pos + 2);
  const at =
    count * sizes[type] > 4
      ? f.buffer[`readUInt32${f.endian}`](pos + 8)
      : pos + 8;
  f.buffer[
    `write${{ 3: "UInt16", 4: "UInt32", 8: "Int16", 9: "Int32", 12: "Double" }[type]}${f.endian}`
  ](value, at + item * sizes[type]);
  return f;
}

for (const endian of ["LE", "BE"]) {
  test(`${endian} signed16 and signed32 apply default scale once with one Y flip`, () => {
    for (const bits of [16, 32]) {
      const c = parse(fixture([{ bits }], { endian })).channels["0"];
      assert.deepEqual(c.shape, [3, 3]);
      assert.equal(c.z_unit, "m");
      assert.deepEqual([...c.data], [8, 11, 14, -1, 2, 5, -10, -7, -4]);
      near(c.xreal, 6e-6);
      near(c.yreal, 9e-6);
    }
  });
  test(`${endian} unsigned16 and unsigned32 preserve high-bit counts`, () => {
    for (const [bits, max] of [
      [16, 65535],
      [32, 4294967295],
    ]) {
      const c = parse(
        fixture(
          [
            {
              bits,
              signed: false,
              values: [0, 1, 2, 3, 4, 5, 6, 7, max],
              multiply: 1,
              offset: 0,
              unit: "V",
            },
          ],
          { endian },
        ),
      ).channels["0"];
      assert.deepEqual([...c.data], [6, 7, max, 3, 4, 5, 0, 1, 2]);
      assert.equal(c.z_unit, "V");
    }
  });
}

test("non-square strips include final partial block and use global extent, not thumbnail", () => {
  const c = parse(
    fixture(
      [
        {
          width: 3,
          height: 5,
          rows: 2,
          values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
          multiply: 1,
          offset: 0,
        },
      ],
      { height: 5 },
    ),
  ).channels["0"];
  assert.deepEqual(c.shape, [5, 3]);
  assert.deepEqual(
    [...c.data],
    [12, 13, 14, 9, 10, 11, 6, 7, 8, 3, 4, 5, 0, 1, 2],
  );
  near(c.xreal, 6e-6);
  near(c.yreal, 9e-6);
});

test("explicit default slot wins over highest index and parent scaling is provenance only", () => {
  const c = parse(fixture([{ multiply: 3, offset: -1 }])).channels["0"];
  assert.equal(c.data[0], 8); // raw 3 * default 3 - 1; NOT parent composition or slot 2.
  assert.equal(c.z_unit, "m");
  for (const unit of ["m", "V", "deg"])
    assert.equal(parse(fixture([{ unit }])).channels["0"].z_unit, unit);
});

test("unknown software/mode and missing or unknown units warn without fabricating units", () => {
  for (const unit of [null, "furlongs"]) {
    const f = fixture(
      [{ slots: [{ name: "calibrated", unit, multiply: 1, offset: 0 }] }],
      { software: "Unverified software", mode: "UnknownMode" },
    );
    const result = parse(f),
      c = result.channels["0"];
    assert.equal(c.z_unit, unit);
    assert.ok([...result.warnings, ...c.warnings].some((w) => /unit/i.test(w)));
    assert.ok(
      [...result.warnings, ...c.warnings].some((w) =>
        /mode|software|unverified|unknown/i.test(w),
      ),
    );
  }
});

test("unsupported compression or scaling omits individual channels with stable IDs", () => {
  for (const bad of [{ compression: 5 }, { scaling: "PolynomialScaling" }]) {
    const result = parse(fixture([bad, { name: "Accepted" }]));
    assert.deepEqual(Object.keys(result.channels), ["1"]);
    assert.ok(result.warnings.length || result.unsupported.length);
    assert.throws(() => parse(fixture([bad])));
  }
});

test("plain TIFF, cyclic IFDs and duplicate tags fail explicitly", () => {
  assert.throws(() => parse(fixture([], { noJpk: true })));
  const f = fixture();
  const last = f.ifds[1] + 2 + f.tables[1].length * 12;
  f.buffer.writeUInt32LE(f.ifds[0], last);
  assert.throws(() => parse(f));
  assert.throws(() => parse(fixture([], { duplicate: true })));
});

test("truncated file, out-of-range strip offset and mismatched byte counts reject", () => {
  const f = fixture();
  assert.throws(() => parseJpk(ab(f.buffer.subarray(0, 100))));
  assert.throws(() => parse(patch(fixture(), 1, 273, 65530)));
  assert.throws(() => parse(patch(fixture(), 1, 279, 1)));
  const truncated = fixture();
  assert.throws(() =>
    parseJpk(ab(truncated.buffer.subarray(0, truncated.buffer.length - 1))),
  );
});

test("overlapping strip ranges are rejected", () => {
  const f = fixture();
  patch(f, 1, 273, f.strips[0][0][0], 1);
  assert.throws(() => parse(f));
});

test("non-positive extents, dimension mismatch and unsupported orientation reject", () => {
  for (const xreal of [0, -1, NaN])
    assert.throws(() => parse(fixture([{}], { xreal })));
  assert.throws(() => parse(fixture([{}], { width: 4 })));
  assert.throws(() => parse(fixture([{ orientation: 3 }])));
});
