/** Usage: node scripts/quality.mjs INPUT --channel 0 [--reference-channel 1] --out REPORT.json */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, webcrypto } from "node:crypto";
import { loadSource } from "./io.mjs";
import { qualityReport } from "../web/quality.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const usage =
  "Usage: node scripts/quality.mjs INPUT --channel ID [--reference-channel ID] --out REPORT.json";
const args = process.argv.slice(2),
  input = args.shift(),
  options = {};
if (!input || input.startsWith("--")) throw new Error(usage);
while (args.length) {
  const key = args.shift(),
    value = args.shift();
  if (
    !["--channel", "--reference-channel", "--out"].includes(key) ||
    !value ||
    value.startsWith("--") ||
    Object.hasOwn(options, key)
  )
    throw new Error(usage);
  options[key] = value;
}
if (!options["--channel"] || !options["--out"]) throw new Error(usage);
if (resolve(input) === resolve(options["--out"]))
  throw new Error("Output must not overwrite the source measurement.");
const source = await loadSource(input),
  channel = source.channels[options["--channel"]];
if (!channel) throw new Error("Input channel not found.");
const reference =
  options["--reference-channel"] === undefined
    ? null
    : source.channels[options["--reference-channel"]];
if (options["--reference-channel"] !== undefined && !reference)
  throw new Error("Reference channel not found.");
const parameters = { selection: {}, boundary_sigma: 6 };
const files = await Promise.all(
  ["quality.js", "engine.js"].map(async (name) => ({
    name,
    text: await readFile(new URL("../web/" + name, import.meta.url), "utf8"),
  })),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = qualityReport(channel, parameters, reference);
const output = {
  schema_version: 1,
  input: {
    file: resolve(input),
    sha256: source.sha256,
    channel: String(channel.id),
    reference_channel: reference ? String(reference.id) : null,
  },
  code: {
    sha256: digest(files.map((f) => f.text).join("\n")),
    definition: "SHA-256 of UTF-8 quality.js + newline + engine.js",
    files: files.map((f) => ({ name: f.name, sha256: digest(f.text) })),
  },
  parameters: report.parameters,
  report,
};
const text =
  JSON.stringify(
    output,
    (_key, value) => {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("Nonfinite diagnostic result cannot be exported.");
      return value;
    },
    2,
  ) + "\n";
// Exclusive creation also protects source files reached through symlinks or hardlinks.
await writeFile(options["--out"], text, { flag: "wx" });
console.log(`Wrote quality diagnostics to ${options["--out"]}`);
