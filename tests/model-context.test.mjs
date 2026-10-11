import test from "node:test";
import assert from "node:assert/strict";
import { proposePlan } from "../web/model-planner.js";
import { createToolSession } from "../web/tool-session.js";
import { runPlan } from "../web/tool-plans.js";
import { analyze } from "../web/service.js";
const source = (file = "a.gwy", channel = "0", hash = "a") => ({
  file,
  channel,
  source_sha256: hash.repeat(64),
  title: "Height",
});
const options = (extra) => ({
  endpoint: "https://provider.example/v1/chat/completions",
  model: "mock",
  prompt: "Inspect selected sources",
  ...extra,
});
const identity = (s) => ({
  file: s.file,
  channel: s.channel,
  source_sha256: s.source_sha256,
});
const quality = (s) => ({ name: "check_quality", arguments: identity(s) });
const plan = (calls) => ({
  kind: "plan",
  plan: {
    schema_version: 1,
    title: "Selected sources",
    steps: calls.map((call, i) => ({ id: "s" + i, call })),
  },
});
const reply = (proposal) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(proposal) },
        },
      ],
    }),
  );
const run = (sources, proposal) =>
  proposePlan(
    options({
      sourceContexts: sources,
      fetchImpl: async () => reply(proposal),
    }),
  );
