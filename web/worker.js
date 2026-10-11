import { parseMeasurement, summarizeChannel } from "./formats.js";
import { engineSources } from "./identity.js";
import { sha256, operationRegistry } from "./engine.js";
import { analyze, replay } from "./service.js";
import { exportBundle } from "./archive.js";
import { makeBatchRequest } from "./batch.js";
import { toolCatalog } from "./tool-contracts.js";
import { createToolSession } from "./tool-session.js";
import { qualityReport, findTracePairs } from "./quality.js";
const sources = new Map();
let total = 0;
const identities = new Map();
function identityFor(format) {
  if (!identities.has(format))
    identities.set(
      format,
      Promise.all(
        engineSources(format).map((name) =>
          fetch(new URL(name, import.meta.url)).then((response) => {
            if (!response.ok) throw new Error("Cannot identify analysis code");
            return response.text();
          }),
        ),
      ).then((parts) => sha256(new TextEncoder().encode(parts.join("\n")))),
    );
  return identities.get(format);
}
let qualityIdentity;
function identifyQuality() {
  return (qualityIdentity ??= (async () => {
    const files = await Promise.all(
      ["quality.js", "engine.js"].map(async (name) => {
        const response = await fetch(new URL(name, import.meta.url));
        if (!response.ok) throw new Error("Cannot identify diagnostic code");
        return { name, text: await response.text() };
      }),
    );
    const digest = (text) => sha256(new TextEncoder().encode(text));
    return {
      sha256: await digest(files.map((f) => f.text).join("\n")),
      definition: "SHA-256 of UTF-8 quality.js + newline + engine.js",
      files: await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          sha256: await digest(f.text),
        })),
      ),
    };
  })());
}
const get = (name) => {
  const source = sources.get(name);
  if (!source) throw new Error(`Input not loaded: ${name}`);
  return source;
};
function boundSource(file, expectedHash) {
  const source = get(file);
  if (source.sha256 !== expectedHash)
    throw new Error(
      "Tool source SHA-256 mismatch. Inspect the loaded source before planning analysis.",
    );
  return source;
}
function compactAnalysis(result) {
  return {
    recipe: result.recipe,
    channel: result.channel,
    statistics: result.statistics,
    history: result.history,
    quality: result.quality,
    step: result.step,
    profile: result.profile,
    warnings: result.warnings,
    comparison: result.comparison
      ? Object.fromEntries(
          Object.entries(result.comparison).filter(
            ([key]) => !["data", "target"].includes(key),
          ),
        )
      : null,
    replay_verified: result.replay_verified ?? false,
  };
}
const toolSession = createToolSession({
  invoke: async (name, args) => {
    if (name === "list_sources")
      return {
        sources: [...sources].map(([file, source]) => ({
          file,
          sha256: source.sha256,
          format: source.format,
          support: source.support,
          channels: Object.values(source.channels).map((channel) => ({
            id: String(channel.id),
            title: channel.title,
          })),
          warnings: source.warnings,
        })),
      };
    if (name === "inspect_source") {
      const source = get(args.file);
      return {
        ...(await dispatch("channels", { file: args.file })),
        sha256: source.sha256,
        format: source.format,
        reader_engine_sha256: await identityFor(source.format),
      };
    }
    boundSource(args.file, args.source_sha256);
    if (name === "analyze_surface") {
      if (args.reference)
        boundSource(args.reference.file, args.reference.source_sha256);
      const { source_sha256, ...request } = args;
      request.reference = args.reference
        ? { file: args.reference.file, channel: args.reference.channel }
        : null;
      return compactAnalysis(await dispatch("analyze", request));
    }
    if (name === "check_quality") {
      const { source_sha256, ...request } = args;
      return dispatch("quality", request);
    }
    if (name === "replay_recipe") {
      const saved = toolSession.artifact(args.recipe_artifact);
      const recipe = saved.content.result?.recipe;
      if (!recipe)
        throw new Error("Artifact does not contain an analysis recipe.");
      return compactAnalysis(
        await dispatch("replay", { file: args.file, recipe }),
      );
    }
    throw new Error("Unsupported analysis tool.");
  },
});
async function dispatch(type, payload) {
  if (type === "tools") return toolCatalog();
  if (type === "tool") return toolSession.execute(payload);
  if (type === "tool-journal") return toolSession.journal();
  if (type === "tool-artifact")
    return toolSession.artifact(payload.artifact_id);
  if (type === "import") {
    const { name, buffer } = payload;
    if (buffer.byteLength > 64 * 1024 * 1024)
      throw new Error(
        "Browser imports are limited to 64 MiB per file; use a smaller image export.",
      );
    const digest = await sha256(buffer),
      old = sources.get(name);
    if (old && old.sha256 !== digest)
      throw new Error(
        "A different input with this filename is already loaded. Rename the new file or reload the app.",
      );
    if (old) return { name, sha256: digest };
    if (total + buffer.byteLength > 256 * 1024 * 1024)
      throw new Error(
        "Session input limit is 256 MiB. Reload the page to clear loaded measurements.",
      );
    const parsed = parseMeasurement(buffer);
    sources.set(name, {
      format: parsed.format,
      support: parsed.support,
      channels: parsed.channels,
      unsupported: parsed.unsupported,
      warnings: parsed.warnings,
      sha256: digest,
    });
    total += buffer.byteLength;
    return { name, sha256: digest };
  }
  if (type === "channels") {
    const source = get(payload.file);
    return {
      file: payload.file,
      support: source.support,
      trace_pairs: findTracePairs(source.channels),
      channels: Object.values(source.channels).map(summarizeChannel),
      unsupported: source.unsupported,
      warnings: source.warnings,
    };
  }
  if (type === "registry") return operationRegistry();
  const source = get(
    type === "replay" || type === "segment"
      ? (payload.file ?? payload.recipe?.source?.file)
      : payload.file,
  );
  const engine = await identityFor(source.format);
  if (type === "batch-check" || type === "batch-run") {
    const request = makeBatchRequest(
      payload.template,
      source,
      engine,
      payload.file,
    );
    const channel = source.channels[String(request.channel)];
    const info = {
      file: payload.file,
      source_sha256: source.sha256,
      support: source.support ?? null,
      warnings: [
        ...new Set([...(source.warnings ?? []), ...(channel.warnings ?? [])]),
      ],
    };
    if (type === "batch-check") return { ...info, compatible: true };
    const result = await analyze(request, source, null, engine);
    return {
      ...info,
      warnings: [...new Set([...info.warnings, ...(result.warnings ?? [])])],
      output_sha256: result.recipe.output.sha256,
      recipe: result.recipe,
      statistics: result.statistics,
    };
  }
  if (type === "batch-export") {
    makeBatchRequest(payload.recipe, source, engine, payload.file);
    if (payload.recipe?.reference)
      throw new Error("Batch exports cannot include reference comparisons.");
    const result = await replay(
      payload.recipe,
      source,
      null,
      engine,
      payload.file,
    );
    // Keep the captured run record after independently verifying its numerical replay.
    result.recipe = structuredClone(payload.recipe);
    return exportBundle(result);
  }
  if (type === "segment") {
    const { segmentRecipe } = await import("./segmentation-service.js");
    const files = await Promise.all(
      ["segmentation.js", "segmentation-service.js", "engine.js"].map(
        async (name) => {
          const response = await fetch(new URL(name, import.meta.url));
          if (!response.ok)
            throw new Error("Cannot identify segmentation code.");
          return { name, text: await response.text() };
        },
      ),
    );
    const digest = (text) => sha256(new TextEncoder().encode(text));
    const code = {
      sha256: await digest(files.map((file) => file.text).join("\n")),
      files: await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          sha256: await digest(file.text),
        })),
      ),
    };
    return segmentRecipe(
      payload,
      source,
      payload.recipe?.reference ? get(payload.recipe.reference.file) : null,
      engine,
      code,
    );
  }
  if (type === "quality") {
    const channel = source.channels[payload.channel];
    if (!channel) throw new Error("Input channel not found.");
    const reference =
      payload.reference_channel == null
        ? null
        : source.channels[payload.reference_channel];
    if (payload.reference_channel != null && !reference)
      throw new Error("Reference channel not found.");
    const report = qualityReport(
      channel,
      {
        selection: payload.selection ?? {},
        boundary_sigma: payload.boundary_sigma ?? 6,
      },
      reference,
    );
    const output = {
      schema_version: 1,
      input: {
        file: payload.file,
        sha256: source.sha256,
        channel: String(channel.id),
        channel_title: channel.title,
        format: source.format,
        support: source.support ?? null,
        warnings: [
          ...new Set([...(source.warnings ?? []), ...(channel.warnings ?? [])]),
        ],
        reference_channel: reference ? String(reference.id) : null,
        reference_title: reference?.title ?? null,
        reference_warnings: reference?.warnings ?? [],
      },
      reader_engine_sha256: engine,
      warnings: [...new Set([...(source.warnings ?? []), ...report.warnings])],
      code: await identifyQuality(),
      parameters: report.parameters,
      report,
    };
    JSON.stringify(output, (_key, value) => {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("Nonfinite diagnostic result cannot be exported.");
      return value;
    });
    return output;
  }
  if (type === "replay") {
    const recipe = payload.recipe;
    return replay(
      recipe,
      get(payload.file ?? recipe.source?.file),
      recipe.reference ? get(recipe.reference.file) : null,
      engine,
      payload.file,
    );
  }
  const result = await analyze(
    payload,
    get(payload.file),
    payload.reference ? get(payload.reference.file) : null,
    engine,
  );
  return type === "export" ? exportBundle(result) : result;
}
self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    const result = await dispatch(type, payload);
    self.postMessage(
      { id, result },
      result instanceof Uint8Array ? [result.buffer] : [],
    );
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
