import { readFile, writeFile } from "node:fs/promises";
import { loadSource, engineIdentity } from "./io.mjs";
import {
  decodeRecipeInput,
  migrateRecipe,
  replayRecipeInput,
} from "../web/recipe-interchange.js";
const usage =
  "Usage: node scripts/recipe.mjs migrate|verify --recipe PATH --input PATH [--reference PATH] [--out NEWFILE (migrate only)]";
const [command, ...args] = process.argv.slice(2),
  options = {};
if (!["migrate", "verify"].includes(command)) throw new Error(usage);
while (args.length) {
  const flag = args.shift(),
    value = args.shift(),
    key = flag?.slice(2);
  if (
    !flag?.startsWith("--") ||
    !["recipe", "input", "reference", "out"].includes(key) ||
    !value ||
    value.startsWith("--") ||
    Object.hasOwn(options, key)
  )
    throw new Error(usage);
  options[key] = value;
}
if (
  !options.recipe ||
  !options.input ||
  (command === "migrate" ? !options.out : options.out !== undefined)
)
  throw new Error(usage);
const input = JSON.parse(await readFile(options.recipe, "utf8"));
const decoded = await decodeRecipeInput(input);
const source = await loadSource(options.input),
  reference = options.reference ? await loadSource(options.reference) : null,
  identity = await engineIdentity(source.format);
if (command === "migrate") {
  const document = await migrateRecipe(
    decoded.recipe,
    source,
    reference,
    identity,
  );
  await writeFile(options.out, JSON.stringify(document, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      verified: true,
      out: options.out,
      schema_version: 2,
      source_sha256: document.recipe.source.sha256,
      engine_sha256: document.recipe.engine.sha256,
      output_sha256: document.recipe.output.sha256,
      recipe_sha256: document.recipe_sha256,
      document_sha256: document.document_sha256,
    }),
  );
} else {
  const result = await replayRecipeInput(input, source, reference, identity);
  console.log(
    JSON.stringify({
      verified: result.replay_verified,
      schema_version: decoded.document ? 2 : 1,
      source_sha256: result.recipe.source.sha256,
      channel: result.recipe.source.channel,
      engine_sha256: result.recipe.engine.sha256,
      output: result.recipe.output,
      interchange: result.interchange ?? null,
    }),
  );
}
