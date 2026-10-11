/** Bounded native GWYP image reader, without dependencies.
 * https://gwyddion.net/documentation/user-guide-en/gwyfile-format.html
 * Data and calibration retain their stored units; nonzero masks mean excluded.
 */
const MAX_BYTES = 512 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

class Reader {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.pos = 4;
    this.warnings = [];
  }
  take(size, end) {
    if (!Number.isSafeInteger(size) || size < 0 || this.pos + size > end) {
      throw new Error("Truncated GWYP component or invalid length");
    }
    const start = this.pos;
    this.pos += size;
    return start;
  }
  uint(end) {
    return this.view.getUint32(this.take(4, end), true);
  }
  string(end) {
    const start = this.pos;
    while (this.pos < end && this.bytes[this.pos] !== 0) this.pos++;
    if (this.pos >= end) throw new Error("Unterminated GWYP string");
    const bytes = this.bytes.subarray(start, this.pos++);
    try {
      return utf8.decode(bytes);
    } catch {
      this.warnings.push(
        "Invalid UTF-8 text: original bytes preserved as hexadecimal escapes.",
      );
      // Preserve every non-ASCII byte visibly rather than guessing an encoding.
      return Array.from(bytes, (b) =>
        b < 128
          ? String.fromCharCode(b)
          : `\\x${b.toString(16).padStart(2, "0")}`,
      ).join("");
    }
  }
  object(end, depth = 0) {
    if (depth > 64) throw new Error("GWYP nesting exceeds 64 levels");
    const type = this.string(end);
    const size = this.uint(end);
    const stop = this.pos + size;
    if (stop > end) throw new Error("GWYP object exceeds parent boundary");
    const result = Object.create(null);
    result.__type__ = type;
    while (this.pos < stop) {
      const key = this.string(stop);
      const kind = String.fromCharCode(this.bytes[this.take(1, stop)]);
      if (Object.hasOwn(result, key))
        throw new Error(`Duplicate GWYP component: ${key}`);
      result[key] = this.value(kind, stop, depth);
    }
    return result;
  }
  value(kind, end, depth) {
    switch (kind) {
      case "b":
        return this.bytes[this.take(1, end)] !== 0;
      case "c":
        return this.bytes[this.take(1, end)];
      case "i":
        return this.view.getInt32(this.take(4, end), true);
      case "q": {
        const number = this.view.getBigInt64(this.take(8, end), true);
        return number <= BigInt(Number.MAX_SAFE_INTEGER) &&
          number >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(number)
          : number.toString();
      }
      case "d":
        return this.view.getFloat64(this.take(8, end), true);
      case "s":
        return this.string(end);
      case "o":
        return this.object(end, depth + 1);
    }
    if (!"CIQDSO".includes(kind))
      throw new Error(`Unsupported GWYP type code: ${kind}`);
    const count = this.uint(end);
    if (!count || count > end - this.pos)
      throw new Error("Invalid GWYP array count");
    const sizes = { C: 1, I: 4, Q: 8, D: 8 };
    if (Object.hasOwn(sizes, kind)) {
      const start = this.take(count * sizes[kind], end);
      if (kind === "C") return this.bytes.slice(start, start + count);
      if (kind === "Q")
        return Array.from({ length: count }, (_, i) =>
          this.view.getBigInt64(start + i * 8, true).toString(),
        );
      const result =
        kind === "D" ? new Float64Array(count) : new Int32Array(count);
      for (let i = 0; i < count; i++)
        result[i] =
          kind === "D"
            ? this.view.getFloat64(start + i * 8, true)
            : this.view.getInt32(start + i * 4, true);
      return result;
    }
    return Array.from({ length: count }, () =>
      this.value(kind.toLowerCase(), end, depth),
    );
  }
}

function dataField(obj) {
  if (obj?.__type__ !== "GwyDataField")
    throw new Error("Expected GwyDataField image or mask");
  const { xres: width, yres: height, data } = obj;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width * height)
  )
    throw new Error("Invalid image dimensions");
  if (!(data instanceof Float64Array) || data.length !== width * height)
    throw new Error("Image dimensions do not match double-array data");
  return { width, height, data };
}

function unit(obj, key) {
  if (!Object.hasOwn(obj, key)) return null;
  if (
    obj[key]?.__type__ !== "GwySIUnit" ||
    typeof obj[key].unitstr !== "string"
  )
    throw new Error("Malformed SI unit");
  return obj[key].unitstr;
}

function jsonValue(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, jsonValue(v)]),
    );
  return value;
}

