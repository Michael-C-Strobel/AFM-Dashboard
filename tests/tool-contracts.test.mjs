import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_VERSION,
  toolCatalog,
  validateToolCall,
} from "../web/tool-contracts.js";
import { operationRegistry, normalizeOperation } from "../web/engine.js";
const identity = {
  file: "example.gwy",
  source_sha256: "a".repeat(64),
  channel: "0",
};
const call = (name, args) => validateToolCall({ name, arguments: args });
const analyze = (extra = {}) =>
  call("analyze_surface", { ...identity, operations: [], ...extra });

test("catalog is plain detached data with complete registry parity and strict input schemas", () => {
  const c = toolCatalog();
  assert.equal(c.version, TOOL_VERSION);
  assert.equal(c.limits.max_operations, 32);
  assert.equal(c.limits.max_argument_bytes, 262144);
  assert.deepEqual(
    c.operations.map(({ name, version, defaults }) => ({
      name,
      version,
      defaults,
    })),
    operationRegistry(),
  );
  for (const tool of c.tools) {
    assert.equal(tool.input_schema.additionalProperties, false);
    assert.ok(tool.description);
  }
  assert.doesNotThrow(() => JSON.stringify(c));
  c.operations.find((o) => o.name === "gaussian").defaults.sigma = 9;
  c.tools[0].input_schema.properties.bad = {};
  assert.equal(
    toolCatalog().operations.find((o) => o.name === "gaussian").defaults.sigma,
    1,
  );
  assert.deepEqual(toolCatalog().tools[0].input_schema.properties, {});
});

test("all six tools accept bounded inputs and normalize optional fields", () => {
  assert.deepEqual(call("list_sources", {}), {
    name: "list_sources",
    arguments: {},
  });
  assert.equal(
    call("inspect_source", { file: "input.unknown" }).arguments.file,
    "input.unknown",
  );
  const a = analyze().arguments;
  assert.deepEqual(a.selection, { roi: null, exclude_polygons: [] });
  assert.equal(a.profile, null);
  assert.equal(a.plateaus, null);
  assert.equal(a.reference, null);
  const q = call("check_quality", identity).arguments;
  assert.equal(q.boundary_sigma, 6);
  assert.equal(q.reference_channel, null);
  assert.equal(
    call("replay_recipe", {
      file: "input",
      source_sha256: identity.source_sha256,
      recipe_artifact: "artifact:" + "b".repeat(64),
    }).arguments.recipe_artifact.length,
    73,
  );
  assert.equal(
    call("get_artifact", { artifact_id: "artifact:" + "c".repeat(64) }).name,
    "get_artifact",
  );
});

test("operations use core defaults and preserve valid explicit parameters", () => {
  for (const op of operationRegistry()) {
    const params =
      op.name === "three_point"
        ? {
            points: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
          }
        : op.name === "crop"
          ? { bounds: [0, 0, 1, 1] }
          : {};
    assert.deepEqual(
      analyze({ operations: [{ name: op.name, params }] }).arguments
        .operations[0],
      normalizeOperation({ name: op.name, params }),
    );
  }
  const input = {
    ...identity,
    operations: [{ name: "robust_plane", params: { iterations: 7, sigma: 2 } }],
    profile: [
      [0, 0],
      [1, 1],
    ],
    plateaus: [
      [0, 0, 1, 1],
      [2, 2, 3, 3],
    ],
    reference: { ...identity, file: "ref.gwy" },
  };
  const output = call("analyze_surface", input).arguments;
  output.profile[0][0] = 99;
  output.operations[0].params.sigma = 8;
  assert.equal(input.profile[0][0], 0);
  assert.equal(input.operations[0].params.sigma, 2);
});

test("unknown tools fields and inherited tool names cannot dispatch", () => {
  for (const name of ["eval", "constructor", "toString", "__proto__"])
    assert.throws(() => call(name, {}));
  assert.throws(() =>
    validateToolCall({ name: "list_sources", arguments: {}, extra: 1 }),
  );
  assert.throws(() => call("list_sources", { code: "alert(1)" }));
  assert.throws(() => analyze({ unexpected: 1 }));
  assert.throws(() => analyze({ reference: { ...identity, extra: 1 } }));
  assert.throws(() =>
    analyze({ operations: [{ name: "mean", params: { rogue: 1 } }] }),
  );
});

