import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { compareRuns, stableStringify } from "../web/comparison.js";

export function tsvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  let text = typeof value === "object" ? stableStringify(value) : String(value);
  // Prefix textual formula/control starts before RFC-style quoting. Numeric columns remain numeric.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text))
    text = "'" + text;
  return /[\t\r\n"]/u.test(text)
    ? '"' + text.replaceAll('"', '""') + '"'
    : text;
}
export function comparisonTSV(report) {
  const columns = [
    "input_index",
    "run",
    "status",
    "reason",
    "group_id",
    "source_file",
    "source_sha256",
    "channel",
    "title",
    "sample_id",
    "z_unit",
    "xy_unit",
    "area_unit",
    "engine_sha256",
    "output_sha256",
    "output_mask_sha256",
    "measurement_sha256",
    "import_support",
    "warnings",
    "quality_warnings",
    "sa",
    "sq",
    "min",
    "max",
    "mean",
    "valid_count",
    "excluded_count",
    "area",
    "statistics_reference",
    "operations",
    "operation_versions",
    "history",
    "selection",
    "profile",
    "plateaus",
    "source_geometry",
    "output_geometry",
    "recipe_sha256",
    "analysis_sha256",
  ];
  return (
    [
      columns.join("\t"),
      ...report.rows.map((row) =>
        columns.map((k) => tsvCell(row[k])).join("\t"),
      ),
    ].join("\n") + "\n"
  );
}
export async function main(argv = process.argv.slice(2)) {
  const runs = [];
  let out, samples;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--samples") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      if (arg === "--out") {
        if (out) throw new Error("Duplicate --out");
        out = argv[++i];
      } else {
        if (samples) throw new Error("Duplicate --samples");
        samples = argv[++i];
      }
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else runs.push(arg);
  }
  if (!out || !runs.length)
    throw new Error(
      "Usage: node scripts/compare.mjs RUN_DIR... --out OUT_DIR [--samples MAP.json]",
    );
  const sampleMap = samples ? JSON.parse(await readFile(samples, "utf8")) : {};
  const records = await Promise.all(
    runs.map(async (run) => {
      const record = { run: resolve(run) },
        errors = [];
      await Promise.all(
        ["recipe", "analysis"].map(async (name) => {
          try {
            const bytes = await readFile(resolve(run, `${name}.json`));
            record[`${name}_sha256`] = createHash("sha256")
              .update(bytes)
              .digest("hex");
            record[name] = JSON.parse(bytes.toString("utf8"));
          } catch (error) {
            errors.push(`${name}.json: ${error.code ?? error.name}`);
          }
        }),
      );
      if (errors.length) record.error = errors.sort().join("; ");
      return record;
    }),
  );
  const report = compareRuns(records, sampleMap);
  await mkdir(out, { recursive: true });
  await writeFile(
    resolve(out, "comparison.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(resolve(out, "comparison.tsv"), comparisonTSV(report));
  return report.excluded_count ? 1 : 0;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
