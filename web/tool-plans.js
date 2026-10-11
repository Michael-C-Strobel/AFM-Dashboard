/** Explicit bounded plans over typed local tools; no expressions or inferred execution. */
import { validateToolCall } from "./tool-contracts.js";
import { sha256 } from "./engine.js";
const MAX_BYTES = 1048576,
  ARTIFACT = /^artifact:[0-9a-f]{64}$/,
  STEP = /^[a-z][a-z0-9_-]{0,31}(?![\s\S])/;

function snapshotJSON(root) {
  const ancestors = new WeakSet();
  let nodes = 0;
  function copy(value, depth) {
    if (depth > 64 || ++nodes > MAX_BYTES)
      throw new Error("Plan JSON exceeds depth or resource limits.");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null)
      throw new Error("Expected plain finite JSON.");
    const isArray = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (
      isArray
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    )
      throw new Error("Expected plain JSON objects and arrays.");
    if (ancestors.has(value))
      throw new Error("Cyclic plan JSON is not supported.");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value),
      result = isArray ? [] : {};
    if (isArray && keys.length !== value.length + 1)
      throw new Error(
        "Sparse arrays and extra array properties are not allowed.",
      );
    for (const key of keys) {
      if (isArray && key === "length") continue;
      if (
        typeof key !== "string" ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        throw new Error("Forbidden prototype or symbol key.");
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key))
        throw new Error("Invalid array property.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error("Accessors and hidden properties are not allowed.");
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return result;
  }
  return copy(root, 0);
}
function fields(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`Unknown ${label} field: ${key}`);
  for (const key of required)
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required.`);
}
function text(value, min, max, label) {
  if (
    typeof value !== "string" ||
    [...value].length < min ||
    [...value].length > max
  )
    throw new Error(`Invalid ${label}.`);
}
function references(value, path = [], found = []) {
  if (typeof value === "string" && value.startsWith("$step:"))
    found.push({ path, value });
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      references(item, [...path, key], found);
  return found;
}

export function validatePlan(raw) {
  const plan = snapshotJSON(raw);
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > MAX_BYTES)
    throw new Error("Plan exceeds 1048576 UTF-8 bytes.");
  fields(
    plan,
    ["schema_version", "title", "steps"],
    ["schema_version", "title", "steps"],
    "plan",
  );
  if (plan.schema_version !== 1) throw new Error("Unsupported plan schema.");
  text(plan.title, 1, 160, "plan title");
  if (
    !Array.isArray(plan.steps) ||
    plan.steps.length < 1 ||
    plan.steps.length > 16
  )
    throw new Error("A plan needs 1–16 steps.");
  const ids = new Set(),
    steps = [];
  for (const step of plan.steps) {
    fields(step, ["id", "rationale", "call"], ["id", "call"], "step");
    if (
      typeof step.id !== "string" ||
      step.id.length > 32 ||
      !STEP.test(step.id) ||
      ids.has(step.id)
    )
      throw new Error("Step IDs must be unique lowercase identifiers.");
    const rationale = Object.hasOwn(step, "rationale") ? step.rationale : "";
    text(rationale, 0, 2000, "step rationale");
    const call = step.call,
      allowed = [
        "replay_recipe",
        "segment_surface",
        "measure_texture",
        "analyze_sensitivity",
      ].includes(call?.name)
        ? "recipe_artifact"
        : call?.name === "get_artifact"
          ? "artifact_id"
          : null;
    const tokens = references(call);
    let token = null;
    for (const found of tokens) {
      if (
        !allowed ||
        found.path.length !== 2 ||
        found.path[0] !== "arguments" ||
        found.path[1] !== allowed
      )
        throw new Error(
          "Step references are allowed only in recipe_artifact or artifact_id.",
        );
      const target = found.value.slice(6);
      if (!STEP.test(target) || !ids.has(target))
        throw new Error("Step references must identify an earlier step.");
      token = found.value;
      call.arguments[allowed] = "artifact:" + "0".repeat(64);
    }
    const normalized = validateToolCall(call);
    if (token) normalized.arguments[allowed] = token;
    steps.push({ id: step.id, rationale, call: normalized });
    ids.add(step.id);
  }
  return { schema_version: 1, title: plan.title, steps };
}

function envelope(raw) {
  const result = snapshotJSON(raw);
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !result.record ||
    typeof result.record !== "object" ||
    Array.isArray(result.record) ||
    !["succeeded", "failed"].includes(result.record.status)
  )
    throw new Error("Malformed tool execution record.");
  if (!Object.hasOwn(result, "artifact"))
    throw new Error("Tool execution must include artifact or null.");
  if (
    result.artifact !== null &&
    (typeof result.artifact !== "object" ||
      Array.isArray(result.artifact) ||
      typeof result.artifact.id !== "string" ||
      result.artifact.id.length !== 73 ||
      !ARTIFACT.test(result.artifact.id))
  )
    throw new Error("Malformed tool artifact identifier.");
  if (
    (result.record.status === "succeeded" && result.artifact === null) ||
    (result.record.status === "failed" && result.artifact !== null)
  )
    throw new Error("Tool execution status and artifact are inconsistent.");
  return result;
}
const message = (error) => {
  try {
    if (typeof error === "string") return error;
    if (typeof error?.message === "string") return error.message;
    return JSON.stringify(error) ?? "Tool execution failed.";
  } catch {
    return "Tool execution failed; thrown error could not be serialized.";
  }
};

export async function runPlan(
  raw,
  { execute, onUpdate = () => {}, shouldCancel = () => false },
) {
  const plan = validatePlan(raw);
  if (
    typeof execute !== "function" ||
    typeof onUpdate !== "function" ||
    typeof shouldCancel !== "function"
  )
    throw new Error("Invalid plan callbacks.");
  const manifest = {
    schema_version: 1,
    plan,
    plan_sha256: await sha256(new TextEncoder().encode(JSON.stringify(plan))),
    status: "running",
    steps: plan.steps.map((step) => ({ id: step.id, status: "pending" })),
  };
  const update = () => onUpdate(structuredClone(manifest));
  const stop = (index, status) => {
    for (const step of manifest.steps.slice(index)) step.status = "not_run";
    manifest.status = status;
  };
  await update();
  for (let i = 0; i < plan.steps.length; i++) {
    if (shouldCancel()) {
      stop(i, "canceled");
      await update();
      return structuredClone(manifest);
    }
    const step = manifest.steps[i];
    step.status = "running";
    await update();
    try {
      const call = structuredClone(plan.steps[i].call);
      for (const found of references(call)) {
        const previous = manifest.steps.find(
          (s) => s.id === found.value.slice(6),
        );
        const id = previous?.result?.artifact?.id;
        if (!id)
          throw new Error(
            `Prior step ${previous?.id ?? found.value} did not produce an artifact.`,
          );
        call.arguments[found.path[1]] = id;
      }
      step.resolved_call = validateToolCall(call);
      const result = envelope(
        await execute(structuredClone(step.resolved_call)),
      );
      step.result = result;
      if (result.record.status === "failed")
        throw new Error(
          message(result.record.error ?? "Tool execution failed."),
        );
      step.status = "complete";
    } catch (error) {
      step.status = "failed";
      step.error = message(error);
      stop(i + 1, "failed");
      await update();
      return structuredClone(manifest);
    }
    if (i === plan.steps.length - 1) manifest.status = "complete";
    await update();
  }
  return structuredClone(manifest);
}