test("prototype keys cycles exotic values accessors and nonfinite data are rejected before serialization", () => {
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    undefined,
    1n,
    () => {},
    new Date(),
    new Float64Array(2),
  ])
    assert.throws(() => call("inspect_source", { file: value }));
  for (const key of ["__proto__", "constructor", "prototype"])
    assert.throws(() =>
      call("inspect_source", JSON.parse(`{"file":"a","${key}":{}}`)),
    );
  const cyclic = { file: "a" };
  cyclic.loop = cyclic;
  assert.throws(() => call("inspect_source", cyclic));
  let invoked = false;
  const getter = {
    get file() {
      invoked = true;
      return "a";
    },
  };
  assert.throws(() => call("inspect_source", getter));
  assert.equal(invoked, false);
  assert.throws(() => call("inspect_source", Object.create({ file: "a" })));
  const symbol = { file: "a", [Symbol("x")]: 1 };
  assert.throws(() => call("inspect_source", symbol));
  const sparse = Array(2);
  sparse[1] = [0, 0];
  assert.throws(() => analyze({ profile: sparse }));
  assert.throws(() =>
    analyze({
      profile: [
        [0, 0],
        [Infinity, 1],
      ],
    }),
  );
});

test("basenames hashes and artifact identifiers are exact and bounded", () => {
  for (const file of [
    "",
    ".",
    "..",
    "../a",
    "dir/a",
    "dir\\a",
    "a\0b",
    "a".repeat(256),
  ])
    assert.throws(() => call("inspect_source", { file }));
  for (const source_sha256 of [
    "a".repeat(63),
    "A".repeat(64),
    "a".repeat(64) + "\n",
    "z".repeat(64),
  ])
    assert.throws(() => analyze({ source_sha256 }));
  for (const channel of ["", 1, "a".repeat(65)])
    assert.throws(() => analyze({ channel }));
  for (const artifact_id of [
    "a".repeat(64),
    "artifact:" + "A".repeat(64),
    "artifact:" + "a".repeat(64) + "\n",
  ])
    assert.throws(() => call("get_artifact", { artifact_id }));
});

test("operation ranges match core constraints and reject too many operations", () => {
  for (const op of [
    { name: "robust_plane", params: { iterations: 21 } },
    { name: "robust_plane", params: { iterations: 1.2 } },
    { name: "robust_plane", params: { sigma: 0.9 } },
    { name: "gaussian", params: { sigma: 0 } },
    { name: "gaussian", params: { sigma: 11 } },
    { name: "polynomial", params: { degree: 3 } },
    { name: "line_match", params: { axis: "diagonal" } },
    {
      name: "three_point",
      params: {
        points: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        radius: 21,
      },
    },
    { name: "crop", params: { bounds: [1, 0, 0, 1] } },
  ])
    assert.throws(() => analyze({ operations: [op] }));
  assert.throws(() =>
    analyze({
      operations: Array.from({ length: 33 }, () => ({ name: "mean" })),
    }),
  );
  assert.doesNotThrow(() =>
    analyze({
      operations: Array.from({ length: 32 }, () => ({ name: "mean" })),
    }),
  );
});

test("selection point and bounds semantics and polygon resource limits are enforced", () => {
  const triangle = [
    [0, 0],
    [1, 0],
    [0, 1],
  ];
  assert.throws(() => analyze({ selection: { roi: [0, 0, 0, 1] } }));
  assert.throws(() =>
    analyze({
      selection: {
        exclude_polygons: Array.from({ length: 33 }, () => triangle),
      },
    }),
  );
  assert.throws(() =>
    analyze({
      selection: {
        exclude_polygons: [Array.from({ length: 257 }, () => [0, 0])],
      },
    }),
  );
  assert.throws(() =>
    analyze({
      profile: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    }),
  );
  assert.throws(() =>
    analyze({
      plateaus: [
        [0, 0, 1, 1],
        [1, 2, 1, 3],
      ],
    }),
  );
  for (const boundary_sigma of [0, -1, 101, NaN])
    assert.throws(() => call("check_quality", { ...identity, boundary_sigma }));
  assert.doesNotThrow(() =>
    call("check_quality", { ...identity, boundary_sigma: 100 }),
  );
});

test("UTF-8 argument byte budget is enforced independently of valid point counts", () => {
  const polygon = Array.from({ length: 256 }, () => [
    1.123456789012345e100, 2.123456789012345e100,
  ]);
  const args = {
    ...identity,
    operations: [],
    selection: { exclude_polygons: Array.from({ length: 32 }, () => polygon) },
  };
  assert.ok(new TextEncoder().encode(JSON.stringify(args)).byteLength > 262144);
  assert.throws(() => call("analyze_surface", args), /262144/);
});
