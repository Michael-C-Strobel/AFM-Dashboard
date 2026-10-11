/** Declarative, local tool contracts. Validation never executes a tool. */
import {
  normalizeOperation,
  normalizeSelection,
  operationRegistry,
} from "./engine.js";
export const TOOL_VERSION = "1.0.0";
const LIMIT = 262144;
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const array = (items, minItems, maxItems) => ({
  type: "array",
  items,
  minItems,
  maxItems,
});
const number = { type: "number" };
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const point = array(number, 2, 2),
  bounds = {
    ...array(number, 4, 4),
    description: "[x0,y0,x1,y1], with x0 < x1 and y0 < y1.",
  };
const selection = object({
  roi: nullable(bounds),
  exclude_polygons: array(array(point, 3, 256), 0, 32),
});
const file = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  pattern: "^(?!\\.{1,2}$)[^/\\\\\u0000]+$",
};
const channel = { type: "string", minLength: 1, maxLength: 64 };
const sha = {
  type: "string",
  minLength: 64,
  maxLength: 64,
  pattern: "^[0-9a-f]{64}$",
};
const artifact = {
  type: "string",
  minLength: 73,
  maxLength: 73,
  pattern: "^artifact:[0-9a-f]{64}$",
};
const descriptions = {
  mean: "Subtract the selected arithmetic mean.",
  plane: "Subtract a least-squares plane fitted to selected valid pixels.",
  zero_min: "Subtract the selected minimum.",
  polynomial: "Subtract a degree-two surface fitted to selected valid pixels.",
  robust_plane:
    "Fit and subtract a plane using iterative robust residual rejection.",
  three_point:
    "Subtract a plane defined by three physical points and sampling neighborhoods.",
  line_median: "Correct row or column medians; may remove physical structure.",
  line_match:
    "Correct adjacent row or column offsets; may remove physical structure.",
  line_polynomial:
    "Subtract independent degree 0–3 least-squares row or column fits. Empty fit lines remain unchanged; partially populated underdetermined lines reject. May remove real structure.",
  gaussian: "Apply normalized Gaussian smoothing in pixel coordinates.",
  crop: "Crop to pixel centers within physical bounds.",
};
const parameterSchemas = {
  mean: object({}),
  plane: object({}),
  zero_min: object({}),
  polynomial: object({ degree: { type: "integer", const: 2, default: 2 } }),
  robust_plane: object({
    iterations: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    sigma: { type: "number", minimum: 1, maximum: 10, default: 3 },
  }),
  three_point: object(
    {
      points: array(point, 3, 3),
      radius: { type: "integer", minimum: 1, maximum: 20, default: 1 },
    },
    ["points"],
  ),
  line_median: object({
    axis: { type: "string", enum: ["rows", "columns"], default: "rows" },
  }),
  line_match: object({
    axis: { type: "string", enum: ["rows", "columns"], default: "rows" },
  }),
  line_polynomial: object({
    axis: { type: "string", enum: ["rows", "columns"], default: "rows" },
    degree: { type: "integer", minimum: 0, maximum: 3, default: 1 },
  }),
  gaussian: object({
    sigma: { type: "number", exclusiveMinimum: 0, maximum: 10, default: 1 },
  }),
  crop: object({ bounds }, ["bounds"]),
};
const operationSchema = {
  oneOf: operationRegistry().map(({ name }) =>
    object(
      {
        name: { const: name },
        selection,
        params: ["crop", "three_point"].includes(name)
          ? parameterSchemas[name]
          : nullable(parameterSchemas[name]),
      },
      ["name", ...(["crop", "three_point"].includes(name) ? ["params"] : [])],
    ),
  ),
};
const identity = { file, source_sha256: sha, channel };
const schemas = {
  list_sources: object({}),
  inspect_source: object({ file }, ["file"]),
  analyze_surface: object(
    {
      ...identity,
      operations: array(operationSchema, 0, 32),
      selection,
      profile: nullable(array(point, 2, 2)),
      plateaus: nullable(array(bounds, 2, 2)),
      reference: nullable(
        object(identity, ["file", "source_sha256", "channel"]),
      ),
    },
    ["file", "source_sha256", "channel", "operations"],
  ),
  check_quality: object(
    {
      ...identity,
      selection,
      boundary_sigma: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: 100,
        default: 6,
      },
      reference_channel: nullable(channel),
    },
    ["file", "source_sha256", "channel"],
  ),
  segment_surface: object(
    {
      file,
      source_sha256: sha,
      recipe_artifact: artifact,
      parameters: object(
        {
          threshold: number,
          direction: {
            type: "string",
            enum: ["above", "below"],
            default: "above",
          },
          connectivity: { type: "integer", enum: [4, 8], default: 4 },
          min_pixels: {
            type: "integer",
            minimum: 1,
            maximum: 4194304,
            default: 1,
          },
          boundary: {
            type: "string",
            enum: ["include", "exclude"],
            default: "include",
          },
        },
        ["threshold"],
      ),
    },
    ["file", "source_sha256", "recipe_artifact", "parameters"],
  ),
  measure_texture: object(
    {
      file,
      source_sha256: sha,
      recipe_artifact: artifact,
      parameters: object({
        detrend: {
          type: "string",
          enum: ["none", "mean", "plane"],
          default: "mean",
        },
        window: { type: "string", enum: ["boxcar", "hann"], default: "boxcar" },
      }),
    },
    ["file", "source_sha256", "recipe_artifact", "parameters"],
  ),
  analyze_sensitivity: object(
    {
      file,
      source_sha256: sha,
      recipe_artifact: artifact,
      variants: array(
        object(
          {
            id: {
              type: "string",
              minLength: 1,
              maxLength: 32,
              pattern: "^[a-z][a-z0-9_-]{0,31}$",
            },
            label: { type: "string", minLength: 1, maxLength: 120 },
            operations: array(operationSchema, 0, 32),
            selection,
          },
          ["id", "label", "operations", "selection"],
        ),
        1,
        16,
      ),
      assumptions: object(
        {
          calibration_note: { type: "string", maxLength: 2000 },
          model_note: { type: "string", maxLength: 2000 },
        },
        ["calibration_note", "model_note"],
      ),
    },
    ["file", "source_sha256", "recipe_artifact", "variants", "assumptions"],
  ),
  replay_recipe: object(
    { file, source_sha256: sha, recipe_artifact: artifact },
    ["file", "source_sha256", "recipe_artifact"],
  ),
  get_artifact: object({ artifact_id: artifact }, ["artifact_id"]),
};
const toolDescriptions = {
  list_sources: "List loaded sources and their import support status.",
  inspect_source:
    "Inspect channels and calibration metadata of a loaded source.",
  analyze_surface:
    "Run an explicit reproducible surface-analysis recipe on a hash-bound source.",
  check_quality:
    "Report acquisition diagnostics without repairing or aligning data.",
  segment_surface:
    "Strictly replay a prior analysis artifact, then measure user-reviewed threshold components; returns metadata and label hash, not a particle or defect classification.",
  measure_texture:
    "Strictly replay a prior analysis artifact and measure spatial PSD and ACF on its saved selection; returns compact evidence and raster hashes without selection overrides.",
  analyze_sensitivity:
    "Compare explicit processing/selection alternatives on a source-bound prior analysis, preserving every recipe and failure. Variation ranges are not measurement uncertainty.",
  replay_recipe: "Replay a saved recipe artifact against a hash-bound source.",
  get_artifact:
    "Retrieve an existing immutable artifact by its content identifier.",
};

