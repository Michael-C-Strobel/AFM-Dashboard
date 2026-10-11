import { replay } from "./service.js";
import { segmentSurface } from "./segmentation.js";
import { sha256 } from "./engine.js";

const files = ["segmentation.js", "segmentation-service.js", "engine.js"];
const hash = /^[a-f0-9]{64}$/;
function finiteJSON(value, ancestors = new Set(), depth = 0) {
  if (depth > 64)
    throw new Error("Segmentation JSON nesting exceeds 64 levels.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    throw new Error("Segmentation provenance requires finite plain JSON.");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && keys.length !== value.length + 1)
    throw new Error("Segmentation JSON requires dense ordinary arrays.");
  for (const key of keys) {
    if (typeof key === "symbol")
      throw new Error("Segmentation JSON cannot contain symbol keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value"))
      throw new Error("Segmentation JSON cannot contain accessors.");
    if (!descriptor.enumerable && !(Array.isArray(value) && key === "length"))
      throw new Error("Segmentation JSON cannot contain hidden properties.");
    if (
      Array.isArray(value) &&
      key !== "length" &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
    )
      throw new Error("Segmentation JSON requires ordinary array indices.");
    finiteJSON(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

/** Strictly replay a saved analysis before measuring threshold-connected regions. */
export async function segmentRecipe(
  request,
  source,
  reference,
  engineIdentity,
  codeIdentity,
) {
  finiteJSON(request);
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).length !== 2 ||
    !Object.hasOwn(request, "recipe") ||
    !Object.hasOwn(request, "parameters")
  )
    throw new Error(
      "Segmentation request must contain only recipe and parameters.",
    );
  const { recipe, parameters } = request;
  finiteJSON(codeIdentity);
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    Object.hasOwn(parameters, "selection")
  )
    throw new Error(
      "Segmentation selection is fixed by the input recipe; overrides are forbidden.",
    );
  if (
    !codeIdentity ||
    !hash.test(codeIdentity.sha256 ?? "") ||
    !Array.isArray(codeIdentity.files) ||
    codeIdentity.files.length !== files.length ||
    codeIdentity.files.some(
      (file, i) => file.name !== files[i] || !hash.test(file.sha256 ?? ""),
    )
  )
    throw new Error("Invalid segmentation code identity or file order.");
  const inputRecipe = structuredClone(recipe);
  const code = structuredClone(codeIdentity);
  const options = structuredClone(parameters);
  const replayed = await replay(inputRecipe, source, reference, engineIdentity);
  if (
    inputRecipe.source.channel !== String(replayed.channel.id) ||
    inputRecipe.source.title !== replayed.channel.title
  )
    throw new Error(
      "Recipe source channel or title differs from replayed channel.",
    );
  const [height, width] = replayed.channel.shape;
  const channel = {
    ...replayed.channel,
    width,
    height,
    data: Float64Array.from(replayed.data.flat(), (value) =>
      value === null ? NaN : value,
    ),
    mask: null,
  };
  const { labels, ...report } = segmentSurface(channel, {
    ...options,
    selection: inputRecipe.selection,
  });
  if (!(labels instanceof Uint32Array) || labels.length !== width * height)
    throw new Error("Invalid segmentation label raster.");
  const bytes = new Uint8Array(labels.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < labels.length; i++)
    view.setUint32(i * 4, labels[i], true);
  const warnings = [
    ...new Set([
      ...(replayed.warnings ?? []),
      ...(replayed.channel.warnings ?? []),
      ...(source.warnings ?? []),
      ...(report.warnings ?? []),
    ]),
  ];
  const support = replayed.channel.metadata?.["Import / support"];
  if (support !== undefined)
    warnings.push(
      `Imported support status: ${typeof support === "string" ? support : JSON.stringify(support)}. Replay does not certify calibration.`,
    );
  const document = {
    schema_version: 1,
    kind: "segmentation",
    input_recipe: inputRecipe,
    code,
    parameters: report.parameters,
    report,
    labels_sha256: await sha256(bytes),
    warnings: [...new Set(warnings)],
  };
  finiteJSON(document);
  const reportHash = await sha256(
    new TextEncoder().encode(JSON.stringify(document)),
  );
  return { ...document, labels: Array.from(labels), report_sha256: reportHash };
}