async function bundle() {
  const c = {
    id: "0",
    title: "Height",
    width: 2,
    height: 2,
    xreal: 2,
    yreal: 2,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
    data: new Float64Array([0, 1, 2, 3]),
    mask: null,
    metadata: {},
    log: [],
    warnings: [],
    selections: {},
  };
  const input = {
    channels: { 0: c },
    sha256: "a".repeat(64),
    unsupported: [],
    warnings: [],
  };
  const session = createToolSession({
    invoke: async (name, args) => {
      const r = await analyze(args, input, null, "e".repeat(64));
      return Object.fromEntries(
        [
          "recipe",
          "channel",
          "statistics",
          "history",
          "quality",
          "step",
          "profile",
          "warnings",
          "comparison",
          "replay_verified",
        ].map((k) => [k, r[k] ?? null]),
      );
    },
  });
  const manifest = await runPlan(
    {
      schema_version: 1,
      title: "Evidence",
      steps: [
        {
          id: "measure",
          call: {
            name: "analyze_surface",
            arguments: { ...identity(source()), operations: [] },
          },
        },
      ],
    },
    { execute: session.execute },
  );
  return { manifest, journal: session.journal(), step_ids: ["measure"] };
}
test("legacy request/audit shape remains singular with no evidence keys", async () => {
  let body;
  const r = await proposePlan(
    options({
      sourceContext: source(),
      fetchImpl: async (_, init) => {
        body = JSON.parse(init.body);
        return reply(plan([quality(source())]));
      },
    }),
  );
  assert.equal(r.audit.status, "proposed");
  assert.deepEqual(JSON.parse(body.messages.at(-1).content), {
    prompt: "Inspect selected sources",
    sourceContext: source(),
  });
  assert.deepEqual(r.audit.sourceContext, source());
  assert.ok(!Object.hasOwn(r.audit, "sourceContexts"));
  assert.ok(!Object.hasOwn(r.audit, "evidenceContext"));
});
test("selected source calls and cross-source reference tuples bind as complete identities", async () => {
  const a = source(),
    b = source("b.gwy", "1", "b");
  const calls = [
    quality(a),
    quality(b),
    {
      name: "analyze_surface",
      arguments: { ...identity(a), operations: [], reference: identity(b) },
    },
  ];
  assert.equal((await run([a, b], plan(calls))).audit.status, "proposed");
  for (const args of [
    { ...identity(a), channel: b.channel },
    { ...identity(a), source_sha256: b.source_sha256 },
    identity(source("unknown.gwy")),
  ])
    assert.equal(
      (await run([a, b], plan([{ name: "check_quality", arguments: args }])))
        .proposal,
      null,
    );
  calls[2].arguments.reference = {
    ...identity(b),
    source_sha256: a.source_sha256,
  };
  assert.equal((await run([a, b], plan(calls))).proposal, null);
  assert.equal(
    (
      await run(
        [a, b],
        plan([{ name: "inspect_source", arguments: { file: "unknown.gwy" } }]),
      )
    ).proposal,
    null,
  );
});
test("quality reference channel must belong to same selected file and hash", async () => {
  const a = source(),
    same = source("a.gwy", "1"),
    other = source("b.gwy", "2", "b");
  const p = plan([
    {
      name: "check_quality",
      arguments: { ...identity(a), reference_channel: "1" },
    },
  ]);
  assert.equal((await run([a, same, other], p)).audit.status, "proposed");
  p.plan.steps[0].call.arguments.reference_channel = "2";
  assert.equal((await run([a, same, other], p)).proposal, null);
});
test("strict source collections reject ambiguity, duplicate identities, sparse/accessor arrays", async () => {
  const accessor = [source()];
  let accessed = false;
  Object.defineProperty(accessor, "0", {
    get() {
      accessed = true;
      return source();
    },
    enumerable: true,
  });
  const extra = [source()];
  extra.other = 1;
  for (const sourceContexts of [
    [],
    Array(2),
    accessor,
    extra,
    Object.assign([source()], { [Symbol("x")]: 1 }),
    Array(9).fill(source()),
    [source(), source()],
    [source(), source("a.gwy", "1", "b")],
    [source(), { ...source(), title: "different" }],
  ])
    await assert.rejects(
      proposePlan(
        options({
          sourceContexts,
          fetchImpl: () => assert.fail("must reject before fetch"),
        }),
      ),
    );
  assert.equal(accessed, false);
  await assert.rejects(
    proposePlan(
      options({ sourceContext: source(), sourceContexts: [source()] }),
    ),
  );
  await assert.rejects(proposePlan(options({})));
});
test("UTF8 entire request limit rejects without truncating selected warnings", async () => {
  const selected = Array.from({ length: 8 }, (_, i) => ({
    ...source(`${i}.gwy`),
    warnings: Array(32).fill("🙂".repeat(1000)),
  }));
  await assert.rejects(
    proposePlan(
      options({
        sourceContexts: selected,
        fetchImpl: () => assert.fail("oversize must not send"),
      }),
    ),
  );
});
test("evidence projection and returned known claim IDs preserve exact values and audit", async () => {
  const evidenceBundle = await bundle();
  let context;
  const result = await proposePlan(
    options({
      sourceContexts: [source()],
      evidenceBundle,
      fetchImpl: async (_, init) => {
        context = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
        assert.ok(!Object.hasOwn(context, "evidenceBundle"));
        assert.ok(!Object.hasOwn(context.evidenceContext, "manifest"));
        return reply({
          kind: "evidence",
          claim_ids: [context.evidenceContext.claims[0].claim_id],
        });
      },
    }),
  );
  assert.equal(result.audit.status, "evidence");
  assert.equal(result.audit.proposal_plan_sha256, null);
  assert.deepEqual(result.audit.evidenceContext, context.evidenceContext);
  assert.equal(context.evidenceContext.claims.length, 8);
  const claim = context.evidenceContext.claims.find((c) => c.metric === "mean");
  assert.equal(claim.value, 1.5);
  assert.equal(claim.unit, "m");
  assert.match(claim.artifact_id, /^artifact:[0-9a-f]{64}$/);
});
test("evidence responses require opt-in, exact schema, and unique known IDs", async () => {
  assert.equal(
    (await run([source()], { kind: "evidence", claim_ids: ["invented"] }))
      .proposal,
    null,
  );
  const evidenceBundle = await bundle();
  for (const mutate of [
    (id) => ({ claim_ids: [] }),
    (id) => ({ claim_ids: ["unknown"] }),
    (id) => ({ claim_ids: [id, id] }),
    (id) => ({ claim_ids: [id], value: 2 }),
  ]) {
    const r = await proposePlan(
      options({
        sourceContext: source(),
        evidenceBundle,
        fetchImpl: async (_, init) => {
          const id = JSON.parse(JSON.parse(init.body).messages.at(-1).content)
            .evidenceContext.claims[0].claim_id;
          return reply({ kind: "evidence", ...mutate(id) });
        },
      }),
    );
    assert.equal(r.proposal, null);
  }
});
test("sources, history and evidence bundle are snapshotted before verification awaits", async () => {
  const sources = [source()],
    evidenceBundle = await bundle(),
    history = [{ role: "user", content: "original" }];
  let sent;
  const pending = proposePlan(
    options({
      sourceContexts: sources,
      evidenceBundle,
      history,
      fetchImpl: async (_, init) => {
        sent = JSON.parse(init.body);
        return reply({ kind: "clarification", question: "Which processing?" });
      },
    }),
  );
  sources[0].file = "mutated.gwy";
  history[0].content = "mutated";
  evidenceBundle.step_ids[0] = "unknown";
  evidenceBundle.manifest.steps[0].result.artifact.content.result.statistics.mean = 999;
  const r = await pending;
  assert.equal(r.audit.status, "clarification");
  assert.equal(r.audit.sourceContexts[0].file, "a.gwy");
  assert.equal(sent.messages[1].content, "original");
  assert.equal(
    r.audit.evidenceContext.claims.find((c) => c.metric === "mean").value,
    1.5,
  );
});
test("evidence never enables raw artifact tool references; secrets reject before fetch", async () => {
  const evidenceBundle = await bundle();
  const r = await proposePlan(
    options({
      sourceContexts: [source()],
      evidenceBundle,
      fetchImpl: async (_, init) => {
        const e = JSON.parse(
          JSON.parse(init.body).messages.at(-1).content,
        ).evidenceContext;
        return reply(
          plan([
            {
              name: "get_artifact",
              arguments: { artifact_id: e.claims[0].artifact_id },
            },
          ]),
        );
      },
    }),
  );
  assert.equal(r.proposal, null);
  await assert.rejects(
    proposePlan(
      options({
        sourceContexts: [{ ...source(), title: "secret-value" }],
        apiKey: "secret-value",
        fetchImpl: () => assert.fail("secret must not send"),
      }),
    ),
  );
  const reflected = await proposePlan(
    options({
      sourceContexts: [source()],
      apiKey: "secret-value",
      fetchImpl: async () =>
        reply({ kind: "clarification", question: "secret-value" }),
    }),
  );
  assert.equal(reflected.proposal, null);
  assert.ok(!JSON.stringify(reflected).includes("secret-value"));
});
test("tampered or accessor evidence bundles reject before contacting provider", async () => {
  const evidenceBundle = await bundle();
  evidenceBundle.manifest.steps[0].result.artifact.content.result.statistics.mean = 999;
  await assert.rejects(
    proposePlan(
      options({
        sourceContexts: [source()],
        evidenceBundle,
        fetchImpl: () => assert.fail("no request"),
      }),
    ),
  );
  let accessed = false;
  const accessor = {};
  Object.defineProperty(accessor, "manifest", {
    enumerable: true,
    get() {
      accessed = true;
      return {};
    },
  });
  await assert.rejects(
    proposePlan(
      options({ sourceContexts: [source()], evidenceBundle: accessor }),
    ),
  );
  assert.equal(accessed, false);
});

test("cancellation during local evidence verification sends no provider request", async () => {
  const evidenceBundle = await bundle(),
    controller = new AbortController();
  const pending = proposePlan(
    options({
      sourceContexts: [source()],
      evidenceBundle,
      signal: controller.signal,
      fetchImpl: () => assert.fail("canceled before provider request"),
    }),
  );
  controller.abort();
  const result = await pending;
  assert.equal(result.audit.status, "canceled");
  assert.equal(result.proposal, null);
  assert.equal(result.audit.evidenceContext.claims.length, 8);
});
