import test from "node:test";
import assert from "node:assert/strict";
import { proposePlan } from "../web/model-planner.js";
import { createModelObservations } from "../web/model-observations.js";
import { createToolSession } from "../web/tool-session.js";
import { runPlan } from "../web/tool-plans.js";
import { qualityReport } from "../web/quality.js";
const hash = "a".repeat(64),
  engine = "e".repeat(64);
const source = () => ({
  file: "synthetic.gwy",
  source_sha256: hash,
  channel: "0",
});
async function fixture({
  reference = false,
  warning = "Synthetic calibration is not certified.",
} = {}) {
  const channel = {
    id: "0",
    title: "Synthetic height",
    width: 4,
    height: 4,
    xreal: 4e-6,
    yreal: 4e-6,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
    mask: null,
    data: Float64Array.from({ length: 16 }, (_, i) => i * 1e-9),
  };
  const report = qualityReport(
    channel,
    {},
    reference ? { ...channel, id: "1" } : null,
  );
  const session = createToolSession({
    invoke: async () => ({
      schema_version: 1,
      input: {
        file: "synthetic.gwy",
        sha256: hash,
        channel: "0",
        channel_title: channel.title,
        format: "gwy",
        support: null,
        warnings: [warning],
        reference_channel: reference ? "1" : null,
        reference_title: reference ? "Reference" : null,
        reference_warnings: [],
      },
      reader_engine_sha256: engine,
      warnings: [warning, ...report.warnings],
      code: { sha256: engine, files: [] },
      parameters: report.parameters,
      report,
    }),
  });
  const manifest = await runPlan(
    {
      schema_version: 1,
      title: "Inspect synthetic quality",
      steps: [
        {
          id: "quality",
          call: {
            name: "check_quality",
            arguments: {
              ...source(),
              ...(reference ? { reference_channel: "1" } : {}),
            },
          },
        },
      ],
    },
    { execute: session.execute },
  );
  assert.equal(manifest.status, "complete");
  return { manifest, journal: session.journal(), step_ids: ["quality"] };
}
function wrap(proposal) {
  return new Response(
    JSON.stringify({
      model: "mock",
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(proposal) },
        },
      ],
    }),
  );
}
const options = (extra) => ({
  endpoint: "https://provider.example/v1/chat/completions",
  model: "mock",
  prompt: "Review recorded quality observations",
  sourceContexts: [source()],
  ...extra,
});
const select = (context) => ({
  kind: "observations",
  observation_ids: [context.observations[0].observation_id],
});

test("transmits only verified projection and attributes selected recorded observations", async () => {
  const observationBundle = await fixture(),
    expected = await createModelObservations(observationBundle, [source()]);
  let payload;
  const result = await proposePlan(
    options({
      observationBundle,
      fetchImpl: async (_url, init) => {
        payload = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
        assert.deepEqual(payload.observationsContext, expected);
        assert.deepEqual(Object.keys(payload).sort(), [
          "observationsContext",
          "prompt",
          "sourceContexts",
        ]);
        for (const key of [
          "manifest",
          "journal",
          "report",
          "recipe",
          "data",
          "medians",
          "adjacent_differences",
        ])
          assert.equal(Object.hasOwn(payload.observationsContext, key), false);
        const serialized = JSON.stringify(payload);
        for (const key of [
          "manifest",
          "journal",
          "data",
          "medians",
          "adjacent_differences",
        ])
          assert.equal(serialized.includes('"' + key + '":'), false);
        return wrap(select(expected));
      },
    }),
  );
  assert.deepEqual(result.proposal, select(expected));
  assert.equal(result.audit.status, "observations");
  assert.equal(result.audit.proposal_plan_sha256, null);
  assert.deepEqual(result.audit.observationsContext, expected);
  assert.equal(
    result.audit.observationsContext.observations[0].source.file,
    "synthetic.gwy",
  );
  assert.ok(
    JSON.stringify(result.audit.request).includes("not new measurements"),
  );
});

test("unknown, duplicate, empty, excessive or embellished observation selections fail closed", async () => {
  const observationBundle = await fixture(),
    projected = await createModelObservations(observationBundle, [source()]),
    id = projected.observations[0].observation_id;
  for (const proposal of [
    { kind: "observations", observation_ids: ["unknown"] },
    { kind: "observations", observation_ids: [id, id] },
    { kind: "observations", observation_ids: [] },
    { kind: "observations", observation_ids: Array(17).fill(id) },
    {
      kind: "observations",
      observation_ids: [id],
      conclusion: "A calibrated defect",
    },
    { kind: "observations", observation_ids: [42] },
  ]) {
    const result = await proposePlan(
      options({ observationBundle, fetchImpl: async () => wrap(proposal) }),
    );
    assert.equal(result.proposal, null);
    assert.equal(result.audit.status, "failed");
  }
  const absent = await proposePlan(
    options({ fetchImpl: async () => wrap(select(projected)) }),
  );
  assert.equal(absent.proposal, null);
  assert.equal(Object.hasOwn(absent.audit, "observationsContext"), false);
});

