import { summarizeChannel } from "./gwy.js";
import {
  ENGINE_VERSION,
  SCHEMA_VERSION,
  runPipeline,
  normalizeSelection,
  profile,
  compare,
  arrayHash,
  geometry,
  sha256,
  stepHeight,
} from "./engine.js";
export const AUTOMATIC_PRESET = [
  { name: "robust_plane", params: { iterations: 5, sigma: 3 } },
  { name: "zero_min", params: {} },
];
export const CHEMIST_PRESET = [
  {
    name: "three_point",
    params: {
      points: [],
      radius: 1,
    },
  },
  { name: "zero_min", params: {} },
];
function matrix(data, width, mask = null) {
  const out = [];
  for (let i = 0; i < data.length; i += width)
    out.push(
      Array.from(data.subarray(i, i + width), (v, j) =>
        Number.isFinite(v) && !mask?.[i + j] ? v : null,
      ),
    );
  return out;
}
function alignedOriginal(source, c) {
  const dx = source.xreal / source.width,
    dy = source.yreal / source.height,
    x0 = Math.round((c.xoff - source.xoff) / dx),
    y0 = Math.round((c.yoff - source.yoff) / dy),
    a = new Float64Array(c.data.length),
    mask = source.mask ? new Uint8Array(a.length) : null;
  for (let y = 0; y < c.height; y++) {
    a.set(
      source.data.subarray(
        (y + y0) * source.width + x0,
        (y + y0) * source.width + x0 + c.width,
      ),
      y * c.width,
    );
    if (mask)
      mask.set(
        source.mask.subarray(
          (y + y0) * source.width + x0,
          (y + y0) * source.width + x0 + c.width,
        ),
        y * c.width,
      );
  }
  return matrix(a, c.width, mask);
}
export async function analyze(
  request,
  source,
  reference = null,
  engineIdentity = "unverified-development",
) {
  const channel = source.channels[String(request.channel)];
  if (!channel) throw new Error("Channel not found.");
  const selection = normalizeSelection(request.selection),
    result = runPipeline(channel, request.operations ?? [], selection),
    c = result.channel;
  let comparison = null;
  if (request.reference) {
    const target = reference?.channels[String(request.reference.channel)];
    if (!target) throw new Error("Reference channel not found.");
    const cp = compare(c, target, selection);
    comparison = {
      ...cp,
      data: matrix(cp.data, c.width),
      target: matrix(target.data, c.width, target.mask),
    };
  }
  const step = request.plateaus
    ? stepHeight(c, request.plateaus, selection)
    : null;
  const trace = request.profile ? profile(c, request.profile, selection) : null;
  let parentId = source.sha256 + ":" + channel.id;
  for (const step of result.history) {
    step.parent_id = parentId;
    step.artifact_id = await sha256(
      new TextEncoder().encode(
        JSON.stringify({
          parent: parentId,
          operation: step.name,
          params: step.params,
          selection: step.selection ?? selection,
          engine: engineIdentity,
        }),
      ),
    );
    parentId = step.artifact_id;
  }
  const outputHash = await arrayHash(c.data),
    maskHash = c.mask ? await arrayHash(Float64Array.from(c.mask)) : null;
  const measurementHash = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        statistics: result.statistics,
        profile: trace,
        step,
        comparison: comparison
          ? Object.fromEntries(
              Object.entries(comparison).filter(
                ([key]) => !["data", "target"].includes(key),
              ),
            )
          : null,
      }),
    ),
  );
  const recipe = {
    schema_version: SCHEMA_VERSION,
    engine: {
      name: "afm-dashboard-js",
      version: ENGINE_VERSION,
      sha256: engineIdentity,
    },
    source: {
      file: request.file,
      sha256: source.sha256,
      channel: String(channel.id),
      title: channel.title,
      geometry: geometry(channel),
    },
    operations: result.history.map(
      ({ name, params, selection: operationSelection }) => ({
        name,
        params,
        ...(operationSelection !== undefined
          ? { selection: operationSelection }
          : {}),
      }),
    ),
    selection,
    profile: request.profile ?? null,
    plateaus: request.plateaus ?? null,
    reference: request.reference
      ? {
          ...request.reference,
          channel: String(request.reference.channel),
          sha256: reference.sha256,
        }
      : null,
    output: {
      sha256: outputHash,
      mask_sha256: maskHash,
      measurement_sha256: measurementHash,
      geometry: geometry(c),
    },
    environment: {
      runtime:
        globalThis.navigator?.userAgent ??
        `Node ${globalThis.process?.version ?? "unknown"}`,
    },
    created_at: new Date().toISOString(),
    random_seed: null,
  };
  const warnings = [
    ...new Set([...result.warnings, ...(source.warnings ?? [])]),
  ];
  if (source.unsupported?.length)
    warnings.push(
      `${source.unsupported.length} stored fields are retained in the input but not interpreted by this viewer; see channel metadata for the list.`,
    );
  return {
    ...result,
    channel: {
      ...summarizeChannel(c),
      unsupported_fields: source.unsupported ?? [],
    },
    source: { file: request.file, sha256: source.sha256 },
    data: matrix(c.data, c.width, c.mask),
    original: alignedOriginal(channel, c),
    profile: trace,
    step,
    comparison,
    recipe,
    warnings,
  };
}
export async function replay(
  recipe,
  source,
  reference,
  engineIdentity,
  fileOverride = null,
) {
  if (
    recipe?.schema_version !== SCHEMA_VERSION ||
    recipe.engine?.version !== ENGINE_VERSION ||
    recipe.engine?.sha256 !== engineIdentity
  )
    throw new Error(
      "Recipe schema or analysis engine differs. Use the recorded application version; replay has not been verified.",
    );
  if (source.sha256 !== recipe.source?.sha256)
    throw new Error(
      "Source SHA-256 mismatch. Refusing to replay on a different input.",
    );
  const c = source.channels[String(recipe.source.channel)];
  if (
    !c ||
    JSON.stringify(geometry(c)) !== JSON.stringify(recipe.source.geometry)
  )
    throw new Error("Source channel calibration mismatch.");
  if (recipe.reference && recipe.reference.sha256 !== reference?.sha256)
    throw new Error("Reference SHA-256 mismatch.");
  const result = await analyze(
    {
      file: fileOverride ?? recipe.source.file,
      channel: recipe.source.channel,
      operations: recipe.operations,
      selection: recipe.selection,
      profile: recipe.profile,
      plateaus: recipe.plateaus,
      reference: recipe.reference,
    },
    source,
    reference,
    engineIdentity,
  );
  if (
    result.recipe.output.sha256 !== recipe.output?.sha256 ||
    result.recipe.output.mask_sha256 !== recipe.output?.mask_sha256 ||
    result.recipe.output.measurement_sha256 !==
      recipe.output?.measurement_sha256 ||
    JSON.stringify(result.recipe.output.geometry) !==
      JSON.stringify(recipe.output?.geometry)
  )
    throw new Error(
      "Replay output differs from the saved hash. Cross-engine numerical differences are not silently accepted.",
    );
  result.replay_verified = true;
  return result;
}
