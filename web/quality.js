/** Descriptive acquisition diagnostics only: no correction or registration. */
import {
  compare,
  geometry,
  median,
  normalizeSelection,
  validMask,
} from "./engine.js";

function axisReport(channel, mask, rows, sigma, amplitude, warnings) {
  const lines = rows ? channel.height : channel.width,
    length = rows ? channel.width : channel.height;
  const medians = Array.from({ length: lines }, (_, line) => {
    const values = [];
    for (let j = 0; j < length; j++) {
      const i = rows ? line * channel.width + j : j * channel.width + line;
      if (mask[i]) values.push(channel.data[i]);
    }
    return values.length ? median(values) : null;
  });
  const differences = medians
    .slice(1)
    .map((value, i) =>
      value === null || medians[i] === null ? null : value - medians[i],
    );
  const usable = differences.filter((v) => v !== null);
  if (!usable.length) {
    warnings.push(
      `No usable adjacent ${rows ? "row" : "column"} pair in the selected pixels.`,
    );
    return {
      medians,
      adjacent_differences: differences,
      center: null,
      mad: null,
      threshold: null,
      candidates: [],
    };
  }
  const center = median(usable),
    mad = median(usable.map((v) => Math.abs(v - center)));
  const threshold = Math.max(
    sigma * 1.4826 * mad,
    64 * Number.EPSILON * amplitude,
  );
  const candidates = [];
  differences.forEach((delta, i) => {
    if (delta !== null && Math.abs(delta - center) > threshold)
      candidates.push({
        boundary_index: i + 1,
        delta,
        center,
        threshold,
        z_unit: channel.z_unit,
      });
  });
  return {
    medians,
    adjacent_differences: differences,
    center,
    mad,
    threshold,
    candidates,
  };
}

export function qualityReport(
  channel,
  { selection = {}, boundary_sigma = 6 } = {},
  reference = null,
) {
  if (!Number.isFinite(boundary_sigma) || boundary_sigma <= 0)
    throw new Error("boundary_sigma must be positive and finite.");
  const normalized = normalizeSelection(selection),
    mask = validMask(channel, normalized);
  let selected = 0,
    invalid = 0,
    importedMask = 0,
    amplitude = 0,
    otherwiseValid = 0;
  for (let i = 0; i < channel.data.length; i++) {
    if (!Number.isFinite(channel.data[i])) invalid++;
    if (channel.mask?.[i]) importedMask++;
    if (Number.isFinite(channel.data[i]) && !channel.mask?.[i])
      otherwiseValid++;
    if (mask[i]) {
      selected++;
      amplitude = Math.max(amplitude, Math.abs(channel.data[i]));
    }
  }
  const warnings = [
    ...(channel.warnings ?? []),
    ...(reference?.warnings ?? []).map((warning) => `Reference: ${warning}`),
    "Physical steps and sample structure can trigger boundary candidates. These diagnostics do not identify acquisition defects or automatically repair data.",
  ];
  if (channel.xy_unit == null || channel.z_unit == null)
    warnings.push(
      "Unknown lateral or vertical unit; diagnostics retain stored values and do not imply physical height calibration.",
    );
  if (!selected) warnings.push("No valid selected pixels.");
  const rows = axisReport(
    channel,
    mask,
    true,
    boundary_sigma,
    amplitude,
    warnings,
  );
  const columns = axisReport(
    channel,
    mask,
    false,
    boundary_sigma,
    amplitude,
    warnings,
  );
  let comparison = null;
  if (reference) {
    const result = compare(channel, reference, normalized);
    comparison = Object.fromEntries(
      Object.entries(result).filter(
        ([key]) => !["data", "target"].includes(key),
      ),
    );
    comparison.definition =
      "input channel minus explicit reference; common valid selection only; no alignment";
    comparison.z_unit = channel.z_unit;
  }
  return {
    schema_version: 1,
    parameters: { selection: normalized, boundary_sigma },
    geometry: geometry(channel),
    units: { xy: channel.xy_unit, z: channel.z_unit },
    counts: {
      total: channel.data.length,
      selected,
      invalid,
      imported_mask: importedMask,
      excluded: channel.data.length - selected,
      selection_excluded_valid: otherwiseValid - selected,
    },
    rows,
    columns,
    comparison,
    warnings,
  };
}

/** Pair only exact title families; duplicate trace or retrace names are ambiguous. */
export function findTracePairs(channels) {
  const families = new Map();
  for (const [id, channel] of Object.entries(channels)) {
    const match = /^(.*?)(retrace|trace)$/i.exec(channel.title ?? "");
    if (!match || !match[1]) continue;
    const family = match[1].toLowerCase(),
      kind = match[2].toLowerCase();
    if (!families.has(family)) families.set(family, { trace: [], retrace: [] });
    families.get(family)[kind].push(String(id));
  }
  return [...families.entries()]
    .filter(([, v]) => v.trace.length === 1 && v.retrace.length === 1)
    .map(([family, v]) => ({
      family,
      trace_id: v.trace[0],
      retrace_id: v.retrace[0],
    }));
}