test("tampered journal, unknown step and unselected source/reference reject before network", async () => {
  let network = 0;
  const cases = [];
  const tampered = await fixture();
  tampered.journal.records[0].result_sha256 = "b".repeat(64);
  cases.push([tampered, [source()]]);
  const unknown = await fixture();
  unknown.step_ids = ["unknown"];
  cases.push([unknown, [source()]]);
  cases.push([
    await fixture(),
    [{ ...source(), source_sha256: "b".repeat(64) }],
  ]);
  cases.push([await fixture({ reference: true }), [source()]]);
  for (const [observationBundle, sourceContexts] of cases)
    await assert.rejects(
      proposePlan(
        options({
          observationBundle,
          sourceContexts,
          fetchImpl: async () => {
            network++;
            return wrap({ kind: "clarification", question: "Unexpected" });
          },
        }),
      ),
      /Selected observations could not be verified/,
    );
  assert.equal(network, 0);
  const validReference = await proposePlan(
    options({
      observationBundle: await fixture({ reference: true }),
      sourceContexts: [source(), { ...source(), channel: "1" }],
      fetchImpl: async () =>
        wrap({ kind: "clarification", question: "Which calibration applies?" }),
    }),
  );
  assert.equal(validReference.audit.status, "clarification");
});

test("bundle is descriptor-safe and captured before first await", async () => {
  const observationBundle = await fixture(),
    expected = await createModelObservations(observationBundle, [source()]);
  const promise = proposePlan(
    options({
      observationBundle,
      fetchImpl: async (_url, init) => {
        assert.deepEqual(
          JSON.parse(JSON.parse(init.body).messages.at(-1).content)
            .observationsContext,
          expected,
        );
        return wrap(select(expected));
      },
    }),
  );
  observationBundle.step_ids[0] = "changed";
  observationBundle.manifest.title = "changed";
  observationBundle.journal.records.length = 0;
  assert.equal((await promise).audit.status, "observations");
  let called = false;
  const unsafe = {
    get manifest() {
      called = true;
      throw Error("should not run");
    },
    journal: {},
    step_ids: ["quality"],
  };
  await assert.rejects(
    proposePlan(options({ observationBundle: unsafe })),
    /Invalid model-planner/,
  );
  assert.equal(called, false);
});

test("decoded observation text and provider response cannot reflect credentials", async () => {
  const key = 'secret"escaped\\token';
  let network = 0;
  await assert.rejects(
    proposePlan(
      options({
        apiKey: key,
        observationBundle: await fixture({ warning: key }),
        fetchImpl: async () => {
          network++;
          return wrap({ kind: "clarification", question: "Unexpected" });
        },
      }),
    ),
    /Invalid model-planner/,
  );
  assert.equal(network, 0);
  const result = await proposePlan(
    options({
      apiKey: key,
      observationBundle: await fixture(),
      fetchImpl: async () =>
        wrap({ kind: "observations", observation_ids: [key] }),
    }),
  );
  assert.equal(result.proposal, null);
  assert.equal(JSON.stringify(result.audit).includes(key), false);
});

test("observation artifacts do not authorize cross-plan raw artifact references or mixed identities", async () => {
  const observationBundle = await fixture(),
    projected = await createModelObservations(observationBundle, [source()]);
  const calls = [
    {
      name: "get_artifact",
      arguments: { artifact_id: projected.observations[0].artifact_id },
    },
    {
      name: "check_quality",
      arguments: { ...source(), source_sha256: "b".repeat(64) },
    },
  ];
  for (const call of calls) {
    const result = await proposePlan(
      options({
        observationBundle,
        fetchImpl: async () =>
          wrap({
            kind: "plan",
            plan: {
              schema_version: 1,
              title: "Invalid reference",
              steps: [{ id: "invalid", call }],
            },
          }),
      }),
    );
    assert.equal(result.proposal, null);
    assert.equal(result.audit.status, "failed");
  }
});

test("requests without observations retain the legacy payload and audit shape", async () => {
  let payload;
  const result = await proposePlan(
    options({
      fetchImpl: async (_url, init) => {
        payload = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
        return wrap({
          kind: "clarification",
          question: "Which source setting should be inspected?",
        });
      },
    }),
  );
  assert.deepEqual(Object.keys(payload).sort(), ["prompt", "sourceContexts"]);
  assert.equal(Object.hasOwn(result.audit, "observationsContext"), false);
  assert.equal(result.audit.status, "clarification");
});
