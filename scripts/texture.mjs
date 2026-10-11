import { decodeRecipeInput } from "../web/recipe-interchange.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadSource, engineIdentity } from "./io.mjs";
import {
  textureRecipe,
  textureBundle,
  textureReadme,
} from "../web/texture-service.js";
const usage =
  "Usage: node scripts/texture.mjs --recipe PATH --input PATH [--reference PATH] --out DIR [--detrend none|mean|plane --window boxcar|hann]";
const args = process.argv.slice(2),
  options = {};
while (args.length) {
  const flag = args.shift(),
    value = args.shift(),
    key = flag?.slice(2);
  if (
    !flag?.startsWith("--") ||
    !["recipe", "input", "reference", "out", "detrend", "window"].includes(
      key,
    ) ||
    value === undefined ||
    value.startsWith("--") ||
    Object.hasOwn(options, key)
  )
    throw new Error(usage);
  options[key] = value;
}
if (!["recipe", "input", "out"].every((key) => Object.hasOwn(options, key)))
  throw new Error(usage);
const parameters = {};
for (const key of ["detrend", "window"])
  if (options[key] !== undefined) parameters[key] = options[key];
const { recipe, document } = await decodeRecipeInput(
    JSON.parse(await readFile(options.recipe, "utf8")),
  ),
  source = await loadSource(options.input),
  reference = options.reference ? await loadSource(options.reference) : null;
const names = ["fft.js", "texture.js", "texture-service.js", "engine.js"];
const parts = await Promise.all(
  names.map((name) =>
    readFile(new URL("../web/" + name, import.meta.url), "utf8"),
  ),
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const code = {
  sha256: digest(parts.join("\n")),
  files: names.map((name, i) => ({ name, sha256: digest(parts[i]) })),
};
const result = await textureRecipe(
  { recipe, parameters },
  source,
  reference,
  await engineIdentity(source.format),
  code,
);
const out = resolve(options.out);
await mkdir(out);
const entries = {
  ...(document
    ? { "input-recipe-document.json": JSON.stringify(document, null, 2) + "\n" }
    : {}),
  "report.json": JSON.stringify(result.report, null, 2) + "\n",
  "input-recipe.json":
    JSON.stringify(result.report.input_recipe, null, 2) + "\n",
  "README.txt": textureReadme(result.report),
  "texture.tar": textureBundle(result),
};
for (const [key, metadata] of Object.entries(result.report.arrays))
  if (metadata !== null) entries[metadata.file] = result.rasters[key];
for (const [name, bytes] of Object.entries(entries))
  await writeFile(resolve(out, name), bytes, { flag: "wx" });
console.log(
  JSON.stringify({
    out,
    report_sha256: result.report.report_sha256,
    arrays: result.report.arrays,
  }),
);
