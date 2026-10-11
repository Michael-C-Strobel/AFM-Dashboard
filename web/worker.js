import { parseMeasurement, summarizeChannel } from "./formats.js";
import { engineSources } from "./identity.js";
import { sha256, operationRegistry } from "./engine.js";
import { analyze, replay } from "./service.js";
import { exportBundle } from "./archive.js";
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
const get = (name) => {
  const source = sources.get(name);
  if (!source) throw new Error(`Input not loaded: ${name}`);
  return source;
};
async function dispatch(type, payload) {
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
      channels: Object.values(source.channels).map(summarizeChannel),
      unsupported: source.unsupported,
      warnings: source.warnings,
    };
  }
  if (type === "registry") return operationRegistry();
  const source = get(
    type === "replay"
      ? (payload.file ?? payload.recipe?.source?.file)
      : payload.file,
  );
  const engine = await identityFor(source.format);
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
