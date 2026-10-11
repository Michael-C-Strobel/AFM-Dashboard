import test from "node:test";
import assert from "node:assert/strict";
import { createAutonomousAgent } from "../web/autonomous-agent.js";
import { createModelObservations } from "../web/model-observations.js";
import { createToolSession } from "../web/tool-session.js";
import { validatePlan } from "../web/tool-plans.js";
import { analyze } from "../web/service.js";
import { qualityReport } from "../web/quality.js";
import { sha256 } from "../web/engine.js";
const hash = "a".repeat(64),
  engine = "e".repeat(64);
const identity = { file: "a.gwy", source_sha256: hash, channel: "0" };
const settings = {
  endpoint: "https://example.com/v1/chat/completions",
  model: "test",
  goal: "Inspect acquisition quality and report observations",
  sourceContexts: [identity],
  maxRounds: 4,
  maxCalls: 8,
};
function session() {
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
    warnings: [],
    log: [],
    selections: {},
  };
  const source = {
    sha256: hash,
    channels: { 0: channel },
    warnings: [],
    unsupported: [],
  };
  return createToolSession({
    invoke: async (name, a) => {
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
      const r = await analyze(a, source, null, engine);
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
}
async function planResponse(mixed = false) {
  const plan = validatePlan({
    schema_version: 1,
    title: "Quality assessment",
    steps: [
      ...(mixed
        ? [
            {
              id: "surface",
              call: {
                name: "analyze_surface",
                arguments: { ...identity, operations: [] },
              },
            },
          ]
        : []),
      { id: "quality", call: { name: "check_quality", arguments: identity } },
    ],
  });
  return {
    proposal: { kind: "plan", plan },
    audit: {
      status: "proposed",
      proposal_plan_sha256: await sha256(
        new TextEncoder().encode(JSON.stringify(plan)),
      ),
    },
  };
}
for (const mixed of [false, true])
  test(`${mixed ? "mixed" : "quality-only"} round provides verified observation feedback and terminates descriptively`, async () => {
    const s = session(),
      requests = [];
    const agent = createAutonomousAgent({
      execute: s.execute,
      getJournal: s.journal,
      propose: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          assert.equal(request.observationBundle, undefined);
          return planResponse(mixed);
        }
        assert.ok(request.observationBundle);
        assert.equal(Boolean(request.evidenceBundle), mixed);
        assert.match(request.prompt, /not independent proof/);
        const projected = await createModelObservations(
          request.observationBundle,
          request.sourceContexts,
        );
        assert.equal(projected.observations[0].summary.counts.selected, 4);
        return {
          proposal: {
            kind: "observations",
            observation_ids: [projected.observations[0].observation_id],
          },
          audit: { status: "observations" },
        };
      },
    });
    const result = await agent.start(settings);
    assert.equal(result.status, "observations_returned");
    assert.equal(result.calls, mixed ? 2 : 1);
    assert.equal(result.rounds[0].report.claims.length > 0, mixed);
    assert.deepEqual(
      result.rounds[1].observations,
      result.rounds[0].observations,
    );
    result.rounds[0].observations.observations.length = 0;
    assert.equal(
      agent.snapshot().rounds[0].observations.observations.length,
      1,
    );
    assert.equal(agent.resume().status, "observations_returned");
  });
test("unknown, duplicated, empty, extra-field and unavailable observation responses fail closed", async () => {
  for (const mode of [
    "unknown",
    "duplicate",
    "empty",
    "extra",
    "unavailable",
  ]) {
    const s = session();
    let rounds = 0;
    const agent = createAutonomousAgent({
      execute: s.execute,
      getJournal: s.journal,
      propose: async (request) => {
        rounds++;
        if (rounds === 1 && mode !== "unavailable") return planResponse();
        const p = request.observationBundle
          ? await createModelObservations(
              request.observationBundle,
              request.sourceContexts,
            )
          : null;
        const id = p?.observations[0].observation_id;
        const proposal = {
          kind: "observations",
          observation_ids:
            mode === "empty"
              ? []
              : mode === "duplicate"
                ? [id, id]
                : mode === "extra"
                  ? [id]
                  : ["unknown"],
        };
        if (mode === "extra") proposal.comment = "unexpected";
        return { proposal, audit: { status: "observations" } };
      },
    });
    const result = await agent.start(settings);
    assert.equal(result.status, "failed", mode);
    assert.equal(result.calls, mode === "unavailable" ? 0 : 1);
  }
});
test("quality-only execution at round budget preserves observations without claiming completion", async () => {
  const s = session();
  const agent = createAutonomousAgent({
    execute: s.execute,
    getJournal: s.journal,
    propose: () => planResponse(),
  });
  const result = await agent.start({ ...settings, maxRounds: 1 });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.rounds[0].observations.observations.length, 1);
});
