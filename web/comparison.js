/** Metadata-only comparison: no source arrays are loaded or replayed. */
const HASH = /^[a-f0-9]{64}$/i;
const XY_UNITS = new Set(["m", "cm", "mm", "um", "µm", "μm", "nm", "pm", "Å"]);
const Z_UNITS = new Set([
  ...XY_UNITS,
  "V",
  "mV",
  "uV",
  "µV",
  "μV",
  "A",
  "mA",
  "uA",
  "µA",
  "nA",
  "pA",
  "N",
  "mN",
  "uN",
  "µN",
  "nN",
  "pN",
  "Pa",
  "kPa",
  "MPa",
  "GPa",
  "J",
  "pJ",
  "fJ",
  "eV",
  "Hz",
  "kHz",
  "MHz",
  "deg",
  "rad",
  "s",
  "ms",
  "1",
]);
const METRICS = [
  "sa",
  "sq",
  "min",
  "max",
  "mean",
  "valid_count",
  "excluded_count",
  "area",
];
const GEOMETRY = [
  "shape",
  "xreal",
  "yreal",
  "xoff",
  "yoff",
  "xy_unit",
  "z_unit",
];
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const string = (x) => typeof x === "string" && x.trim().length > 0;
const requireValue = (test, message) => {
  if (!test) throw new Error(message);
};

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}
function jsonSafe(value) {
  if (value === null || ["string", "boolean"].includes(typeof value))
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonSafe);
  return object(value) && Object.values(value).every(jsonSafe);
}
function geometry(g) {
  requireValue(object(g), "Missing geometry");
  requireValue(
    Array.isArray(g.shape) &&
      g.shape.length === 2 &&
      g.shape.every((n) => Number.isSafeInteger(n) && n > 0),
    "Invalid geometry shape",
  );
  requireValue(
    ["xreal", "yreal"].every((k) => Number.isFinite(g[k]) && g[k] > 0) &&
      ["xoff", "yoff"].every((k) => Number.isFinite(g[k])),
    "Invalid geometry calibration",
  );
  requireValue(
    XY_UNITS.has(g.xy_unit) && Z_UNITS.has(g.z_unit),
    "Missing, unknown, or unsupported units",
  );
  return Object.fromEntries(GEOMETRY.map((k) => [k, g[k]]));
}
function validate(record) {
  const r = record.recipe,
    a = record.analysis;
  requireValue(object(r) && object(a), "Missing recipe or analysis object");
  requireValue(
    jsonSafe(r) && jsonSafe(a),
    "Nonfinite or non-JSON artifact values",
  );
  requireValue(
    HASH.test(record.recipe_sha256 ?? "") &&
      HASH.test(record.analysis_sha256 ?? ""),
    "Missing artifact SHA-256",
  );
  requireValue(r.schema_version === 1, "Missing or unsupported recipe schema");
  requireValue(
    string(r.engine?.name) &&
      string(r.engine?.version) &&
      HASH.test(r.engine?.sha256 ?? ""),
    "Missing engine identity",
  );
  requireValue(
    string(r.source?.file) &&
      string(r.source?.channel) &&
      string(r.source?.title) &&
      HASH.test(r.source?.sha256 ?? ""),
    "Missing source identity",
  );
  requireValue(
    HASH.test(r.output?.sha256 ?? "") &&
      HASH.test(r.output?.measurement_sha256 ?? "") &&
      (r.output?.mask_sha256 === null ||
        HASH.test(r.output?.mask_sha256 ?? "")),
    "Missing output identity",
  );
  const source = geometry(r.source.geometry),
    output = geometry(r.output.geometry);
  requireValue(
    object(a.channel) &&
      String(a.channel.id) === r.source.channel &&
      a.channel.title === r.source.title &&
      stableStringify(geometry(a.channel)) === stableStringify(output),
    "Analysis channel does not match recipe output",
  );
  requireValue(
    Array.isArray(r.operations) &&
      r.operations.every(
        (o) => object(o) && string(o.name) && object(o.params),
      ),
    "Missing explicit operations",
  );
  requireValue(
    Array.isArray(a.history) && a.history.length === r.operations.length,
    "Missing or mismatched operation history",
  );
  a.history.forEach((h, i) =>
    requireValue(
      object(h) &&
        Number.isSafeInteger(h.version) &&
        h.version > 0 &&
        h.name === r.operations[i].name &&
        stableStringify(h.params) === stableStringify(r.operations[i].params),
      "Missing operation version or mismatched operation parameters",
    ),
  );
  requireValue(
    object(r.selection) &&
      Object.hasOwn(r.selection, "roi") &&
      Array.isArray(r.selection.exclude_polygons),
    "Missing explicit selection",
  );
  const bounds = (b) =>
    Array.isArray(b) &&
    b.length === 4 &&
    b.every(Number.isFinite) &&
    b[0] < b[2] &&
    b[1] < b[3];
  requireValue(
    r.selection.roi === null || bounds(r.selection.roi),
    "Invalid ROI",
  );
  requireValue(
    r.selection.exclude_polygons.every(
      (p) =>
        Array.isArray(p) &&
        p.length >= 3 &&
        p.every(
          (q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite),
        ),
    ),
    "Invalid exclusion polygons",
  );
  requireValue(
    Object.hasOwn(r, "profile") && Object.hasOwn(r, "plateaus"),
    "Missing explicit profile or plateaus",
  );
  requireValue(
    r.profile === null ||
      (Array.isArray(r.profile) &&
        r.profile.length === 2 &&
        r.profile.every(
          (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
        )),
    "Invalid profile",
  );
  requireValue(
    r.plateaus === null ||
      (Array.isArray(r.plateaus) &&
        r.plateaus.length === 2 &&
        r.plateaus.every(bounds)),
    "Invalid plateaus",
  );
  const s = a.statistics;
  requireValue(
    object(s) && METRICS.every((k) => Number.isFinite(s[k])),
    "Missing or nonfinite statistics",
  );
  requireValue(
    Number.isSafeInteger(s.valid_count) &&
      s.valid_count > 0 &&
      Number.isSafeInteger(s.excluded_count) &&
      s.excluded_count >= 0 &&
      s.valid_count + s.excluded_count === output.shape[0] * output.shape[1],
    "Invalid metric counts",
  );
  requireValue(
    s.sa >= 0 &&
      s.sq >= 0 &&
      s.area > 0 &&
      s.min <= s.mean + Math.max(Math.abs(s.min), Math.abs(s.max)) * 1e-10 &&
      s.mean <= s.max + Math.max(Math.abs(s.min), Math.abs(s.max)) * 1e-10 &&
      s.sa <= s.sq + Math.max(s.sa, s.sq) * 1e-12,
    "Invalid metric ranges",
  );
  requireValue(
    s.xy_unit === output.xy_unit &&
      s.z_unit === output.z_unit &&
      s.area_unit === `(${s.xy_unit})²`,
    "Metric units do not match output geometry",
  );
  const expectedArea =
    s.valid_count *
    (output.xreal / output.shape[1]) *
    (output.yreal / output.shape[0]);
  requireValue(
    Math.abs(s.area - expectedArea) <= Math.abs(expectedArea) * 1e-10,
    "Metric area does not match valid count and geometry",
  );
  requireValue(string(s.reference), "Missing statistics reference");
  return {
    channel_title: r.source.title,
    source_geometry: source,
    output_geometry: output,
    engine_sha256: r.engine.sha256.toLowerCase(),
    engine_name: r.engine.name,
    engine_version: r.engine.version,
    operations: r.operations,
    operation_versions: a.history.map((h) => ({
      name: h.name,
      version: h.version,
    })),
    selection: r.selection,
    profile: r.profile,
    plateaus: r.plateaus,
    statistics_reference: s.reference,
  };
}
function rowFor(record, index) {
  const r = record?.recipe,
    a = record?.analysis,
    s = a?.statistics;
  return {
    input_index: index,
    run: typeof record?.run === "string" ? record.run : null,
    status: "excluded",
    reason: null,
    group_id: null,
    source_file: r?.source?.file ?? null,
    source_sha256: r?.source?.sha256 ?? null,
    channel: r?.source?.channel ?? null,
    title: r?.source?.title ?? null,
    output_sha256: r?.output?.sha256 ?? null,
    output_mask_sha256: r?.output?.mask_sha256 ?? null,
    measurement_sha256: r?.output?.measurement_sha256 ?? null,
    import_support: a?.channel?.metadata?.["Import / support"] ?? null,
    warnings: a?.warnings ?? [],
    quality_warnings: a?.quality?.warnings ?? [],
    z_unit: s?.z_unit ?? null,
    xy_unit: s?.xy_unit ?? null,
    area_unit: s?.area_unit ?? null,
    engine_sha256: r?.engine?.sha256 ?? null,
    operations: r?.operations ?? null,
    operation_versions: Array.isArray(a?.history)
      ? a.history.map((h) => ({
          name: h?.name ?? null,
          version: h?.version ?? null,
        }))
      : null,
    history: a?.history ?? null,
    selection: r?.selection ?? null,
    source_geometry: r?.source?.geometry ?? null,
    output_geometry: r?.output?.geometry ?? null,
    profile: r?.profile ?? null,
    plateaus: r?.plateaus ?? null,
    statistics_reference: s?.reference ?? null,
    ...Object.fromEntries(
      METRICS.map((k) => [k, Number.isFinite(s?.[k]) ? s[k] : null]),
    ),
    sample_id: null,
    recipe_sha256: record?.recipe_sha256 ?? null,
    analysis_sha256: record?.analysis_sha256 ?? null,
  };
}
function counts(rows) {
  return {
    acquisition_count: new Set(rows.map((r) => r.source_sha256.toLowerCase()))
      .size,
    unique_explicit_independent_sample_count: rows.some(
      (r) => r.sample_id === null,
    )
      ? null
      : new Set(rows.map((r) => r.sample_id)).size,
    assigned_independent_sample_id_count: new Set(
      rows.filter((r) => r.sample_id !== null).map((r) => r.sample_id),
    ).size,
    unassigned_acquisition_count: new Set(
      rows
        .filter((r) => r.sample_id === null)
        .map((r) => r.source_sha256.toLowerCase()),
    ).size,
  };
}
export function compareRuns(records, sampleMap = {}) {
  requireValue(Array.isArray(records), "records must be an array");
  requireValue(
    object(sampleMap) &&
      Object.entries(sampleMap).every(([k, v]) => HASH.test(k) && string(v)),
    "Sample map must map source SHA-256 to nonempty independent sample IDs",
  );
  const map = new Map();
  for (const [k, v] of Object.entries(sampleMap)) {
    requireValue(
      !map.has(k.toLowerCase()) || map.get(k.toLowerCase()) === v,
      "Conflicting sample IDs for source hash",
    );
    map.set(k.toLowerCase(), v);
  }
  const rows = [],
    groups = new Map(),
    seen = new Map();
  records.forEach((record, index) => {
    const row = rowFor(record, index);
    rows.push(row);
    if (typeof row.source_sha256 === "string")
      row.sample_id = map.get(row.source_sha256.toLowerCase()) ?? null;
    try {
      requireValue(object(record), "Invalid record");
      requireValue(!record.error, String(record.error));
      const compatible = validate(record),
        key = stableStringify(compatible);
      const duplicate = stableStringify([
        row.source_sha256.toLowerCase(),
        row.channel,
        row.output_sha256.toLowerCase(),
        row.output_mask_sha256?.toLowerCase() ?? null,
        row.measurement_sha256.toLowerCase(),
        key,
      ]);
      if (seen.has(duplicate)) {
        row.reason = `Duplicate of input ${seen.get(duplicate)}`;
        return;
      }
      seen.set(duplicate, index);
      row.status = "included";
      if (!groups.has(key))
        groups.set(key, { compatibility: compatible, rows: [] });
      groups.get(key).rows.push(row);
    } catch (error) {
      row.reason = error.message;
    }
  });
  const summaries = [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, g], index) => {
      const id = `group-${index + 1}`;
      g.rows.forEach((r) => (r.group_id = id));
      return {
        id,
        compatibility_key: key,
        compatibility: g.compatibility,
        input_indices: g.rows.map((r) => r.input_index),
        ...counts(g.rows),
      };
    });
  return {
    schema_version: 1,
    kind: "metadata-only saved-run comparison",
    notice:
      "Source arrays were not replayed. Retain recipes, analysis artifacts, engine sources and raw inputs. Metrics are per acquisition; pixels are not pooled. Independent sample counts require explicit IDs.",
    input_count: rows.length,
    included_count: rows.filter((r) => r.status === "included").length,
    excluded_count: rows.filter((r) => r.status === "excluded").length,
    ...counts(rows.filter((r) => r.status === "included")),
    groups: summaries,
    rows,
  };
}
