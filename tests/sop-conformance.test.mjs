import test from "node:test";
import assert from "node:assert/strict";
import {
  createSopRecord,
  checkSopConformance,
} from "../web/sop-conformance.js";
import { createToolSession } from "../web/tool-session.js";
import { runPlan } from "../web/tool-plans.js";
import { analyze, replay } from "../web/service.js";
import { qualityReport } from "../web/quality.js";
const hash = "a".repeat(64),
  engine = "e".repeat(64),
  sourceTuple = { file: "test.gwy", source_sha256: hash, channel: "0" };
const approved = (extra = {}) => ({
  source: sourceTuple,
  operations: [{ name: "mean" }],
  selection: {},
  justification: "Review mean subtraction for this synthetic demonstration.",
  ...extra,
});
async function fixture({
  selection = {},
  ops = [{ name: "mean" }],
  quality = true,
  process = true,
  replaying = true,
  fail = false,
} = {}) {
  const channel = {
    id: "0",
    title: "Height",
    width: 2,
    height: 2,
    xreal: 2e-6,
    yreal: 2e-6,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
    data: Float64Array.of(0, 1e-9, 2e-9, 3e-9),
    mask: null,
    metadata: {},
    warnings: ["Imported caveat"],
    log: [],
    selections: {},
  };
  const source = {
    sha256: hash,
    channels: { 0: channel },
    warnings: [],
    unsupported: [],
  };
  let session;
  session = createToolSession({
    invoke: async (name, a) => {
      if (fail && name === "check_quality")
        throw Error("Unresolved acquisition report");
      if (name === "check_quality") {
        const report = qualityReport(channel, {
          selection: a.selection,
          boundary_sigma: a.boundary_sigma,
        });
        return {
          schema_version: 1,
          input: {
            file: a.file,
            sha256: hash,
            channel: a.channel,
            reference_channel: a.reference_channel,
            warnings: [],
          },
          parameters: report.parameters,
          report,
          warnings: [],
        };
      }
      const r =
        name === "replay_recipe"
          ? await replay(
              session.artifact(a.recipe_artifact).content.result.recipe,
              source,
              null,
              engine,
            )
          : await analyze(a, source, null, engine);
      return Object.fromEntries(
        [
          "recipe",
          "channel",
          "statistics",
          "history",
          "quality",
          "step",
          "profile",
          "comparison",
          "warnings",
          "replay_verified",
        ].map((k) => [k, r[k] ?? null]),
      );
    },
  });
  const step = (id, name, arguments_) => ({
    id,
    call: { name, arguments: arguments_ },
  });
  const steps = [
    step("baseline", "analyze_surface", { ...sourceTuple, operations: [] }),
    ...(process
      ? [
          step("processed", "analyze_surface", {
            ...sourceTuple,
            operations: ops,
            selection,
          }),
        ]
      : []),
    ...(quality ? [step("quality", "check_quality", sourceTuple)] : []),
    ...(process && replaying
      ? [
          step("replay", "replay_recipe", {
            file: sourceTuple.file,
            source_sha256: hash,
            recipe_artifact: "$step:processed",
          }),
        ]
      : []),
  ];
  const manifest = await runPlan(
    { schema_version: 1, title: "SOP record test", steps },
    { execute: session.execute },
  );
  return {
    record: createSopRecord("height-roughness", {
      approved_settings: approved(),
    }),
    runs: [manifest],
    journal: session.journal(),
    sources: [sourceTuple],
  };
}
test("real baseline processed diagnostics and strict replay provide complete records with review outstanding", async () => {
  const input = await fixture(),
    before = structuredClone(input),
    out = await checkSopConformance(input);
  assert.equal(out.status, "records_complete");
  assert.ok(out.checks.every((c) => c.status === "met"));
  assert.ok(
    out.review_required.some((s) => s.includes("scientific suitability")),
  );
  assert.ok(
    out.review_required.some((s) => s.includes("approval authenticity")),
  );
  assert.ok(out.warnings.includes("Imported caveat"));
  assert.deepEqual(input, before);
  assert.deepEqual(out, await checkSopConformance(input));
});
test("constructor snapshots and freezes exact settings and rejects malformed declarations", () => {
  const a = approved(),
    r = createSopRecord("height-roughness", { approved_settings: a });
  a.operations.length = 0;
  assert.equal(r.approved_settings.operations.length, 1);
  assert.ok(Object.isFrozen(r.approved_settings.operations));
  for (const fn of [
    () => createSopRecord("unknown"),
    () => createSopRecord("height-roughness", { version: "1" }),
    () =>
      createSopRecord("height-roughness", {
        approved_settings: approved({ justification: " " }),
      }),
    () =>
      createSopRecord("height-roughness", {
        approved_settings: approved({ extra: true }),
      }),
    () => createSopRecord("height-roughness", { deviations: "x".repeat(2001) }),
  ])
    assert.throws(fn);
});
test("missing and changed approvals, selection, absent steps and failed runs remain incomplete", async () => {
  for (const config of [
    { quality: false },
    { replaying: false },
    { process: false },
    { selection: { roi: [0, 0, 1e-6, 2e-6] } },
    { fail: true },
  ])
    assert.equal(
      (await checkSopConformance(await fixture(config))).status,
      "incomplete",
    );
  const input = await fixture();
  input.record = createSopRecord("height-roughness");
  assert.equal(
    (await checkSopConformance(input)).checks.find(
      (c) => c.id === "approved_settings",
    ).status,
    "missing",
  );
  input.record = createSopRecord("height-roughness", {
    approved_settings: approved({ operations: [{ name: "zero_min" }] }),
  });
  assert.equal(
    (await checkSopConformance(input)).checks.find(
      (c) => c.id === "approved_settings",
    ).status,
    "mismatch",
  );
});
test("tamper, wrong selected tuple, duplicate runs and guidance modifications reject", async () => {
  const original = await fixture();
  for (const change of [
    (i) => i.runs[0].steps[1].result.artifact.content.result.statistics.mean++,
    (i) => (i.sources[0].channel = "1"),
    (i) => (i.sources[0].source_sha256 = "b".repeat(64)),
    (i) => i.runs.push(i.runs[0]),
    (i) => (i.record.guidance += " waived"),
    (i) => (i.record.version = "999"),
  ]) {
    const input = structuredClone(original);
    change(input);
    await assert.rejects(checkSopConformance(input));
  }
});
test("snapshot isolation, getters, empty runs and chemist pair cannot be fabricated from generic data", async () => {
  const input = await fixture(),
    expected = await checkSopConformance(input),
    pending = checkSopConformance(input);
  input.runs.length = 0;
  input.sources[0].file = "changed";
  assert.deepEqual(await pending, expected);
  let invoked = false;
  const bad = {
    get record() {
      invoked = true;
      return {};
    },
  };
  await assert.rejects(checkSopConformance(bad));
  assert.equal(invoked, false);
  const session = createToolSession({ invoke: () => ({}) });
  const empty = await checkSopConformance({
    record: createSopRecord("height-roughness"),
    runs: [],
    journal: session.journal(),
    sources: [sourceTuple],
  });
  assert.equal(empty.status, "incomplete");
  const chem = await fixture();
  chem.record = createSopRecord("chemist-reference", {
    approved_settings: approved(),
  });
  const result = await checkSopConformance(chem);
  assert.equal(result.status, "incomplete");
  assert.equal(
    result.checks.find((c) => c.id === "reference").status,
    "missing",
  );
});

