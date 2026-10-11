import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { parseMeasurement } from "../web/formats.js";
import { engineSources } from "../web/identity.js";
import { sha256 } from "../web/engine.js";
import { exportBundle } from "../web/archive.js";
export async function loadSource(path) {
  if ((await stat(path)).size > 512 * 1024 * 1024)
    throw new Error("CLI input limit is 512 MiB.");
  const bytes = await readFile(path);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return { ...parseMeasurement(buffer), sha256: await sha256(buffer) };
}
export async function engineIdentity(format = "GWYP") {
  const parts = await Promise.all(
    engineSources(format).map((name) =>
      readFile(new URL("../web/" + name, import.meta.url), "utf8"),
    ),
  );
  return sha256(new TextEncoder().encode(parts.join("\n")));
}
export async function saveResult(result, out) {
  await mkdir(out, { recursive: true });
  await writeFile(
    resolve(out, "recipe.json"),
    JSON.stringify(result.recipe, null, 2) + "\n",
  );
  await writeFile(
    resolve(out, "analysis.json"),
    JSON.stringify(
      {
        channel: result.channel,
        warnings: result.warnings,
        statistics: result.statistics,
        history: result.history,
        step: result.step,
        quality: result.quality,
        comparison: result.comparison
          ? Object.fromEntries(
              Object.entries(result.comparison).filter(
                ([k]) => !["data", "target"].includes(k),
              ),
            )
          : null,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(resolve(out, "analysis.tar"), await exportBundle(result));
}
export function sourcePath(dir, name) {
  if (
    typeof name !== "string" ||
    basename(name) !== name ||
    name.includes("\\")
  )
    throw new Error(
      "Recipe sources must be basenames; use --data-dir to locate them.",
    );
  return resolve(dir, name);
}
