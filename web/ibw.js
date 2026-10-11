/** Independent Igor Binary Wave v5 raster reader. See docs/ibw-support.md. */
const MAX_BYTES = 512 * 1024 * 1024;
const TYPES = new Map([
  [2, [4, "getFloat32"]],
  [4, [8, "getFloat64"]],
  [8, [1, "getInt8"]],
  [16, [2, "getInt16"]],
  [32, [4, "getInt32"]],
  [72, [1, "getUint8"]],
  [80, [2, "getUint16"]],
  [96, [4, "getUint32"]],
]);
const LENGTHS = new Map([
  ["m", 1],
  ["cm", 1e-2],
  ["mm", 1e-3],
  ["um", 1e-6],
  ["µm", 1e-6],
  ["μm", 1e-6],
  ["nm", 1e-9],
  ["pm", 1e-12],
]);
function fail(message) {
  throw new Error(`Igor Binary Wave: ${message}`);
}
export function parseIbw(buffer) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength < 384 ||
    buffer.byteLength > MAX_BYTES
  )
    fail("truncated or oversized v5 header/file");
  const view = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  const little = view.getUint16(0, true) === 5;
  if (!little && view.getUint16(0, false) !== 5)
    fail("only version 5 image waves are supported");
  const i32 = (at) => view.getInt32(at, little),
    f64 = (at) => view.getFloat64(at, little);
  let checksum = 0;
  for (let i = 0; i < 384; i += 2)
    checksum = (checksum + view.getUint16(i, little)) & 65535;
  if (checksum) fail("invalid header checksum");
  const warnings = [],
    unsupported = [];
  let fallbackEncoding = false;
  const text = (at, length) => {
    let value = bytes.subarray(at, at + length);
    const end = value.indexOf(0);
    if (end >= 0) value = value.subarray(0, end);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      fallbackEncoding = true;
      return new TextDecoder("windows-1252").decode(value);
    }
  };
  const sizes = Array.from({ length: 15 }, (_, i) => i32(4 + i * 4));
  if (sizes.some((n) => n < 0)) fail("negative auxiliary section size");
  if (i32(52) || i32(56) || i32(60))
    fail("string indices or extended options are unsupported");
  const type = view.getUint16(80, little),
    storage = TYPES.get(type);
  if (!storage)
    fail(
      "unsupported numeric type: text, complex, and unknown types are not image rasters",
    );
  const dims = Array.from({ length: 4 }, (_, i) => i32(132 + 4 * i));
  if (dims[0] < 1 || dims[1] < 1 || dims[2] < 0 || dims[3] !== 0)
    fail("requires a 2D image or 3D channel stack; 4D waves are unsupported");
  const [width, height] = dims,
    layers = dims[2] || 1,
    pixels = width * height,
    count = pixels * layers;
  if (
    layers > 256 ||
    !Number.isSafeInteger(count) ||
    count > MAX_BYTES / 8 ||
    i32(76) !== count
  )
    fail("invalid dimensions, point count, or decoded size limit");
  if (i32(4) !== 320 + count * storage[0])
    fail("payload size does not match dimensions and numeric type");
  let cursor = 64 + i32(4);
  if (cursor > buffer.byteLength) fail("truncated numeric payload");
  const section = (length) => {
    const start = cursor;
    cursor += length;
    if (!Number.isSafeInteger(cursor) || cursor > buffer.byteLength)
      fail("truncated auxiliary section");
    return { start, length };
  };
  const formula = section(i32(8)),
    noteBlock = section(i32(12)),
    dataUnitBlock = section(i32(16));
  const dimensionUnits = Array.from({ length: 4 }, (_, i) =>
    section(i32(20 + 4 * i)),
  );
  const labels = Array.from({ length: 4 }, (_, i) => section(i32(36 + 4 * i)));
  for (let i = 0; i < 4; i++)
    if (
      labels[i].length &&
      (labels[i].length % 32 !== 0 || labels[i].length > (dims[i] + 1) * 32)
    )
      fail("invalid dimension label size");
  const note = text(noteBlock.start, noteBlock.length),
    noteValues = new Map();
  for (const line of note.split(/\r\n|\r|\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim(),
      v = line.slice(colon + 1).trim();
    if (!noteValues.has(k)) noteValues.set(k, []);
    noteValues.get(k).push(v);
  }
  const uniqueNote = (key) => {
    const v = [...new Set(noteValues.get(key) || [])];
    return v.length === 1 ? v[0] : null;
  };
  const asylum = /MFP3D\s*$/.test(
    text(
      Math.max(cursor, bytes.length - 16),
      Math.min(16, bytes.length - cursor),
    ),
  );
  const sfA = Array.from({ length: 4 }, (_, i) => f64(148 + 8 * i)),
    sfB = Array.from({ length: 4 }, (_, i) => f64(180 + 8 * i));
  const dimUnit = dimensionUnits.map((s, i) =>
    s.length ? text(s.start, s.length) : text(216 + i * 4, 4),
  );
  const step = [0, 1].map((i) => sfA[i] * LENGTHS.get(dimUnit[i]));
  if (
    !step.every((n) => Number.isFinite(n) && n > 0) ||
    !sfB.slice(0, 2).every(Number.isFinite)
  )
    fail(
      "requires positive finite spatial scales and explicit supported length units",
    );
  const xreal = width * step[0],
    yreal = height * step[1];
  if (!Number.isFinite(xreal) || !Number.isFinite(yreal))
    fail("nonfinite spatial extent");
  const dataUnit = dataUnitBlock.length
      ? text(dataUnitBlock.start, dataUnitBlock.length)
      : text(212, 4),
    name = text(92, 32);
  if (formula.length)
    unsupported.push("Dependency formula retained as metadata; never executed");
  if (cursor < bytes.length)
    unsupported.push(
      `${bytes.length - cursor} trailing bytes (including any instrument thumbnails) not interpreted`,
    );
  const nominal = [uniqueNote("FastScanSize"), uniqueNote("SlowScanSize")].map(
    (value) => (value === null ? NaN : Number(value)),
  );
  if (
    asylum &&
    nominal.some(
      (value, i) =>
        Number.isFinite(value) &&
        value > 0 &&
        Math.abs(value - [xreal, yreal][i]) > Math.abs(value) * 1e-9,
    )
  )
    warnings.push(
      "Header pixel pitch is preserved. Nominal note scan size differs from the full pixel-cell extent; see sfA and scan-size metadata.",
    );
  const channels = Object.create(null);
  for (let layer = 0; layer < layers; layer++) {
    const label =
      labels[2].length >= (layer + 2) * 32
        ? text(labels[2].start + (layer + 1) * 32, 32)
        : "";
    const title =
      label || (layers === 1 ? name : `Layer ${layer}`) || `Layer ${layer}`;
    const notes = [
      "Image-local coordinates: stored Y rows reversed once; stage offsets/rotation and Igor coordinate origins remain metadata. Header sfA determines pixel pitch; no display plane or data scale is applied.",
    ];
    let unit = dataUnit,
      unitSource = dataUnit ? "Igor data units" : "not specified";
    if (!unit && asylum) {
      const family = title.replace(/(?:Retrace|Trace)(?:Mod\d+)?$/, "");
      const explicit = uniqueNote(family + "Unit");
      if (explicit) {
        unit = explicit;
        unitSource = `Asylum note ${family}Unit`;
      } else if (noteValues.has(family + "Unit")) {
        notes.push(
          "Ambiguous channel unit entries; no fallback unit is assigned.",
        );
      } else if (family === "Height") {
        unit = "m";
        unitSource = "Asylum MFP-3D Height convention";
        notes.push(
          "Height unit m follows the supported Asylum MFP-3D Height convention; this file omits global data units.",
        );
      }
    }
    let factor = 1;
    if (LENGTHS.has(unit)) {
      factor = LENGTHS.get(unit);
      unit = "m";
    }
    if (!unit) {
      unit = null;
      notes.push(
        `Unknown vertical unit for ${title}: stored values retained; physical height/force/modulus interpretation is unsupported.`,
      );
    }
    const data = new Float64Array(pixels);
    let nonfinite = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const index = layer * pixels + (height - 1 - y) * width + x;
        const value =
          view[storage[1]](384 + index * storage[0], little) * factor;
        data[y * width + x] = value;
        if (!Number.isFinite(value)) nonfinite++;
      }
    if (nonfinite)
      notes.push(
        `${nonfinite} nonfinite samples retained for exclusion by analysis.`,
      );
    const metadata = {
      "Import / reader": "Igor Binary Wave v5 raster adapter 1",
      "Import / instrument": asylum
        ? "Asylum Research MFP-3D (footer)"
        : "Unidentified",
      "Igor / version": "5",
      "Igor / byte order": little ? "little-endian" : "big-endian",
      "Igor / numeric type": String(type),
      "Igor / wave name": name,
      "Igor / dimensions": JSON.stringify(dims),
      "Igor / sfA": JSON.stringify(sfA),
      "Igor / sfB": JSON.stringify(sfB),
      "Igor / dimension units": JSON.stringify(dimUnit),
      "Igor / data units": dataUnit,
      "Igor / note": note,
      "Igor / formula": text(formula.start, formula.length),
      "Import / vertical unit source": unitSource,
      "Import / coordinate mapping":
        "x = (i+0.5)*abs(sfA[0]); y = (height-0.5-j)*abs(sfA[1]); original Igor coordinates = sfA*index+sfB. Image-local cell bounds.",
      "Import / trailing bytes": String(bytes.length - cursor),
    };
    channels[String(layer)] = {
      id: String(layer),
      title,
      width,
      height,
      shape: [height, width],
      xreal,
      yreal,
      xoff: 0,
      yoff: 0,
      xy_unit: "m",
      z_unit: unit,
      data,
      mask: null,
      metadata,
      log: [],
      selections: {},
      warnings: notes,
    };
  }
  if (fallbackEncoding)
    warnings.push(
      "Some text required Windows-1252 decoding; original bytes remain in the source.",
    );
  const validated = asylum && little && type === 2 && dims[2] > 0;
  const support = {
    status: validated ? "validated" : "unverified",
    format: "IGOR_IBW",
    configuration: asylum
      ? "Asylum MFP-3D / IBW v5 image stack"
      : "Igor v5 calibrated image / unidentified instrument",
    message: validated
      ? "Supported Asylum MFP-3D float32 image subset. Channel-specific unit warnings still apply."
      : "Unverified instrument/configuration. Only explicit Igor array and spatial calibration fields are interpreted; review before quantitative use.",
  };
  if (!validated) warnings.push(support.message);
  return { format: "IGOR_IBW", channels, warnings, unsupported, support };
}
