import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadSource, engineIdentity } from "./io.mjs";
import {
  registrationRecipe,
  registrationBundle,
  registrationReadme,
} from "../web/registration-service.js";
const usage =
  "Usage: node scripts/register.mjs --fixed-recipe PATH --moving-recipe PATH --fixed PATH --moving PATH [--fixed-reference PATH --moving-reference PATH] --out NEWDIR [--mode manual --tx NUMBER --ty NUMBER --interpolation nearest|bilinear | --mode automatic --radius-x INT --radius-y INT --min-overlap-fraction NUMBER]";
const args = process.argv.slice(2),
  options = {};
const allowed = [
  "fixed-recipe",
  "moving-recipe",
  "fixed",
  "moving",
  "fixed-reference",
  "moving-reference",
  "out",
  "mode",
  "tx",
  "ty",
  "interpolation",
  "radius-x",
  "radius-y",
  "min-overlap-fraction",
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
  !["fixed-recipe", "moving-recipe", "fixed", "moving", "out"].every((key) =>
    Object.hasOwn(options, key),
  )
)
  throw new Error(usage);
const parameters = { mode: options.mode ?? "manual" };
if (!["manual", "automatic"].includes(parameters.mode)) throw new Error(usage);
const manual = ["tx", "ty", "interpolation"],
  automatic = ["radius-x", "radius-y", "min-overlap-fraction"];
if (
  (parameters.mode === "manual" ? automatic : manual).some((key) =>
    Object.hasOwn(options, key),
  )
)
  throw new Error("Do not mix manual and automatic registration parameters.");
for (const key of parameters.mode === "manual" ? manual : automatic)
  if (Object.hasOwn(options, key))
    parameters[key.replaceAll("-", "_")] =
      key === "interpolation" ? options[key] : Number(options[key]);
const fixedRecipe = JSON.parse(await readFile(options["fixed-recipe"], "utf8")),
  movingRecipe = JSON.parse(await readFile(options["moving-recipe"], "utf8"));
const fixed = await loadSource(options.fixed),
  moving = await loadSource(options.moving);
const fixedReference = options["fixed-reference"]
    ? await loadSource(options["fixed-reference"])
    : null,
  movingReference = options["moving-reference"]
    ? await loadSource(options["moving-reference"])
    : null;
const names = ["registration.js", "registration-service.js", "engine.js"],
  parts = await Promise.all(
    names.map((name) =>
      readFile(new URL("../web/" + name, import.meta.url), "utf8"),
    ),
  );
const digest = (value) => createHash("sha256").update(value).digest("hex");
const code = {
  sha256: digest(parts.join("\n")),
  files: names.map((name, i) => ({ name, sha256: digest(parts[i]) })),
};
const result = await registrationRecipe(
  { fixed_recipe: fixedRecipe, moving_recipe: movingRecipe, parameters },
  fixed,
  moving,
  fixedReference,
  movingReference,
  {
    fixed: await engineIdentity(fixed.format),
    moving: await engineIdentity(moving.format),
  },
  code,
);
const out = resolve(options.out);
await mkdir(out);
const entries = {
  "report.json": JSON.stringify(result.report, null, 2) + "\n",
  "fixed-recipe.json": JSON.stringify(fixedRecipe, null, 2) + "\n",
  "moving-recipe.json": JSON.stringify(movingRecipe, null, 2) + "\n",
  "README.txt": registrationReadme(),
  "registration.tar": registrationBundle(result),
};
for (const [key, metadata] of Object.entries(result.report.arrays))
  entries[metadata.file] = result.rasters[key];
for (const [name, bytes] of Object.entries(entries))
  await writeFile(resolve(out, name), bytes, { flag: "wx" });
console.log(
  JSON.stringify({
    out,
    report_sha256: result.report.report_sha256,
    transform: result.report.transform,
    metrics: result.report.metrics,
  }),
);
