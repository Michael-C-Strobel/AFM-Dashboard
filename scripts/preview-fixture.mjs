/** Generated mathematical demonstration; never reads or writes measurement files. */
import { Buffer } from "node:buffer";
export const PREVIEW_EXAMPLE = Object.freeze({
  file: "synthetic-step.gwy",
  channel: "0",
  shape: Object.freeze([16, 16]),
  xreal: 8e-6,
  yreal: 8e-6,
  mean: 25e-9,
  min: 0,
  max: 50e-9,
  area: 64e-12,
});
export function createPreviewFixture() {
  const string = (value) => Buffer.from(value + "\0", "utf8");
  const integer = (value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  };
  const double = (value) => {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleLE(value);
    return bytes;
  };
  const item = (name, type, value) =>
    Buffer.concat([string(name), Buffer.from(type, "ascii"), value]);
  const object = (name, fields) => {
    const bytes = Buffer.concat(fields);
    return Buffer.concat([string(name), integer(bytes.length), bytes]);
  };
  const samples = Buffer.alloc(16 * 16 * 8);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      samples.writeDoubleLE(
        1e-9 * (x + 2 * y + (x >= 8 ? 5 : 0)),
        8 * (y * 16 + x),
      );
  const unit = () => object("GwySIUnit", [item("unitstr", "s", string("m"))]);
  const field = object("GwyDataField", [
    item("xres", "i", integer(16)),
    item("yres", "i", integer(16)),
    item("xreal", "d", double(8e-6)),
    item("yreal", "d", double(8e-6)),
    item("xoff", "d", double(0)),
    item("yoff", "d", double(0)),
    item("si_unit_xy", "o", unit()),
    item("si_unit_z", "o", unit()),
    item("data", "D", Buffer.concat([integer(256), samples])),
  ]);
  return Buffer.concat([
    Buffer.from("GWYP", "ascii"),
    object("GwyContainer", [
      item("/0/data", "o", field),
      item("/0/data/title", "s", string("Synthetic height")),
      item(
        "/0/meta",
        "o",
        object("GwyContainer", [
          item(
            "Provenance",
            "s",
            string(
              "Generated mathematical demonstration; not an instrument acquisition.",
            ),
          ),
        ]),
      ),
    ]),
  ]);
}
