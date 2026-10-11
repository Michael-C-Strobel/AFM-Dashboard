import { decodeRecipeInput } from "../web/recipe-interchange.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadSource, engineIdentity } from "./io.mjs";
import {
  sensitivityReport,
  verifySensitivityReport,
  sensitivityEntries,
  sensitivityBundle,
} from "../web/sensitivity-service.js";
const usage =
  "Usage: node scripts/sensitivity.mjs (--request PATH | --report PATH) --input PATH [--reference PATH] --out NEWDIR";
const args = process.argv.slice(2),
  options = {};
while (args.length) {
  const flag = args.shift(),
    value = args.shift(),
    key = flag?.slice(2);
  if (
    !flag?.startsWith("--") ||
    !["request", "report", "input", "reference", "out"].includes(key) ||
    value === undefined ||
    value.startsWith("--") ||
    Object.hasOwn(options, key)
  )
    throw new Error(usage);
  options[key] = value;
}
if (
  !options.input ||
  !options.out ||
  Boolean(options.request) === Boolean(options.report)
)
  throw new Error(usage);
const source = await loadSource(options.input),
  reference = options.reference ? await loadSource(options.reference) : null;
const names = ["sensitivity.js", "sensitivity-service.js", "engine.js"],
  parts = await Promise.all(
    names.map((name) =>
      readFile(new URL("../web/" + name, import.meta.url), "utf8"),
    ),
  ),
  digest = (v) => createHash("sha256").update(v).digest("hex");
const code = {
  sha256: digest(parts.join("\n")),
  files: names.map((name, i) => ({ name, sha256: digest(parts[i]) })),
};
const input = JSON.parse(
  await readFile(options.request ?? options.report, "utf8"),
);
let document = null;
if (options.request) {
  const decoded = await decodeRecipeInput(input.baseline_recipe);
  input.baseline_recipe = decoded.recipe;
  document = decoded.document;
}
const report = await (
  options.request ? sensitivityReport : verifySensitivityReport
)(input, source, reference, await engineIdentity(source.format), code);
const out = resolve(options.out);
await mkdir(out);
const entries = {
  ...(document
    ? { "input-recipe-document.json": JSON.stringify(document, null, 2) + "\n" }
    : {}),
  ...sensitivityEntries(report),
  "sensitivity.tar": sensitivityBundle(report),
};
for (const [name, value] of Object.entries(entries))
  await writeFile(resolve(out, name), value, { flag: "wx" });
console.log(
  JSON.stringify({
    out,
    status: report.status,
    report_sha256: report.report_sha256,
    variants: report.variants.map(({ id, status, error }) => ({
      id,
      status,
      error,
    })),
  }),
);
