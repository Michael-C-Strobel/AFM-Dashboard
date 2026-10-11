/** Build a deterministic local preview; no publication or measurement redistribution. */
import {
  readFile,
  readdir,
  lstat,
  mkdir,
  writeFile,
  unlink,
  rmdir,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createPreviewFixture, PREVIEW_EXAMPLE } from "./preview-fixture.mjs";
import { parseMeasurement } from "../web/formats.js";
import { engineSources } from "../web/identity.js";
import { analyze } from "../web/service.js";
import { migrateRecipe } from "../web/recipe-interchange.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const runtimeScripts = [
  "afm",
  "check-sop",
  "io",
  "compare",
  "quality",
  "recipe",
  "register",
  "segment",
  "sensitivity",
  "serve",
  "server-policy",
  "texture",
  "verify-preview",
  "preview-fixture",
];
function archive(entries, prefix) {
  const chunks = [];
  for (const name of Object.keys(entries).sort()) {
    const path = prefix + "/" + name;
    if (
      !/^[A-Za-z0-9_.\/-]+$/.test(path) ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      Buffer.byteLength(path) > 99
    )
      throw Error("Unsafe preview archive path.");
    const bytes = entries[name],
      header = Buffer.alloc(512);
    const put = (offset, text) => header.write(text, offset, "ascii");
    put(0, path);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, bytes.length.toString(8).padStart(11, "0") + "\0");
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, "0");
    put(257, "ustar\0");
    put(263, "00");
    put(
      148,
      header
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
    );
    chunks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