export function parseGwy(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer))
    throw new TypeError("parseGwy expects an ArrayBuffer");
  if (arrayBuffer.byteLength > MAX_BYTES)
    throw new Error("File exceeds the 512 MiB import limit");
  const bytes = new Uint8Array(arrayBuffer);
  if (
    bytes.length < 4 ||
    bytes[0] !== 71 ||
    bytes[1] !== 87 ||
    bytes[2] !== 89 ||
    bytes[3] !== 80
  )
    throw new Error("Expected native GWYP format; legacy GWYO is unsupported");
  const reader = new Reader(arrayBuffer);
  const container = reader.object(bytes.length);
  if (container.__type__ !== "GwyContainer" || reader.pos !== bytes.length)
    throw new Error("Expected one complete GwyContainer");
  const channels = Object.create(null);
  const consumed = new Set(["__type__"]);
  const keys = Object.keys(container)
    .filter((k) => /^\/\d+\/data$/.test(k))
    .sort((a, b) => Number(a.split("/")[1]) - Number(b.split("/")[1]));
  for (const key of keys) {
    const id = key.split("/")[1];
    const obj = container[key];
    const { width, height, data } = dataField(obj);
    const channel = {
      id,
      title: container[`${key}/title`] ?? `Channel ${id}`,
      data,
      width,
      height,
      shape: [height, width],
    };
    if (typeof channel.title !== "string")
      throw new Error("Malformed channel title");
    for (const name of ["xreal", "yreal", "xoff", "yoff"]) {
      const value = obj[name] ?? (name.endsWith("off") ? 0 : null);
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (name.endsWith("real") && value <= 0)
      )
        throw new Error(`Invalid spatial calibration: ${name}`);
      channel[name] = value;
    }
    channel.xy_unit = unit(obj, "si_unit_xy");
    channel.z_unit = unit(obj, "si_unit_z");
    channel.metadata = {};
    const meta = container[`/${id}/meta`];
    if (meta !== undefined) {
      if (meta?.__type__ !== "GwyContainer")
        throw new Error("Malformed channel metadata");
      const entries = Object.entries(meta).filter(([k]) => k !== "__type__");
      if (entries.some(([, v]) => typeof v !== "string"))
        throw new Error("Channel metadata must contain strings");
      channel.metadata = Object.fromEntries(entries);
    }
    const log = container[`${key}/log`];
    if (log !== undefined && log?.__type__ !== "GwyStringList")
      throw new Error("Malformed channel log");
    channel.log = log?.strings ?? [];
    if (
      !Array.isArray(channel.log) ||
      channel.log.some((v) => typeof v !== "string")
    )
      throw new Error("Malformed channel log");
    channel.mask = null;
    if (Object.hasOwn(container, `/${id}/mask`)) {
      const mask = dataField(container[`/${id}/mask`]);
      if (
        mask.width !== width ||
        mask.height !== height ||
        mask.data.some((v) => !Number.isFinite(v))
      )
        throw new Error("Mask must be finite and match image shape");
      channel.mask = Uint8Array.from(mask.data, (v) => (v !== 0 ? 1 : 0));
    }
    channel.selections = {};
    for (const [selectionKey, value] of Object.entries(container)) {
      if (selectionKey.startsWith(`/${id}/select/`)) {
        const name = selectionKey.slice(`/${id}/select/`.length);
        if (!value || typeof value !== "object" || !value.__type__)
          throw new Error("Malformed selection");
        channel.selections[name] = {
          type: value.__type__,
          ...jsonValue(
            Object.fromEntries(
              Object.entries(value).filter(([k]) => k !== "__type__"),
            ),
          ),
        };
        consumed.add(selectionKey);
      }
    }
    channel.warnings = [];
    if (channel.xy_unit === null || channel.z_unit === null)
      channel.warnings.push("Missing unit metadata; do not assume metres.");
    if (data.some((v) => !Number.isFinite(v)))
      channel.warnings.push("Non-finite pixels are present.");
    if (Object.values(channel.metadata).some((v) => /\\x[0-9a-f]{2}/.test(v)))
      channel.warnings.push(
        "Invalid UTF-8 metadata bytes preserved as hexadecimal escapes.",
      );
    for (const represented of [
      key,
      `${key}/title`,
      `${key}/log`,
      `/${id}/meta`,
      `/${id}/mask`,
    ])
      consumed.add(represented);
    channels[id] = channel;
  }
  if (!keys.length) throw new Error("No supported image channels found");
  return {
    channels,
    container,
    unsupported: Object.keys(container).filter((k) => !consumed.has(k)),
    warnings: [...new Set(reader.warnings)],
  };
}

export function summarizeChannel(channel) {
  let min = Infinity,
    max = -Infinity,
    finite_count = 0,
    mask_count = 0;
  for (const value of channel.data)
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
      finite_count++;
    }
  if (channel.mask) for (const value of channel.mask) if (value) mask_count++;
  return {
    id: channel.id,
    title: channel.title,
    shape: [channel.height, channel.width],
    xreal: channel.xreal,
    yreal: channel.yreal,
    xoff: channel.xoff,
    yoff: channel.yoff,
    xy_unit: channel.xy_unit,
    z_unit: channel.z_unit,
    metadata: channel.metadata,
    log: channel.log,
    finite_count,
    min: finite_count ? min : null,
    max: finite_count ? max : null,
    mask_count,
    warnings: channel.warnings,
    selections: channel.selections,
  };
}
