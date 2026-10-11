#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  analyze,
  replay,
  AUTOMATIC_PRESET,
  CHEMIST_PRESET,
} from "../web/service.js";
import { geometry, sha256 } from "../web/engine.js";
import { loadSource, engineIdentity, saveResult, sourcePath } from "./io.mjs";
const usage = `AFM Dashboard — headless local analysis

node scripts/afm.mjs analyze INPUT.gwy --preset automatic|chemist|none --channel 0 --out artifacts/run [--reference TARGET.gwy]
node scripts/afm.mjs replay RECIPE.json --data-dir data --out artifacts/replay
node scripts/afm.mjs batch RECIPE.json INPUT.gwy ... --out artifacts/batch [--resume]

Batch reuses explicit operations on compatible inputs and records NEW recipes; it is not hash-verified replay of the original input. Ctrl-C cancels between files. Browser UI and CLI use the same JavaScript engine.
`;
const [command, ...args] = process.argv.slice(2),
  opts = {},
  pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--resume") {
    opts.resume = true;
    continue;
  }
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    if (
      !["preset", "channel", "out", "reference", "data-dir"].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error("Invalid CLI option: " + args[i]);
    opts[key] = args[++i];
  } else pos.push(args[i]);
}
async function writeCheckpoint(path, value) {
  await writeFile(path + ".tmp", value);
  await rename(path + ".tmp", path);
}
let canceled = false;
process.on("SIGINT", () => {
  canceled = true;
  console.error("Cancellation requested; stopping after the current file.");
});
try {
  if (!command || command === "--help") {
    console.log(usage);
    process.exit(0);
  }
  const identities = Object.fromEntries(
    await Promise.all(
      ["GWYP", "NANOSCOPE", "IGOR_IBW", "JPK_TIFF"].map(async (format) => [
        format,
        await engineIdentity(format),
      ]),
    ),
  );
  const identityFor = (source) => identities[source.format];
  if (command === "analyze") {
    if (pos.length !== 1 || !opts.out) throw new Error(usage);
    const presets = {
        automatic: AUTOMATIC_PRESET,
        chemist: CHEMIST_PRESET,
        none: [],
      },
      preset = opts.preset ?? "none";
    if (!Object.hasOwn(presets, preset)) throw new Error("Unknown preset.");
    const source = await loadSource(pos[0]),
      channel = opts.channel ?? "0";
    if (
      preset === "chemist" &&
      (source.sha256 !==
        "ea0287a8afbed275d2d780f31508f89bd937796ab357f5a7d9389152e27abaab" ||
        channel !== "0")
    )
      throw new Error(
        "Chemist preset is specific to the identified raw height-trace channel.",
      );
    const reference = opts.reference ? await loadSource(opts.reference) : null;
    const result = await analyze(
      {
        file: basename(pos[0]),
        channel,
        operations: presets[preset],
        reference: reference
          ? { file: basename(opts.reference), channel }
          : null,
      },
      source,
      reference,
      identityFor(source),
    );
    await saveResult(result, opts.out);
    console.log(
      JSON.stringify(
        {
          out: opts.out,
          support: source.support,
          warnings: result.warnings,
          statistics: result.statistics,
          output_sha256: result.recipe.output.sha256,
        },
        null,
        2,
      ),
    );
  } else if (command === "replay") {
    if (pos.length !== 1 || !opts.out) throw new Error(usage);
    const recipe = JSON.parse(await readFile(pos[0], "utf8")),
      dir = opts["data-dir"] ?? "data",
      source = await loadSource(sourcePath(dir, recipe.source.file)),
      reference = recipe.reference
        ? await loadSource(sourcePath(dir, recipe.reference.file))
        : null;
    const result = await replay(recipe, source, reference, identityFor(source));
    await saveResult(result, opts.out);
    for (const warning of result.warnings ?? [])
      console.error("Warning: " + warning);
    console.log(
      "Replay verified: source, engine, output, and mask hashes match. " +
        opts.out,
    );
  } else if (command === "batch") {
    if (pos.length < 2 || !opts.out) throw new Error(usage);
    const recipe = JSON.parse(await readFile(pos[0], "utf8"));
    if (!Object.values(identities).includes(recipe.engine?.sha256))
      throw new Error(
        "Batch template uses a different engine. Regenerate it first.",
      );
    await mkdir(opts.out, { recursive: true });
    const checkpoint = resolve(opts.out, "batch.json");
    let previous = {};
    if (opts.resume) {
      try {
        previous = JSON.parse(await readFile(checkpoint, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const templateHash = await sha256(
        new TextEncoder().encode(JSON.stringify(recipe)),
      ),
      records = [];
    for (const input of pos.slice(1)) {
      if (canceled) break;
      const record = { file: input, status: "pending" };
      records.push(record);
      try {
        const source = await loadSource(input),
          channel = source.channels[String(recipe.source.channel)];
        if (
          identityFor(source) !== recipe.engine.sha256 ||
          !channel ||
          channel.title !== recipe.source.title ||
          JSON.stringify(geometry(channel)) !==
            JSON.stringify(recipe.source.geometry)
        )
          throw new Error(
            "Channel geometry/units differ from template. Review selections and create a compatible recipe.",
          );
        const out = resolve(
          opts.out,
          basename(input).replace(/[^\w.-]/g, "_") +
            "-" +
            source.sha256.slice(0, 12),
        );
        const old =
          previous.template_sha256 === templateHash
            ? previous.records?.find(
                (x) =>
                  x.source_sha256 === source.sha256 && x.status === "complete",
              )
            : null;
        if (opts.resume && old) {
          try {
            const saved = JSON.parse(
              await readFile(resolve(out, "recipe.json"), "utf8"),
            );
            for (const key of [
              "operations",
              "selection",
              "profile",
              "plateaus",
            ]) {
              if (
                JSON.stringify(saved[key] ?? null) !==
                JSON.stringify(recipe[key] ?? null)
              )
                throw new Error("Saved batch recipe differs from template.");
            }
            const verified = await replay(
              saved,
              source,
              null,
              identityFor(source),
            );
            await saveResult(verified, out);
            Object.assign(record, {
              status: "complete",
              resumed: true,
              out,
              source_sha256: source.sha256,
            });
          } catch {
            /* regenerate incomplete or invalid checkpoint */
          }
        }
        if (record.status !== "complete") {
          const result = await analyze(
            {
              file: basename(input),
              channel: recipe.source.channel,
              operations: recipe.operations,
              selection: recipe.selection,
              profile: recipe.profile,
              plateaus: recipe.plateaus,
            },
            source,
            null,
            identityFor(source),
          );
          await saveResult(result, out);
          Object.assign(record, {
            status: "complete",
            out,
            source_sha256: source.sha256,
            output_sha256: result.recipe.output.sha256,
            support: source.support,
            warnings: result.warnings,
          });
        }
      } catch (error) {
        Object.assign(record, { status: "failed", error: error.message });
      }
      await writeCheckpoint(
        checkpoint,
        JSON.stringify(
          { template_sha256: templateHash, canceled, records },
          null,
          2,
        ) + "\n",
      );
      console.log(
        record.status +
          ": " +
          input +
          (record.error ? " — " + record.error : ""),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await writeCheckpoint(
      checkpoint,
      JSON.stringify(
        {
          template_sha256: templateHash,
          canceled,
          records,
          unprocessed: pos.slice(1 + records.length),
        },
        null,
        2,
      ) + "\n",
    );
    if (canceled) process.exitCode = 130;
    else if (records.some((r) => r.status === "failed")) process.exitCode = 1;
  } else throw new Error(usage);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