test("supplied raw/worked pair baseline cannot establish reviewed fit points or replay", async (t) => {
  const { access } = await import("node:fs/promises");
  const { loadSource, engineIdentity } = await import("../scripts/io.mjs");
  const root =
    "./data/";
  const file = "sample-input.gwy",
    ref = "sample-reference.gwy";
  try {
    await access(root + file);
    await access(root + ref);
  } catch {
    t.skip("Local user-supplied pair unavailable");
    return;
  }
  const raw = await loadSource(root + file),
    worked = await loadSource(root + ref);
  assert.equal(
    raw.sha256,
    "ea0287a8afbed275d2d780f31508f89bd937796ab357f5a7d9389152e27abaab",
  );
  assert.equal(
    worked.sha256,
    "4e72274c8ec3077857c5ab943c04efeb541c2e23c7fa07f2b8b996d2ee288dec",
  );
  const source = { file, source_sha256: raw.sha256, channel: "0" },
    identity = await engineIdentity(raw.format);
  const s = createToolSession({
    invoke: async (name, args) => {
      const r = await analyze(args, raw, null, identity);
      return Object.fromEntries(
        [
          "recipe",
          "channel",
          "statistics",
          "history",
          "quality",
          "step",
          "profile",
          "comparison",
          "warnings",
        ].map((k) => [k, r[k]]),
      );
    },
  });
  const manifest = await runPlan(
    {
      schema_version: 1,
      title: "Unmodified actual raw baseline only",
      steps: [
        {
          id: "baseline",
          call: {
            name: "analyze_surface",
            arguments: { ...source, operations: [] },
          },
        },
      ],
    },
    { execute: s.execute },
  );
  assert.equal(manifest.status, "complete");
  const report = await checkSopConformance({
    record: createSopRecord("chemist-reference"),
    runs: [manifest],
    journal: s.journal(),
    sources: [
      source,
      { file: ref, source_sha256: worked.sha256, channel: "0" },
    ],
  });
  assert.equal(report.status, "incomplete");
  assert.equal(report.checks.find((c) => c.id === "baseline").status, "met");
  for (const id of ["approved_settings", "processed", "replay"])
    assert.equal(report.checks.find((c) => c.id === id).status, "missing");
});

