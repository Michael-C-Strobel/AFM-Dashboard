/** AFM JSON v1 sorts UTF-16 object keys; this is not an RFC canonicalization claim. */
import { normalizeOperation, normalizeSelection, sha256 } from "./engine.js";
import { replay } from "./service.js";
const LIMIT = 1048576,
  encoder = new TextEncoder();
function inspect(value, depth = 0, ancestors = new Set()) {
  if (depth > 64) throw new Error("Recipe JSON depth exceeds 64.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (
    !value ||
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new Error("Recipe requires finite plain JSON.");
  if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error("Recipe JSON requires plain arrays.");
  const array = Array.isArray(value),
    keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== "string"))
    throw new Error("Recipe JSON cannot contain symbols.");
  if (
    array &&
    (keys.length !== value.length + 1 ||
      keys.some(
        (k) =>
          k !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= value.length),
      ))
  )
    throw new Error("Recipe JSON arrays must be dense and unextended.");
  ancestors.add(value);
  const parts = [];
  for (const key of array
    ? Array.from({ length: value.length }, (_, i) => String(i))
    : keys.sort()) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d.enumerable || !Object.hasOwn(d, "value"))
      throw new Error(
        "Recipe JSON cannot contain accessors or non-JSON descriptors.",
      );
    const text = inspect(d.value, depth + 1, ancestors);
    parts.push(array ? text : JSON.stringify(key) + ":" + text);
  }
  ancestors.delete(value);
  const text = (array ? "[" : "{") + parts.join(",") + (array ? "]" : "}");
  if (text.length > LIMIT) throw new Error("Recipe JSON exceeds 1 MiB.");
  return text;
}
export function canonicalRecipeJSON(value) {
  const text = inspect(value);
  if (encoder.encode(text).length > LIMIT)
    throw new Error("Recipe JSON exceeds 1 MiB.");
  return text;
}
function snapshot(value) {
  canonicalRecipeJSON(value);
  return structuredClone(value);
}
function exact(value, keys, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new Error(name + " has missing or unknown fields.");
}
function hash(value) {
  if (
    typeof value !== "string" ||
    value.length !== 64 ||
    !/^[a-f0-9]+$/.test(value)
  )
    throw new Error("Expected lowercase SHA-256.");
  return value;
}
function string(value, name, nonempty = false) {
  if (typeof value !== "string" || (nonempty && !value.length))
    throw new Error("Invalid " + name + ".");
  return value;
}
function file(value) {
  string(value, "filename", true);
  if (/[\\/\0]/.test(value) || value === "." || value === "..")
    throw new Error("Expected a basename filename.");
  return value;
}
function geometry(g) {
  exact(
    g,
    ["shape", "xreal", "yreal", "xoff", "yoff", "xy_unit", "z_unit"],
    "Geometry",
  );
  if (
    !Array.isArray(g.shape) ||
    g.shape.length !== 2 ||
    !g.shape.every((n) => Number.isSafeInteger(n) && n > 0) ||
    g.xreal <= 0 ||
    g.yreal <= 0 ||
    !["xreal", "yreal", "xoff", "yoff"].every((k) => Number.isFinite(g[k]))
  )
    throw new Error("Invalid geometry calibration.");
  for (const k of ["xy_unit", "z_unit"])
    if (g[k] !== null) string(g[k], "unit");
  return {
    shape: g.shape.slice(),
    xreal: g.xreal,
    yreal: g.yreal,
    xoff: g.xoff,
    yoff: g.yoff,
    xy_unit: g.xy_unit,
    z_unit: g.z_unit,
  };
}
function point(p) {
  if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))
    throw new Error("Invalid profile point.");
}
function rectangle(r) {
  if (r === null) return;
  if (
    !Array.isArray(r) ||
    r.length !== 4 ||
    !r.every(Number.isFinite) ||
    r[0] >= r[2] ||
    r[1] >= r[3]
  )
    throw new Error("Invalid plateau bounds.");
}
function timestamp(value) {
  string(value, "created_at");
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || match[0] !== value || !Number.isFinite(Date.parse(value)))
    throw new Error("Invalid ISO timestamp.");
  const [, year, month, day, hour, minute, second, zone] = match;
  const leap =
      Number(year) % 4 === 0 &&
      (Number(year) % 100 !== 0 || Number(year) % 400 === 0),
    days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    +month < 1 ||
    +month > 12 ||
    +day < 1 ||
    +day > days[+month - 1] ||
    +hour > 23 ||
    +minute > 59 ||
    +second > 59 ||
    (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))
  )
    throw new Error("Invalid ISO timestamp.");
  return value;
}
export function normalizeLegacyRecipe(value) {
  const r = snapshot(value);
  exact(
    r,
    [
      "schema_version",
      "engine",
      "source",
      "operations",
      "selection",
      "profile",
      "plateaus",
      "reference",
      "output",
      "environment",
      "created_at",
      "random_seed",
    ],
    "Recipe",
  );
  if (r.schema_version !== 1) throw new Error("Unsupported recipe schema.");
  exact(r.engine, ["name", "version", "sha256"], "Engine");
  if (r.engine.name !== "afm-dashboard-js" || r.engine.version !== "0.1.0")
    throw new Error("Unsupported recipe engine.");
  const engine = {
    name: r.engine.name,
    version: r.engine.version,
    sha256: hash(r.engine.sha256),
  };
  exact(r.source, ["file", "sha256", "channel", "title", "geometry"], "Source");
  const source = {
    file: file(r.source.file),
    sha256: hash(r.source.sha256),
    channel: string(r.source.channel, "channel", true),
    title: string(r.source.title, "title"),
    geometry: geometry(r.source.geometry),
  };
  if (!Array.isArray(r.operations) || r.operations.length > 32)
    throw new Error("Expected at most 32 operations.");
  const operations = r.operations.map((op) => {
    exact(op, ["name", "params"], "Operation");
    const normalized = normalizeOperation(op);
    if (canonicalRecipeJSON(op) !== canonicalRecipeJSON(normalized))
      throw new Error(
        "Operation parameters must be complete without injected defaults.",
      );
    return normalized;
  });
  exact(r.selection, ["roi", "exclude_polygons"], "Selection");
  const selection = normalizeSelection(r.selection);
  if (canonicalRecipeJSON(selection) !== canonicalRecipeJSON(r.selection))
    throw new Error("Selection must be complete without injected defaults.");
  if (r.profile !== null) {
    if (!Array.isArray(r.profile) || r.profile.length !== 2)
      throw new Error("Expected two profile points.");
    r.profile.forEach(point);
  }
  if (r.plateaus !== null) {
    if (!Array.isArray(r.plateaus) || r.plateaus.length !== 2)
      throw new Error("Expected two plateau bounds.");
    r.plateaus.forEach(rectangle);
  }
  let reference = null;
  if (r.reference !== null) {
    exact(r.reference, ["file", "channel", "sha256"], "Reference");
    reference = {
      file: file(r.reference.file),
      channel: string(r.reference.channel, "reference channel", true),
      sha256: hash(r.reference.sha256),
    };
  }
  exact(
    r.output,
    ["sha256", "mask_sha256", "measurement_sha256", "geometry"],
    "Output",
  );
  const output = {
    sha256: hash(r.output.sha256),
    mask_sha256:
      r.output.mask_sha256 === null ? null : hash(r.output.mask_sha256),
    measurement_sha256: hash(r.output.measurement_sha256),
    geometry: geometry(r.output.geometry),
  };
  exact(r.environment, ["runtime"], "Environment");
  string(r.environment.runtime, "runtime");
  if (r.random_seed !== null)
    throw new Error("Recipe random_seed must be null.");
  return {
    schema_version: 1,
    engine,
    source,
    operations,
    selection,
    profile: r.profile,
    plateaus: r.plateaus,
    reference,
    output,
    environment: { runtime: r.environment.runtime },
    created_at: timestamp(r.created_at),
    random_seed: null,
  };
}
const digest = (value) => sha256(encoder.encode(canonicalRecipeJSON(value)));
export async function decodeRecipeInput(value) {
  const input = snapshot(value);
  if (input?.schema_version === 1 && !Object.hasOwn(input, "kind"))
    return { recipe: input, document: null };
  exact(
    input,
    [
      "kind",
      "schema_version",
      "canonicalization",
      "recipe",
      "recipe_sha256",
      "document_sha256",
    ],
    "Recipe document",
  );
  if (
    input.kind !== "afm_recipe_document" ||
    input.schema_version !== 2 ||
    input.canonicalization !== "afm-json-v1"
  )
    throw new Error("Unsupported recipe document.");
  hash(input.recipe_sha256);
  hash(input.document_sha256);
  const recipe = normalizeLegacyRecipe(input.recipe),
    { document_sha256, ...unsigned } = input;
  if ((await digest(input.recipe)) !== input.recipe_sha256)
    throw new Error("Recipe checksum mismatch.");
  if ((await digest(unsigned)) !== document_sha256)
    throw new Error("Document checksum mismatch.");
  return { recipe, document: input };
}
function bind(recipe, source) {
  if (recipe.engine.name !== "afm-dashboard-js")
    throw new Error("Recipe engine name mismatch.");
  const channel = source?.channels?.[recipe.source.channel];
  if (!channel || channel.title !== recipe.source.title)
    throw new Error("Source channel title mismatch.");
}
export async function migrateRecipe(value, source, reference, engineIdentity) {
  const recipe = normalizeLegacyRecipe(value),
    savedSource = structuredClone(source),
    savedReference = reference == null ? null : structuredClone(reference);
  bind(recipe, savedSource);
  await replay(recipe, savedSource, savedReference, engineIdentity);
  const unsigned = {
    kind: "afm_recipe_document",
    schema_version: 2,
    canonicalization: "afm-json-v1",
    recipe,
    recipe_sha256: await digest(recipe),
  };
  const document = { ...unsigned, document_sha256: await digest(unsigned) };
  canonicalRecipeJSON(document);
  return document;
}
export async function replayRecipeInput(
  value,
  source,
  reference,
  engineIdentity,
  fileOverride = null,
) {
  const input = snapshot(value),
    savedSource = structuredClone(source),
    savedReference = reference == null ? null : structuredClone(reference);
  const { recipe, document } = await decodeRecipeInput(input);
  if (!document)
    return replay(
      recipe,
      savedSource,
      savedReference,
      engineIdentity,
      fileOverride,
    );
  bind(recipe, savedSource);
  if (fileOverride !== null && fileOverride !== recipe.source.file)
    throw new Error(
      "Portable recipe filename override differs from saved source.",
    );
  const result = await replay(
    recipe,
    savedSource,
    savedReference,
    engineIdentity,
  );
  result.recipe = recipe;
  result.interchange = {
    schema_version: 2,
    document_sha256: document.document_sha256,
    recipe_sha256: document.recipe_sha256,
  };
  return result;
}
