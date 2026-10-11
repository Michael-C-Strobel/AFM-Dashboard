import { validateToolCall, TOOL_VERSION } from "./tool-contracts.js";
import { sha256 } from "./engine.js";

const TOOL_NAMES = new Set([
  "list_sources",
  "inspect_source",
  "analyze_surface",
  "check_quality",
  "replay_recipe",
  "get_artifact",
]);
const CREDENTIAL_KEY =
  /^(?:api[_-]?key|authorization|password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|credentials)$/i;
const encoder = new TextEncoder();
const clone = (value) => structuredClone(value);

// Validate before serialization: JSON.stringify alone silently drops or coerces values.
export function canonicalJSON(
  value,
  ancestors = new Set(),
  depth = 0,
  maxDepth = 64,
) {
  if (depth > maxDepth)
    throw new Error("Tool result exceeds the JSON depth limit");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== "object" || value === null)
    throw new Error("Tool result must contain only finite plain JSON values");
  if (ancestors.has(value)) throw new Error("Tool result contains a cycle");
  const array = Array.isArray(value);
  if (
    !array &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Tool result must contain only finite plain JSON values");
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error("Tool result contains symbol properties");
  const names = Object.getOwnPropertyNames(value);
  if (
    array &&
    (names.length !== value.length + 1 ||
      names.some((k) => k !== "length" && !/^(0|[1-9][0-9]*)$/.test(k)))
  )
    throw new Error("Tool result contains a sparse or extended array");
  const keys = array
    ? Array.from({ length: value.length }, (_, i) => String(i))
    : names.sort();
  const parts = [];
  ancestors.add(value);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        throw new Error("Tool result contains non-JSON property descriptors");
      if (!array && CREDENTIAL_KEY.test(key))
        throw new Error("Tool result contains a prohibited credential field");
      const text = canonicalJSON(
        descriptor.value,
        ancestors,
        depth + 1,
        maxDepth,
      );
      parts.push(array ? text : JSON.stringify(key) + ":" + text);
    }
  } finally {
    ancestors.delete(value);
  }
  return array ? "[" + parts.join(",") + "]" : "{" + parts.join(",") + "}";
}
function invalidName(raw) {
  try {
    const descriptor = raw && Object.getOwnPropertyDescriptor(raw, "name");
    return descriptor && TOOL_NAMES.has(descriptor.value)
      ? descriptor.value
      : "invalid";
  } catch {
    return "invalid";
  }
}
function safeError(error) {
  let message = "Tool invocation failed";
  try {
    if (typeof error?.message === "string")
      message = error.message.slice(0, 1024);
  } catch {
    /* Hostile thrown objects are not journal data. */
  }
  if (
    /(?:bearer\s|api[_-]?key|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization)/i.test(
      message,
    )
  )
    return "Tool invocation failed; sensitive error details omitted";
  return message;
}

export function createToolSession({
  invoke,
  now = () => new Date().toISOString(),
  maxCalls = 256,
  maxArtifactBytes = 32 * 1024 * 1024,
} = {}) {
  if (typeof invoke !== "function")
    throw new TypeError("invoke must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 0 ||
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes < 0
  )
    throw new RangeError("Session budgets must be nonnegative safe integers");
  let queue = Promise.resolve(),
    accepted = 0,
    head = null,
    artifactBytes = 0;
  const records = [],
    artifacts = new Map();
  function timestamp() {
    try {
      const value = now();
      if (typeof value === "string" && value.length <= 128) return value;
    } catch {
      /* Timestamp failure must not prevent journaling. */
    }
    return "unavailable";
  }
  function artifact(id) {
    if (!artifacts.has(id)) throw new Error("Artifact not found");
    return clone(artifacts.get(id));
  }
  async function perform(call, invalid) {
    const record = {
      sequence: records.length + 1,
      tool_version: TOOL_VERSION,
      call: clone(call),
      started_at: timestamp(),
    };
    let candidate = null,
      candidateBytes = 0,
      failure = null;
    try {
      if (invalid) throw new Error("Invalid tool call");
      const result =
        call.name === "get_artifact"
          ? artifact(call.arguments.artifact_id)
          : await invoke(call.name, clone(call.arguments));
      // Validate canonically for hashing, but preserve recipe key order for legacy replay.
      canonicalJSON(result);
      const content = {
        tool_version: TOOL_VERSION,
        call: clone(call),
        result: clone(result),
      };
      const text = canonicalJSON(content, new Set(), 0, 128),
        bytes = encoder.encode(text),
        hash = await sha256(bytes),
        id = "artifact:" + hash;
      candidateBytes = artifacts.has(id) ? 0 : bytes.byteLength;
      if (artifactBytes + candidateBytes > maxArtifactBytes)
        throw new Error("Session artifact byte budget exceeded");
      candidate = { id, sha256: hash, content };
    } catch (error) {
      failure = invalid ? "Invalid tool call" : safeError(error);
    }
    record.finished_at = timestamp();
    record.status = failure === null ? "succeeded" : "failed";
    if (failure === null) record.artifact_id = candidate.id;
    else record.error = failure;
    record.previous_sha256 = head;
    record.sha256 = await sha256(
      encoder.encode(canonicalJSON(record, new Set(), 0, 128)),
    );
    if (candidate && failure === null && !artifacts.has(candidate.id)) {
      artifacts.set(candidate.id, candidate);
      artifactBytes += candidateBytes;
    }
    records.push(record);
    head = record.sha256;
    return {
      record: clone(record),
      artifact: failure === null ? artifact(candidate.id) : null,
    };
  }
  function execute(rawcall) {
    if (accepted >= maxCalls) throw new Error("Session call budget exceeded");
    accepted++;
    let call,
      invalid = false;
    try {
      call = validateToolCall(rawcall);
    } catch {
      call = { name: invalidName(rawcall), arguments: null };
      invalid = true;
    }
    const pending = queue.then(() => perform(call, invalid));
    queue = pending.catch(() => {});
    return pending;
  }
  function journal() {
    return clone({
      schema_version: 1,
      tool_version: TOOL_VERSION,
      records,
      head_sha256: head,
      artifact_count: artifacts.size,
      artifact_bytes: artifactBytes,
    });
  }
  return { execute, journal, artifact };
}