async function sourceBytes(path) {
  for (const dir of [dirname(path), path]) {
    const info = await lstat(resolve(root, dir));
    if (info.isSymbolicLink() || (dir === path && !info.isFile()))
      throw Error("Preview inputs must be regular files: " + path);
  }
  return readFile(resolve(root, path));
}
function readme(version) {
  return `# AFM Dashboard ${version} — local preview

This preview contains application code and one generated mathematical surface. It contains no laboratory or downloaded instrument measurements. Project licensing has not been selected; this is a local evaluation artifact, not a licensed public release. See NOTICE.txt and SUPPORTED_INPUTS.md.

## Start and verify

Node.js 20 or newer is required for the local server and CLI. No npm install, build step or runtime dependencies are needed.

\`\`\`sh
node scripts/verify-preview.mjs
node scripts/serve.mjs
\`\`\`

Open http://127.0.0.1:4173/web/ . Choose another PORT if 4173 is occupied. The server binds only loopback. AFM_LIVE_RELOAD=1 enables refresh after web edits; refreshing clears browser session analyses. Do not edit files before checking the package manifest: verification detects missing, changed or added files and symlinks.

## Reproduce the example

The browser opens synthetic-step.gwy, channel 0, automatically. Its 16×16 pixels cover 8×8 µm. Values follow z=1 nm × (x + 2y + 5 when x>=8), with zero-based pixel indices. The original mean is 25 nm and range 0–50 nm. It is not an instrument acquisition or evidence of instrument compatibility.

Load recipes/synthetic-step-v2.json using **Load recipe** to verify the saved mean subtraction, or run:

\`\`\`sh
node scripts/recipe.mjs verify --recipe recipes/synthetic-step-v2.json --input data/synthetic-step.gwy
node scripts/afm.mjs replay recipes/synthetic-step.json --data-dir data --out ../preview-analysis
\`\`\`

Write analysis outputs outside this package to keep its manifest verifiable. Fixture recipe timestamps and runtime labels are fixed producer metadata for repeatable packaging, not laboratory execution timestamps. Raw data and numerical engine modules are unmodified. Save your own recipes and matching inputs/application version for later replay.

## Available workflows

View calibrated channels, support warnings, original/processed maps and selections; perform explicit leveling, line correction, crop/filter, roughness, profiles and steps. Capture processed surfaces for segmentation, PSD/autocorrelation, translation registration or processing sensitivity. Export results and replay recipes; batch applies compatible choices to new inputs. The chemist-specific preset remains disabled without its exact original input hash.

The local Assistant prepares typed-tool plans and verifies artifact/journal evidence. Reviewed planning requires explicit validation and Run reviewed plan. Separately, Start goal authorizes automatic planning and execution on selected channels within the chosen round/tool bounds; Pause and Stop act between local tools. Autonomous follow-up requests include verified compact surface claims and quality, segmentation, texture or sensitivity observations from eligible recorded results. Reviewed planning sends surface evidence only after explicit selection. Raw arrays, full recipes, profiles and region tables remain local. Recorded results do not certify scientific goal achievement.

The tool-free Help agent answers interface questions using the built-in guide and pilot SOPs, without selected measurements. Optional model modes require explicit AFM_MODEL_ORIGIN configuration, a compatible endpoint and browser CORS. Keys stay in session memory and are excluded from exported audits. Provider tests use mocks; live-provider behavior is not certified. No model provider is required for the viewer or local analysis.

## Preview limits

Only documented image subsets are supported. Unsupported formats reject; readable unvalidated instrument configurations retain warnings. Force spectroscopy, generic TIFF, rotation/deformation registration, calibrated uncertainty and automatic material identification are not implemented. Large images can still pause display; original measurements and source/version hashes remain essential for scientific interpretation.

preview-manifest.json lists packaged file SHA-256 hashes and engine identities. The accompanying archive checksum detects changes; neither it nor this manifest authenticates an author. Public distribution requires maintainer license selection and hosted CI validation. The synthetic example does not grant rights to application code or any external measurement data.
`;
}
export async function packagePreview(out) {
  const metadata = JSON.parse(await sourceBytes("package.json"));
  const version = metadata.version;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)
  )
    throw Error("Invalid preview version.");
  const prefix = `afm-dashboard-${version}-preview`,
    entries = Object.create(null);
  for (const name of (await readdir(resolve(root, "web"))).sort()) {
    if (/^[A-Za-z0-9_.-]+\.(?:js|css|html|png)$/.test(name))
      entries["web/" + name] = await sourceBytes("web/" + name);
  }
  for (const name of runtimeScripts)
    entries[`scripts/${name}.mjs`] = await sourceBytes(`scripts/${name}.mjs`);
  entries["package.json"] = json({
    name: metadata.name,
    version,
    private: true,
    type: "module",
    description: "AFM Dashboard local preview with generated example",
    scripts: {
      dev: "node scripts/serve.mjs",
      verify: "node scripts/verify-preview.mjs",
    },
    engines: { node: ">=20" },
  });
  entries["README.md"] = Buffer.from(readme(version));
  entries["NOTICE.txt"] = Buffer.from(
    "Local preview only. Project license selection is pending. This package is not a public licensed release. Measurement content is a generated mathematical demonstration; original laboratory and downloaded instrument files are excluded. No license grant or redistribution approval is inferred.\nReviewed plans require explicit execution; Start goal separately authorizes bounded automatic analysis on selected sources. Optional model modes use session-only keys and have mock-provider validation only. Compact selected-source claims/diagnostic observations may be transmitted; raw arrays stay local. The help agent has no analysis tools or selected measurement context.\n",
  );
  const supported = (await sourceBytes("docs/supported-inputs.md"))
    .toString("utf8")
    .replace(
      /^See \[NanoScope limitations\].*$/m,
      "Detailed importer evidence remains in the development repository. This preview includes the same explicit format/configuration gates; the synthetic example does not independently validate an instrument.",
    );
  entries["SUPPORTED_INPUTS.md"] = Buffer.from(supported);
  entries["RELEASE_NOTES.md"] = Buffer.from(
    `# ${version} local preview\n\nBuildless HTML/JavaScript viewer with calibrated image imports, explicit processing, derived measurements, strict replay and portable recipes. Includes explicit reviewed multi-source planning, separately authorized bounded autonomous goals, and tool-free interface help. Autonomous next rounds receive verified compact surface claims and quality/segmentation/texture/sensitivity observations; reviewed evidence remains opt-in. Raw arrays, full recipes, profiles and region tables stay local. Provider keys are session-only and omitted from audits; provider tests use mocks, not certified live-provider behavior.\n\nThis package adds a generated example, deterministic archive, file/engine manifest and read-only clean-install verification. Application engine source is copied byte-for-byte. No raw laboratory/external measurements, credentials, node_modules or developer caches are included.\n\nPublic release is pending project licensing and hosted CI. Manual assistive-technology review and documented large-image responsiveness limitations remain open. No scientific accuracy or blanket instrument-compatibility certification is implied.\n`,
  );
  const fixture = createPreviewFixture();
  entries["data/" + PREVIEW_EXAMPLE.file] = fixture;
  entries["data/manifest.json"] = json({
    files: [{ name: PREVIEW_EXAMPLE.file, size: fixture.length }],
  });
  const identities = Object.fromEntries(
    ["GWYP", "NANOSCOPE", "IGOR_IBW", "JPK_TIFF"].map((format) => [
      format,
      digest(
        Buffer.from(
          engineSources(format)
            .map((name) => entries["web/" + name].toString("utf8"))
            .join("\n"),
        ),
      ),
    ]),
  );
  const buffer = fixture.buffer.slice(
    fixture.byteOffset,
    fixture.byteOffset + fixture.byteLength,
  );
  const source = { ...parseMeasurement(buffer), sha256: digest(fixture) };
  const analysis = await analyze(
    {
      file: PREVIEW_EXAMPLE.file,
      channel: "0",
      operations: [{ name: "mean", params: {} }],
    },
    source,
    null,
    identities.GWYP,
  );
  analysis.recipe.created_at = "2000-01-01T00:00:00.000Z";
  analysis.recipe.environment = { runtime: "afm-preview-fixture-v1" };
  entries["recipes/synthetic-step.json"] = json(analysis.recipe);
  entries["recipes/synthetic-step-v2.json"] = json(
    await migrateRecipe(analysis.recipe, source, null, identities.GWYP),
  );
  const manifest = {
    kind: "afm_local_preview",
    schema_version: 1,
    version,
    distribution_status: "local-preview",
    license_status: "not-selected",
    files: Object.keys(entries)
      .sort()
      .map((path) => ({
        path,
        size: entries[path].length,
        sha256: digest(entries[path]),
      })),
    engine_sha256: identities,
    example: {
      source: "data/synthetic-step.gwy",
      recipe: "recipes/synthetic-step.json",
      portable_recipe: "recipes/synthetic-step-v2.json",
      expected: {
        shape: [16, 16],
        mean: 25e-9,
        min: 0,
        max: 50e-9,
        area: 64e-12,
      },
    },
  };
  entries["preview-manifest.json"] = json(manifest);
  const bytes = archive(entries, prefix),
    name = prefix + ".tar",
    sha256 = digest(bytes);
  out = resolve(out);
  await mkdir(out); // Exclusive destination; never merge into an existing directory.
  try {
    await writeFile(join(out, name), bytes, { flag: "wx" });
    await writeFile(join(out, name + ".sha256"), `${sha256}  ${name}\n`, {
      flag: "wx",
    });
  } catch (error) {
    for (const file of [name, name + ".sha256"])
      await unlink(join(out, file)).catch(() => {});
    await rmdir(out).catch(() => {});
    throw error;
  }
  return {
    archive: join(out, name),
    sha256,
    version,
    files: manifest.files.length,
    distribution_status: manifest.distribution_status,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 4 || process.argv[2] !== "--out")
    throw Error(
      "Usage: node scripts/package-preview.mjs --out NEW_DIRECTORY (parent must exist)",
    );
  console.log(JSON.stringify(await packagePreview(process.argv[3])));
}