export function toolCatalog() {
  return structuredClone({
    version: TOOL_VERSION,
    limits: { max_operations: 32, max_argument_bytes: LIMIT },
    tools: Object.entries(schemas).map(([name, input_schema]) => ({
      name,
      description: toolDescriptions[name],
      input_schema,
    })),
    operations: operationRegistry().map((op) => ({
      ...op,
      description: descriptions[op.name],
      parameter_schema: parameterSchemas[op.name],
    })),
  });
}

function assertJSON(root) {
  const ancestors = new WeakSet(),
    stack = [{ value: root }],
    forbidden = new Set(["__proto__", "prototype", "constructor"]);
  let nodes = 0;
  while (stack.length) {
    const { value, leave } = stack.pop();
    if (leave) {
      ancestors.delete(value);
      continue;
    }
    if (++nodes > LIMIT)
      throw new Error("Tool call exceeds JSON resource limits.");
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new Error("Tool arguments must contain finite numbers.");
      continue;
    }
    if (typeof value !== "object")
      throw new Error("Tool arguments must be plain JSON.");
    if (ancestors.has(value))
      throw new Error("Tool arguments must not contain cycles.");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Tool arguments must be plain JSON objects.");
    if (
      Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Array.prototype
    )
      throw new Error("Tool arguments must be plain JSON arrays.");
    ancestors.add(value);
    stack.push({ value, leave: true });
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1)
      throw new Error(
        "Tool arguments must not contain sparse arrays or extra properties.",
      );
    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key !== "string" || forbidden.has(key))
        throw new Error("Forbidden prototype or symbol key in tool arguments.");
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))
        throw new Error("Tool arguments must be plain JSON arrays.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error(
          "Tool arguments must not contain accessors or hidden properties.",
        );
      stack.push({ value: descriptor.value });
    }
  }
}