test("rehashed diagnostic source and selection substitutions cannot satisfy quality records", async () => {
  const { canonicalJSON } = await import("../web/tool-session.js");
  const { sha256 } = await import("../web/engine.js");
  const digest = (v) =>
    sha256(new TextEncoder().encode(canonicalJSON(v, new Set(), 0, 128)));
  for (const mutate of [
    (r) => (r.input.channel = "1"),
    (r) => (r.parameters.selection = { roi: [0, 0, 1e-6, 2e-6] }),
  ]) {
    const input = await fixture(),
      manifest = input.runs[0],
      step = manifest.steps.find((s) => s.id === "quality"),
      artifact = step.result.artifact;
    mutate(artifact.content.result);
    artifact.sha256 = await digest(artifact.content);
    artifact.id = "artifact:" + artifact.sha256;
    input.journal.records[step.result.record.sequence - 1].artifact_id =
      artifact.id;
    let previous = null;
    for (const record of input.journal.records) {
      record.previous_sha256 = previous;
      delete record.sha256;
      record.sha256 = await digest(record);
      previous = record.sha256;
      const linked = manifest.steps.find(
        (s) => s.result?.record.sequence === record.sequence,
      );
      if (linked) linked.result.record = structuredClone(record);
    }
    input.journal.head_sha256 = previous;
    await assert.rejects(checkSopConformance(input));
  }
});

test("zero supplied runs accepts prior verified journal but rejects invalid empty journal schema", async () => {
  const input = await fixture();
  input.runs = [];
  const report = await checkSopConformance(input);
  assert.equal(report.status, "incomplete");
  assert.equal(report.journal_head_sha256, input.journal.head_sha256);
  for (const invalid of [
    {
      schema_version: 99,
      tool_version: "1.0.0",
      records: [],
      head_sha256: null,
    },
    { schema_version: 1, tool_version: "bad", records: [], head_sha256: null },
  ])
    await assert.rejects(checkSopConformance({ ...input, journal: invalid }));
});
