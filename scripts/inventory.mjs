/** Rebuild measurement inventory and reference evidence without changing inputs. */
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseGwy, summarizeChannel } from "../web/gwy.js";
import { applyOperation, compare, geometry } from "../web/engine.js";

export const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const RAW_NAME = "sample-input.gwy";
export const WORKED_NAME = "sample-reference.gwy";
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function loadSource(path) {
  const bytes = await readFile(path);
  return {
    ...parseGwy(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
    sha256: hash(bytes),
    file: basename(path),
    size_bytes: bytes.byteLength,
  };
}
export async function writeJSON(path, value) {
  const text =
    JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "number" && !Number.isFinite(v))
          throw new Error(`Nonfinite JSON number in ${path}`);
        if (ArrayBuffer.isView(v)) return Array.from(v);
        return v;
      },
      2,
    ) + "\n";
  await writeFile(path, text);
}
export function pairReport(raw, worked) {
  const channels = [];
  for (const id of Object.keys(raw.channels).filter((id) =>
    Object.hasOwn(worked.channels, id),
  )) {
    const a = raw.channels[id],
      b = worked.channels[id];
    const row = {
      id,
      title: a.title,
      z_unit: a.z_unit,
      shapes_equal: a.width === b.width && a.height === b.height,
      calibration_equal:
        JSON.stringify(geometry(a)) === JSON.stringify(geometry(b)),
      raw_log: a.log,
      worked_log: b.log,
      metadata_changes: Object.fromEntries(
        [...new Set([...Object.keys(a.metadata), ...Object.keys(b.metadata)])]
          .filter((k) => a.metadata[k] !== b.metadata[k])
          .map((k) => [
            k,
            { raw: a.metadata[k] ?? null, worked: b.metadata[k] ?? null },
          ]),
      ),
    };
    if (row.shapes_equal && row.calibration_equal) {
      const cp = compare(a, b),
        delta = { ...a, data: cp.data, mask: null };
      const fit = applyOperation(delta, { name: "plane" });
      let min = Infinity,
        max = -Infinity,
        sq = 0,
        n = 0;
      for (let i = 0; i < cp.data.length; i++)
        if (Number.isFinite(cp.data[i])) {
          min = Math.min(min, cp.data[i]);
          max = Math.max(max, cp.data[i]);
          sq += fit.channel.data[i] ** 2;
          n++;
        }
      const [constant, sx, sy] = fit.details.coefficients;
      Object.assign(row, {
        exact_array_equal: a.data.every((v, i) => Object.is(v, b.data[i])),
        rmse: cp.rmse,
        delta_raw_minus_worked_min: min,
        delta_raw_minus_worked_max: max,
        difference_plane_coefficients: [
          fit.details.origin +
            constant +
            sx * (1 / a.width - 1) +
            sy * (1 / a.height - 1),
          (2 * sx) / a.width,
          (2 * sy) / a.height,
        ],
        difference_plane_coefficient_order: [
          "constant",
          "column_index",
          "row_index",
        ],
        difference_plane_residual_rmse: Math.sqrt(sq / n),
      });
    }
    channels.push(row);
  }
  return {
    schema_version: 1,
    raw: raw.file,
    worked: worked.file,
    raw_sha256: raw.sha256,
    worked_sha256: worked.sha256,
    interpretation:
      "User-supplied worked example, not universal scientific ground truth. The recorded manual three-point leveling and minimum-zero operation describe this example; reproducing selected points does not validate an independent automatic estimator.",
    delta_definition:
      "raw minus worked in stored z units; row and column indices start at zero",
    channels,
    raw_only_channels: Object.keys(raw.channels).filter(
      (id) => !Object.hasOwn(worked.channels, id),
    ),
    worked_only_channels: Object.keys(worked.channels).filter(
      (id) => !Object.hasOwn(raw.channels, id),
    ),
    worked_selections: Object.fromEntries(
      Object.entries(worked.channels)
        .filter(([, c]) => Object.keys(c.selections).length)
        .map(([id, c]) => [id, c.selections]),
    ),
  };
}
export async function main() {
  const data = resolve(ROOT, "data"),
    out = resolve(ROOT, "docs");
  await mkdir(out, { recursive: true });
  const files = [];
  const loaded = new Map();
  for (const name of (await readdir(data))
    .filter((name) => name.endsWith(".gwy"))
    .sort()) {
    const source = await loadSource(resolve(data, name));
    loaded.set(name, source);
    files.push({
      file: name,
      sha256: source.sha256,
      size_bytes: source.size_bytes,
      channels: Object.values(source.channels).map(summarizeChannel),
      unsupported: source.unsupported,
      warnings: source.warnings,
      unsupported_note:
        "Stored keys retained in the generic container but not interpreted as images; includes display state. Not a list of unreadable image channels.",
    });
  }
  await writeJSON(resolve(out, "inventory.json"), {
    schema_version: 1,
    format_reference:
      "https://gwyddion.net/documentation/user-guide-en/gwyfile-format.html",
    file_count: files.length,
    channel_count: files.reduce((n, f) => n + f.channels.length, 0),
    files,
  });
  await writeJSON(
    resolve(out, "reference_pair.json"),
    pairReport(loaded.get(RAW_NAME), loaded.get(WORKED_NAME)),
  );
  console.log(
    `Inventoried ${files.length} files / ${files.reduce((n, f) => n + f.channels.length, 0)} channels.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