function check(value, schema, path = "arguments") {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    let valid = 0;
    for (const choice of alternatives) {
      try {
        check(value, choice, path);
        valid++;
      } catch {}
    }
    if (valid === 0 || (schema.oneOf && valid !== 1))
      throw new Error(`${path} does not match an allowed schema.`);
    return;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const)
    throw new Error(`${path} has an invalid constant.`);
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(`${path} is not an allowed value.`);
  if (schema.type === "null") {
    if (value !== null) throw new Error(`${path} must be null.`);
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object.`);
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key))
        throw new Error(`${path}.${key} is required.`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key))
        throw new Error(`Unknown ${path} field: ${key}`);
      check(value[key], schema.properties[key], `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < schema.minItems ||
      value.length > schema.maxItems
    )
      throw new Error(`${path} has an invalid array length.`);
    value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`));
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
    const length = [...value].length;
    if (
      length < (schema.minLength ?? 0) ||
      length > (schema.maxLength ?? Infinity) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      throw new Error(`${path} is an invalid identifier.`);
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity) ||
      (schema.exclusiveMinimum !== undefined &&
        value <= schema.exclusiveMinimum)
    )
      throw new Error(`${path} is outside the allowed numeric range.`);
  }
}

export function validateToolCall(call) {
  assertJSON(call);
  check(
    call,
    object({ name: { type: "string" }, arguments: {} }, ["name", "arguments"]),
  );
  // The outer envelope is checked separately; argument keys use the selected tool schema.
  if (!Object.hasOwn(schemas, call.name))
    throw new Error(`Unknown tool: ${call.name}`);
  const text = JSON.stringify(call.arguments);
  if (new TextEncoder().encode(text).byteLength > LIMIT)
    throw new Error("Tool arguments exceed 262144 UTF-8 bytes.");
  check(call.arguments, schemas[call.name]);
  const args = structuredClone(call.arguments);
  if (call.name === "analyze_surface") {
    args.operations = args.operations.map(normalizeOperation);
    args.selection = normalizeSelection(args.selection ?? {});
    args.profile ??= null;
    args.plateaus ??= null;
    args.reference ??= null;
    if (args.plateaus)
      args.plateaus.forEach((roi) => normalizeSelection({ roi }));
  }
  if (call.name === "check_quality") {
    args.selection = normalizeSelection(args.selection ?? {});
    args.boundary_sigma ??= 6;
    args.reference_channel ??= null;
  }
  if (call.name === "analyze_sensitivity") {
    const ids = new Set();
    for (const variant of args.variants) {
      if (
        variant.id.trim() !== variant.id ||
        variant.id === "baseline" ||
        ids.has(variant.id) ||
        !variant.label.trim()
      )
        throw new Error(
          "Sensitivity variants require unique nonreserved IDs and nonempty labels.",
        );
      ids.add(variant.id);
      variant.operations = variant.operations.map(normalizeOperation);
      variant.selection = normalizeSelection(variant.selection);
    }
  }
  if (call.name === "measure_texture") {
    args.parameters.detrend ??= "mean";
    args.parameters.window ??= "boxcar";
  }
  if (call.name === "segment_surface") {
    args.parameters.direction ??= "above";
    args.parameters.connectivity ??= 4;
    args.parameters.min_pixels ??= 1;
    args.parameters.boundary ??= "include";
  }
  return { name: call.name, arguments: args };
}
