import { decodeRecipeInput } from "../web/recipe-interchange.js";
/** Strict recipe replay followed by deterministic threshold-region measurement. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadSource, engineIdentity } from "./io.mjs";
import { segmentRecipe } from "../web/segmentation-service.js";

const usage =
  "Usage: node scripts/segment.mjs --recipe PATH --input PATH [--reference PATH] --out DIR --threshold NUMBER [--direction above|below --connectivity 4|8 --min-pixels N --boundary include|exclude]";
const args = process.argv.slice(2),
  options = {};
const allowed = [
  "recipe",
  "input",
  "reference",
  "out",
  "threshold",
  "direction",
  "connectivity",
  "min-pixels",
  "boundary",
];
while (args.length) {
  const flag = args.shift(),
    value = args.shift(),
    key = flag?.slice(2);
  if (
    !flag?.startsWith("--") ||
    !allowed.includes(key) ||
    value === undefined ||
    value.startsWith("--") ||
    Object.hasOwn(options, key)
  )
    throw new Error(usage);
  options[key] = value;
}
if (
  !["recipe", "input", "out", "threshold"].every((key) =>
    Object.hasOwn(options, key),
  )
)
  throw new Error(usage);
const parameters = { threshold: Number(options.threshold) };
for (const key of ["direction", "boundary"])
  if (options[key] !== undefined) parameters[key] = options[key];
if (options.connectivity !== undefined)
  parameters.connectivity = Number(options.connectivity);
if (options["min-pixels"] !== undefined)
  parameters.min_pixels = Number(options["min-pixels"]);
const { recipe, document } = await decodeRecipeInput(
  JSON.parse(await readFile(options.recipe, "utf8")),
);
const source = await loadSource(options.input);
const reference = options.reference
  ? await loadSource(options.reference)
  : null;
const names = ["segmentation.js", "segmentation-service.js", "engine.js"];
const parts = await Promise.all(
  names.map((name) =>
    readFile(new URL("../web/" + name, import.meta.url), "utf8"),
  ),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const code = {
  sha256: digest(parts.join("\n")),
  files: names.map((name, i) => ({ name, sha256: digest(parts[i]) })),
};
const result = await segmentRecipe(
  { recipe, parameters },
  source,
  reference,
  await engineIdentity(source.format),
  code,
);
// Creating the directory without recursive mode refuses every existing target,
// including symlinks, before any report file can be overwritten.
const out = resolve(options.out);
await mkdir(out);
if (document)
  await writeFile(
    resolve(out, "input-recipe-document.json"),
    JSON.stringify(document, null, 2) + "\n",
    { flag: "wx" },
  );
await writeFile(
  resolve(out, "report.json"),
  JSON.stringify(result, null, 2) + "\n",
  { flag: "wx" },
);
await writeFile(
  resolve(out, "input-recipe.json"),
  JSON.stringify(recipe, null, 2) + "\n",
  { flag: "wx" },
);
const escape = (value) => {
  let s =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  s = s.replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return /^[=+@-]/.test(s) && typeof value !== "number" ? "'" + s : s;
};
const regions = [
  ...result.report.regions.map((region) => ({
    status: "accepted",
    xy_unit: result.report.geometry.xy_unit,
    z_unit: result.report.geometry.z_unit,
    ...region,
  })),
  ...result.report.excluded_regions.map((region) => ({
    status: "excluded",
    xy_unit: result.report.geometry.xy_unit,
    z_unit: result.report.geometry.z_unit,
    ...region,
  })),
];
const columns = [
  ...new Set([
    "status",
    "id",
    "excluded_reasons",
    "xy_unit",
    "z_unit",
    "area_unit",
    ...regions.flatMap((row) => Object.keys(row)),
  ]),
];
const tsv =
  [
    columns.map(escape).join("\t"),
    ...regions.map((row) => columns.map((key) => escape(row[key])).join("\t")),
  ].join("\n") + "\n";
await writeFile(resolve(out, "regions.tsv"), tsv, { flag: "wx" });
console.log(
  JSON.stringify({
    out,
    report_sha256: result.report_sha256,
    labels_sha256: result.labels_sha256,
    region_count: regions.length,
  }),
);
