/** Native NanoScope binary raster adapter. Independent implementation.
 * Calibration model: Bruker NanoScope 8.15 manual, Height Image Data Interpretation.
 * Supported subset and independent validation: docs/nanoscope-support.md.
 */
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_HEADER = 4 * 1024 * 1024;
const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const units = new Map([
  ["m", [1, "m"]],
  ["cm", [1e-2, "m"]],
  ["mm", [1e-3, "m"]],
  ["um", [1e-6, "m"]],
  ["µm", [1e-6, "m"]],
  ["μm", [1e-6, "m"]],
  ["nm", [1e-9, "m"]],
  ["pm", [1e-12, "m"]],
  ["Å", [1e-10, "m"]],
  ["V", [1, "V"]],
  ["mV", [1e-3, "V"]],
  ["uV", [1e-6, "V"]],
  ["A", [1, "A"]],
  ["mA", [1e-3, "A"]],
  ["uA", [1e-6, "A"]],
  ["nA", [1e-9, "A"]],
  ["pA", [1e-12, "A"]],
  ["N", [1, "N"]],
  ["mN", [1e-3, "N"]],
  ["uN", [1e-6, "N"]],
  ["nN", [1e-9, "N"]],
  ["pN", [1e-12, "N"]],
  ["Pa", [1, "Pa"]],
  ["kPa", [1e3, "Pa"]],
  ["MPa", [1e6, "Pa"]],
  ["GPa", [1e9, "Pa"]],
  ["Hz", [1, "Hz"]],
  ["kHz", [1e3, "Hz"]],
  ["MHz", [1e6, "Hz"]],
  ["deg", [1, "deg"]],
  ["°", [1, "deg"]],
  ["º", [1, "deg"]],
  ["rad", [1, "rad"]],
  ["Arb", [1, "Arb"]],
  ["log(Arb)", [1, "log(Arb)"]],
  ["1", [1, "1"]],
]);
function error(message) {
  throw new Error(`NanoScope: ${message}`);
}
function scalar(text, label) {
  const match = new RegExp(`^\\s*(${NUMBER})\\s*(.*?)\\s*$`).exec(text ?? "");
  if (!match || !Number.isFinite(Number(match[1]))) error(`invalid ${label}`);
  return { value: Number(match[1]), unit: match[2] };
}
function integer(text, label, min = 0) {
  if (!/^\d+$/.test(text ?? "")) error(`invalid ${label}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min) error(`invalid ${label}`);
  return value;
}
function baseUnit(text) {
  const normalized = text.replaceAll("μ", "µ");
  const result = units.get(normalized) ?? units.get(text);
  if (!result)
    error(
      `unsupported unit ${JSON.stringify(text)}; calibration cannot be inferred`,
    );
  return { factor: result[0], unit: result[1] };
}
function parseValue(text, label) {
  if (!/^V\s/.test(text ?? "")) error(`unsupported value parameter ${label}`);
  let rest = text.slice(1).trim(),
    reference = null,
    captureScale = null;
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 0) error(`unterminated soft scale in ${label}`);
    reference = rest.slice(1, end).trim() || null;
    rest = rest.slice(end + 1).trim();
  }
  if (rest.startsWith("(")) {
    let depth = 0,
      end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "(") depth++;
      if (rest[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) error(`unterminated capture scale in ${label}`);
    captureScale = rest.slice(1, end);
    rest = rest.slice(end + 1).trim();
  }
  return { ...scalar(rest, label), reference, captureScale };
}
function header(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_BYTES)
    error("expected an ArrayBuffer no larger than 512 MiB");
  const bytes = new Uint8Array(buffer),
    prefix = new TextDecoder().decode(bytes.subarray(0, 12));
  if (!prefix.startsWith("\\*File list"))
    error(
      "expected a binary \\*File list header; ASCII and force-curve variants are unsupported",
    );
  const end = bytes.subarray(0, MAX_HEADER).indexOf(26);
  if (end < 0) error("missing Ctrl-Z header terminator within 4 MiB");
  let text,
    encoding = "UTF-8";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, end),
    );
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes.subarray(0, end));
    encoding = "Windows-1252";
  }
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("\\*")) {
      current = { name: line.slice(2).trim(), values: Object.create(null) };
      sections.push(current);
      continue;
    }
    if (!current || !line.startsWith("\\")) error("malformed header line");
    const delimiter = line.search(/:\s/);
    if (delimiter < 0) error("header parameter has no value separator");
    const key = line.slice(1, delimiter),
      value = line.slice(delimiter + 1).trim();
    if (Object.hasOwn(current.values, key))
      error(`duplicate header parameter ${key}`);
    current.values[key] = value;
  }
  if (
    sections[0]?.name !== "File list" ||
    sections.at(-1)?.name !== "File list end"
  )
    error("incomplete file-list header");
  const length = integer(
    sections[0].values["Data length"],
    "header length",
    end + 1,
  );
  if (length > buffer.byteLength) error("header length exceeds file");
  const versionText = sections[0].values.Version;
  if (!/^0x[\da-f]{1,8}$/i.test(versionText ?? ""))
    error("missing or invalid software version");
  return {
    sections,
    length,
    encoding,
    version: Number(versionText),
    versionText,
  };
}
function dimensions(values) {
  const width = integer(values["Samps/line"], "samples per line", 1),
    height = integer(values["Number of lines"], "line count", 1);
  if (!Number.isSafeInteger(width * height) || width * height > MAX_BYTES / 8)
    error("image exceeds decoded pixel limit");
  const match = new RegExp(`^(${NUMBER})\\s+(${NUMBER})\\s+(\\S+)$`).exec(
    values["Scan Size"] ?? "",
  );
  if (!match)
    error(
      "requires an explicit per-image Scan Size with X and Y extents and units",
    );
  const unit = baseUnit(match[3]);
  if (unit.unit !== "m") error("lateral calibration must have length units");
  const xreal = Number(match[1]) * unit.factor,
    yreal = Number(match[2]) * unit.factor;
  if (![xreal, yreal].every((v) => Number.isFinite(v) && v > 0))
    error("lateral extents must be finite and positive");
  return { width, height, xreal, yreal };
}
function calibration(values, globalValues, bits) {
  const scaleKeys = Object.keys(values).filter((key) =>
    /^@\d+:Z scale$/.test(key),
  );
  if (scaleKeys.length !== 1)
    error("requires exactly one grouped Z scale per image");
  const scale = parseValue(values[scaleKeys[0]], scaleKeys[0]);
  if (!(scale.value > 0)) error("full Z scale must be positive");
  const hard = baseUnit(scale.unit),
    warnings = [];
  let softValue = 1,
    softUnit = null,
    conversion = hard.factor,
    zUnit = hard.unit;
  if (scale.reference) {
    const key = "@" + scale.reference;
    const choices = globalValues.get(key) ?? [];
    const distinct = [...new Set(choices)];
    if (distinct.length !== 1)
      error(`soft scale ${key} is missing or ambiguous`);
    const soft = parseValue(distinct[0], key);
    if (soft.reference || !Number.isFinite(soft.value) || soft.value === 0)
      error("nested or zero soft scale is unsupported");
    softValue = soft.value;
    softUnit = soft.unit;
    if (!soft.unit) {
      warnings.push(
        "Sensitivity has no unit: retaining declared electrical/arbitrary units; no physical material-property calibration inferred.",
      );
    } else {
      const slash = soft.unit.lastIndexOf("/");
      if (slash < 1)
        error(
          `soft-scale unit ${soft.unit} must specify numerator/denominator`,
        );
      const numerator = baseUnit(soft.unit.slice(0, slash)),
        denominator = baseUnit(soft.unit.slice(slash + 1));
      if (denominator.unit !== hard.unit)
        error("soft-scale denominator does not match the Z-scale unit");
      conversion = (hard.factor / denominator.factor) * numerator.factor;
      zUnit = numerator.unit;
    }
  }
  if (zUnit === "Arb" || zUnit === "log(Arb)")
    warnings.push(
      "Arbitrary values are preserved; no modulus/force conversion or logarithm exponentiation is applied.",
    );
  const factor = (scale.value / 2 ** bits) * softValue * conversion;
  if (!Number.isFinite(factor) || factor === 0)
    error("invalid count-to-unit factor");
  return {
    factor,
    zUnit,
    warnings,
    details: {
      full_scale: scale.value,
      full_scale_unit: scale.unit,
      soft_reference: scale.reference,
      soft_value: softValue,
      soft_unit: softUnit,
      declared_bits: bits,
      factor_in_output_units: factor,
      capture_scale_ignored: scale.captureScale,
      z_offset_applied: false,
    },
  };
}
function declaredMask(values, width, height) {
  const keys = [
    "Valid data start X",
    "Valid data start Y",
    "Valid data len X",
    "Valid data len Y",
  ];
  if (!keys.some((k) => Object.hasOwn(values, k))) return null;
  if (!keys.every((k) => Object.hasOwn(values, k)))
    error("incomplete valid-data rectangle");
  const [x, y, w, h] = keys.map((k) => integer(values[k], k));
  if (!w || !h || x + w > width || y + h > height)
    error("invalid valid-data rectangle");
  if (x === 0 && y === 0 && w === width && h === height) return null;
  const mask = new Uint8Array(width * height);
  for (let outY = 0; outY < height; outY++)
    for (let col = 0; col < width; col++) {
      const rawY = height - 1 - outY;
      mask[outY * width + col] =
        col < x || col >= x + w || rawY < y || rawY >= y + h ? 1 : 0;
    }
  return mask;
}
export function parseNanoscope(buffer) {
  const h = header(buffer),
    view = new DataView(buffer),
    globalValues = new Map(),
    metadata = Object.create(null);
  for (const section of h.sections.filter(
    (s) => s.name !== "Ciao image list",
  )) {
    for (const [key, value] of Object.entries(section.values)) {
      metadata[`${section.name} / ${key}`] = value;
      if (!globalValues.has(key)) globalValues.set(key, []);
      globalValues.get(key).push(value);
    }
  }
  const images = h.sections.filter((s) => s.name === "Ciao image list");
  if (!images.length) error("no supported Ciao image raster blocks");
  if (images.length > 256) error("more than 256 image blocks");
  // Validate every payload boundary before allocating any decoded arrays.
  const ranges = images.map((image, index) => {
    const offset = integer(
        image.values["Data offset"],
        `image ${index} offset`,
        h.length,
      ),
      length = integer(image.values["Data length"], `image ${index} length`, 1);
    if (
      !Number.isSafeInteger(offset + length) ||
      offset + length > buffer.byteLength
    )
      error(`image ${index} is truncated`);
    return { offset, length, index };
  });
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].length)
      error("overlapping image payloads");
  const channels = Object.create(null),
    unsupported = [],
    warnings = [],
    unsupported_channels = [];
  let decodedBytes = 0;
  for (let index = 0; index < images.length; index++) {
    const values = images[index].values,
      range = ranges[index],
      id = String(index);
    const titleKeys = Object.keys(values).filter((key) =>
      /^@\d+:Image Data$/.test(key),
    );
    const titleMatch =
      titleKeys.length === 1
        ? /^S\s+\[[^\]]*\]\s+"([^"\r\n]+)"$/.exec(values[titleKeys[0]])
        : null;
    const title = titleMatch?.[1] ?? `Image ${index}`;
    try {
      if (!titleMatch) error("missing unambiguous image title");
      if (values["Data type"] !== "AFM")
        error("only AFM raster blocks are supported");
      for (const key of ["Invalid Data Flag", "Invalid Data Fill"])
        if (values[key] && values[key] !== "None")
          error(`unsupported ${key} encoding`);
      const { width, height, xreal, yreal } = dimensions(values),
        declared = integer(
          values["Bytes/pixel"],
          "declared bytes per pixel",
          1,
        ),
        stored = range.length / (width * height);
      if (![2, 4].includes(declared) || ![2, 4].includes(stored))
        error(
          "only tightly packed signed 16/32-bit integer rasters are supported",
        );
      if (
        stored !== declared &&
        !(stored === 4 && declared === 2 && h.version >>> 24 === 9)
      )
        error("unvalidated stored/declared pixel-width combination");
      const cal = calibration(values, globalValues, declared * 8);
      if (decodedBytes + width * height * 8 > MAX_BYTES)
        error("total decoded channels exceed 512 MiB");
      const data = new Float64Array(width * height);
      decodedBytes += data.byteLength;
      // Bruker raster records start at the lower-left. The viewer uses top-down rows.
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const offset = range.offset + ((height - 1 - y) * width + x) * stored;
          const count =
            stored === 2
              ? view.getInt16(offset, true)
              : view.getInt32(offset, true);
          data[y * width + x] = count * cal.factor;
        }
      const notes = [...cal.warnings];
      if (stored !== declared)
        notes.push(
          `Samples occupy ${stored} bytes; declared ${declared}-byte resolution is used for calibration (NanoScope 9.x).`,
        );
      notes.push(
        "Image-local coordinates; stage offsets and rotation are preserved as metadata, not applied. Z offset and display magnification are not added to the data.",
      );
      const channelMetadata = {
        ...metadata,
        ...values,
        "Import / reader": "NanoScope binary raster adapter 1",
        "Import / header encoding": h.encoding,
        "Import / orientation":
          "raw rows reversed; columns unchanged; top-down image-local coordinates",
        "Import / stored bytes per pixel": String(stored),
        "Import / count-to-unit calibration": JSON.stringify(cal.details),
      };
      channels[id] = {
        id,
        title,
        data,
        width,
        height,
        shape: [height, width],
        xreal,
        yreal,
        xoff: 0,
        yoff: 0,
        xy_unit: "m",
        z_unit: cal.zUnit,
        metadata: channelMetadata,
        log: [],
        mask: declaredMask(values, width, height),
        warnings: notes,
        selections: {},
      };
    } catch (cause) {
      unsupported_channels.push({ id, title, reason: cause.message });
      unsupported.push(`Image ${id} (${title}): ${cause.message}`);
    }
  }
  for (const section of h.sections)
    if (
      ![
        "File list",
        "File list end",
        "Ciao image list",
        "Equipment list",
        "Scanner list",
        "Ciao scan list",
        "Fast Scan list",
        "Temperature Controller list",
      ].includes(section.name)
    )
      unsupported.push(`Uninterpreted header section: ${section.name}`);
  if (!Object.keys(channels).length)
    error(`no calibrated supported channels. ${unsupported.join("; ")}`);
  if (unsupported_channels.length)
    warnings.push(
      `${unsupported_channels.length} image channel(s) could not be calibrated and were not imported. See unsupported fields.`,
    );
  return {
    format: "NANOSCOPE",
    channels,
    unsupported,
    unsupported_channels,
    warnings,
  };
}
