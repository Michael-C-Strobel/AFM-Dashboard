/** Bounded automatic orchestration; evidence returned is not certified goal achievement. */
import { proposePlan } from "./model-planner.js";
import { validatePlan, runPlan } from "./tool-plans.js";
import { validateToolCall } from "./tool-contracts.js";
import { canonicalJSON } from "./tool-session.js";
import { createEvidenceReport } from "./evidence-report.js";
import { createModelEvidence } from "./model-evidence.js";
import { createModelObservations } from "./model-observations.js";
import { sha256 } from "./engine.js";
const terminal = new Set([
  "evidence_returned",
  "observations_returned",
  "needs_input",
  "failed",
  "budget_exhausted",
  "stopped",
]);
const copy = (value) => {
  canonicalJSON(value, new Set(), 0, 128);
  return structuredClone(value);
};
function secretIn(value, key) {
  if (!key) return false;
  if (typeof value === "string") return value.includes(key);
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([k, v]) => k.includes(key) || secretIn(v, key),
    );
  return false;
}
function sources(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw Error();
  const seen = new Set(),
    files = new Map();
  for (const s of raw) {
    if (
      !s ||
      Array.isArray(s) ||
      Object.keys(s).some(
        (k) =>
          ![
            "file",
            "source_sha256",
            "channel",
            "title",
            "geometry",
            "units",
            "warnings",
          ].includes(k),
      )
    )
      throw Error();
    validateToolCall({
      name: "check_quality",
      arguments: {
        file: s.file,
        source_sha256: s.source_sha256,
        channel: s.channel,
      },
    });
    const id = JSON.stringify([s.file, s.source_sha256, s.channel]);
    if (
      seen.has(id) ||
      (files.has(s.file) && files.get(s.file) !== s.source_sha256)
    )
      throw Error();
    seen.add(id);
    files.set(s.file, s.source_sha256);
    if (
      s.title !== undefined &&
      (typeof s.title !== "string" || [...s.title].length > 255)
    )
      throw Error();
    if (s.geometry !== undefined) {
      const g = s.geometry,
        keys = ["shape", "xreal", "yreal", "xoff", "yoff", "xy_unit", "z_unit"];
      if (
        !g ||
        Object.keys(g).length !== 7 ||
        keys.some((k) => !Object.hasOwn(g, k)) ||
        !Array.isArray(g.shape) ||
        g.shape.length !== 2 ||
        !g.shape.every((v) => Number.isSafeInteger(v) && v > 0) ||
        !["xreal", "yreal", "xoff", "yoff"].every((k) =>
          Number.isFinite(g[k]),
        ) ||
        g.xreal <= 0 ||
        g.yreal <= 0
      )
        throw Error();
    }
    for (const group of [s.geometry, s.units])
      if (group)
        for (const k of ["xy_unit", "z_unit"])
          if (
            group[k] !== null &&
            (typeof group[k] !== "string" || [...group[k]].length > 64)
          )
            throw Error();
    if (
      s.units !== undefined &&
      (!s.units ||
        Object.keys(s.units).length !== 2 ||
        !Object.hasOwn(s.units, "xy_unit") ||
        !Object.hasOwn(s.units, "z_unit") ||
        (s.geometry &&
          ["xy_unit", "z_unit"].some((k) => s.units[k] !== s.geometry[k])))
    )
      throw Error();
    if (
      s.warnings !== undefined &&
      (!Array.isArray(s.warnings) ||
        s.warnings.length > 32 ||
        s.warnings.some((w) => typeof w !== "string" || [...w].length > 1000))
    )
      throw Error();
  }
  return raw;
}
function bound(raw, selected) {
  const p = validatePlan(raw),
    keys = ["file", "source_sha256", "channel"];
  for (const { call } of p.steps) {
    if (call.name === "list_sources") throw Error();
    const a = call.arguments,
      matches = selected.filter((s) =>
        keys.every((k) => !Object.hasOwn(a, k) || a[k] === s[k]),
      );
    if (!matches.length) throw Error();
    if (
      a.reference &&
      !selected.some((s) => keys.every((k) => a.reference[k] === s[k]))
    )
      throw Error();
    if (
      a.reference_channel != null &&
      !matches.some((m) =>
        selected.some(
          (s) =>
            s.file === m.file &&
            s.source_sha256 === m.source_sha256 &&
            s.channel === a.reference_channel,
        ),
      )
    )
      throw Error();
    for (const k of ["artifact_id", "recipe_artifact"])
      if (Object.hasOwn(a, k) && !a[k].startsWith("$step:")) throw Error();
  }
  return p;
}
export function createAutonomousAgent({
  propose = proposePlan,
  execute,
  getJournal,
  onUpdate = () => {},
}) {
  if (
    ![propose, execute, getJournal, onUpdate].every(
      (v) => typeof v === "function",
    )
  )
    throw new Error("Invalid autonomous controller callbacks.");
  let started = false,
    paused = false,
    stopped = false,
    abort = null,
    wake = null,
    key = "";
  const state = {
    schema_version: 1,
    goal: null,
    sources: [],
    bounds: null,
    status: "idle",
    calls: 0,
    rounds: [],
    started_at: null,
    finished_at: null,
    error: null,
  };
  const snapshot = () => structuredClone(state);
  const publish = async () => {
    if (secretIn(state, key)) throw Error();
    await onUpdate(snapshot());
  };
  const controlsUpdate = () => {
    void publish().catch(() => {
      stopped = true;
      paused = false;
      state.status = "failed";
      state.error = "Autonomous update failed.";
      abort?.abort();
      wake?.();
    });
  };
  const gate = async () => {
    while (paused && !stopped) {
      state.status = "paused";
      await publish();
      await new Promise((resolve) => {
        wake = resolve;
        if (!paused || stopped) resolve();
      });
      wake = null;
    }
    return !stopped;
  };
  const cancelRequestAudit = () => {
    const round = state.rounds.at(-1);
    if (round?.audit?.status === "requesting")
      round.audit = {
        ...round.audit,
        status: "canceled",
        error: "Provider proposal request canceled.",
        finished_at: new Date().toISOString(),
      };
    if (round?.status === "planning") round.status = "canceled";
  };
  const finish = async (status) => {
    if (status === "stopped") cancelRequestAudit();
    state.status = status;
    state.finished_at = new Date().toISOString();
    await publish();
    return snapshot();
  };
  async function start(settings) {
    if (started) throw new Error("Autonomous controller can start only once.");
    started = true;
    try {
      if (
        !settings ||
        typeof settings !== "object" ||
        Array.isArray(settings) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(settings))
      )
        throw Error();
      const allowed = [
        "endpoint",
        "model",
        "apiKey",
        "goal",
        "sourceContexts",
        "maxRounds",
        "maxCalls",
      ];
      for (const k of Reflect.ownKeys(settings)) {
        const d = Object.getOwnPropertyDescriptor(settings, k);
        if (
          typeof k !== "string" ||
          !allowed.includes(k) ||
          !d.enumerable ||
          !Object.hasOwn(d, "value")
        )
          throw Error();
      }
      key = settings.apiKey ?? "";
      if (typeof key !== "string" || key.length > 8192) throw Error();
      const { apiKey, ...rest } = settings,
        c = copy(rest);
      if (secretIn(c, key)) throw Error();
      const rounds = c.maxRounds ?? 4,
        calls = c.maxCalls ?? 24;
      if (
        typeof c.goal !== "string" ||
        !c.goal.trim() ||
        [...c.goal].length > 6000 ||
        typeof c.endpoint !== "string" ||
        typeof c.model !== "string" ||
        !Number.isInteger(rounds) ||
        rounds < 1 ||
        rounds > 8 ||
        !Number.isInteger(calls) ||
        calls < 1 ||
        calls > 64
      )
        throw Error();
      sources(c.sourceContexts);
      Object.assign(state, {
        goal: c.goal,
        sources: c.sourceContexts,
        bounds: { maxRounds: rounds, maxCalls: calls },
        status: "running",
        started_at: new Date().toISOString(),
      });
      let bundle = null,
        evidence = null,
        observationBundle = null,
        observations = null;
      const history = [];
      await publish();
      for (let n = 1; n <= rounds; n++) {
        if (!(await gate())) return await finish("stopped");
        if (state.calls >= calls) return await finish("budget_exhausted");
        state.status = "planning";
        const round = {
          number: n,
          status: "planning",
          audit: null,
          manifest: null,
          report: null,
        };
        state.rounds.push(round);
        await publish();
        const prompt = `Goal: ${c.goal}\nRound ${n}/${rounds}; tool calls remaining ${calls - state.calls}. Previous run status: ${state.rounds.slice(0, -1).findLast((r) => r.manifest)?.manifest.status ?? "none"}. ${evidence || observations ? "Adapt the next plan using supplied verified surface evidence and diagnostic observations, or return available evidence claim IDs or observation IDs. Observations are recorded descriptive summaries, not independent proof of goal completion." : "No verified evidence or observations are available. Request an analysis plan first, using surface or diagnostic tools as appropriate; do not claim completion."} Stay within selected sources and remaining calls; list_sources is forbidden. All artifact references must refer to earlier steps of this same plan.`;
        if (!(await gate())) return await finish("stopped");
        abort = new AbortController();
        let rejectAbort;
        const aborted = new Promise((_, reject) => {
          rejectAbort = () => reject(Error());
          abort.signal.addEventListener("abort", rejectAbort, { once: true });
        });
        let response,
          acceptAudit = true;
        const captureAudit = async (value) => {
          if (!acceptAudit || stopped || terminal.has(state.status)) return;
          const audit = copy(value);
          if (
            !audit ||
            Array.isArray(audit) ||
            typeof audit !== "object" ||
            secretIn(audit, key)
          )
            throw new Error("Invalid provider audit.");
          round.audit = audit;
          await publish();
        };
        try {
          response = copy(
            await Promise.race([
              propose({
                mode: "autonomous",
                endpoint: c.endpoint,
                model: c.model,
                apiKey: key,
                prompt,
                sourceContexts: copy(c.sourceContexts),
                ...(bundle ? { evidenceBundle: copy(bundle) } : {}),
                ...(observationBundle
                  ? { observationBundle: copy(observationBundle) }
                  : {}),
                history: copy(history),
                signal: abort.signal,
                onAudit: captureAudit,
              }),
              aborted,
            ]),
          );
        } finally {
          acceptAudit = false;
          abort.signal.removeEventListener("abort", rejectAbort);
          abort = null;
        }
        if (secretIn(response, key)) throw Error();
        round.audit = response.audit ?? round.audit;
        if (stopped) return await finish("stopped");
        if (!(await gate())) return await finish("stopped");
        const proposal = response.proposal;
        if (!proposal) {
          round.status = "failed";
          return await finish("failed");
        }
        if (proposal.kind === "clarification") {
          if (
            Object.keys(proposal).length !== 2 ||
            typeof proposal.question !== "string" ||
            !proposal.question.length ||
            proposal.question.length > 2000
          )
            throw Error();
          round.proposal = proposal;
          round.status = "needs_input";
          return await finish("needs_input");
        }
        if (proposal.kind === "observations") {
          if (
            Object.keys(proposal).length !== 2 ||
            !observations ||
            !Array.isArray(proposal.observation_ids) ||
            proposal.observation_ids.length < 1 ||
            proposal.observation_ids.length > 16 ||
            new Set(proposal.observation_ids).size !==
              proposal.observation_ids.length ||
            proposal.observation_ids.some(
              (id) =>
                !observations.observations.some((o) => o.observation_id === id),
            )
          )
            throw Error();
          round.proposal = proposal;
          round.observations = copy(observations);
          round.status = "observations_returned";
          return await finish("observations_returned");
        }
        if (proposal.kind === "evidence") {
          if (
            Object.keys(proposal).length !== 2 ||
            !evidence ||
            !Array.isArray(proposal.claim_ids) ||
            proposal.claim_ids.length < 1 ||
            proposal.claim_ids.length > 32 ||
            new Set(proposal.claim_ids).size !== proposal.claim_ids.length ||
            proposal.claim_ids.some(
              (id) => !evidence.claims.some((c) => c.claim_id === id),
            )
          )
            throw Error();
          round.proposal = proposal;
          round.evidence = evidence;
          round.status = "evidence_returned";
          return await finish("evidence_returned");
        }
        if (proposal.kind !== "plan" || Object.keys(proposal).length !== 2)
          throw Error();
        const plan = bound(proposal.plan, c.sourceContexts),
          hash = await sha256(new TextEncoder().encode(JSON.stringify(plan)));
        if (response.audit?.proposal_plan_sha256 !== hash) throw Error();
        if (plan.steps.length > calls - state.calls) {
          round.status = "budget_exhausted";
          return await finish("budget_exhausted");
        }
        round.proposal = { kind: "plan", plan };
        round.status = "executing";
        state.status = "executing";
        round.manifest = await runPlan(plan, {
          shouldCancel: () => stopped,
          execute: async (call) => {
            if (!(await gate()))
              throw new Error("Autonomous execution stopped.");
            state.status = "executing";
            await publish();
            if (stopped) throw new Error("Autonomous execution stopped.");
            state.calls++;
            let result;
            try {
              result = copy(await execute(call));
            } catch {
              throw new Error("Tool invocation failed.");
            }
            if (secretIn(result, key)) throw Error();
            return result;
          },
          onUpdate: async (manifest) => {
            if (secretIn(manifest, key)) throw Error();
            round.manifest = manifest;
            await publish();
            await gate();
          },
        });
        const journal = copy(await getJournal());
        if (secretIn(journal, key)) throw Error();
        const verifiedReport = await createEvidenceReport({
          manifest: round.manifest,
          journal,
        });
        if (secretIn(verifiedReport, key)) throw Error();
        round.report = verifiedReport;
        round.status = round.manifest.status;
        if (stopped) return await finish("stopped");
        if (round.manifest.status !== "complete") return await finish("failed");
        const ids = [
          ...new Set(round.report.claims.map((c) => c.step_id)),
        ].slice(-4);
        if (ids.length) {
          bundle = { manifest: round.manifest, journal, step_ids: ids };
          evidence = await createModelEvidence(bundle, c.sourceContexts);
        }
        const observationIds = round.manifest.steps
          .filter(
            (step) =>
              step.status === "complete" &&
              [
                "check_quality",
                "segment_surface",
                "measure_texture",
                "analyze_sensitivity",
              ].includes(step.resolved_call?.name),
          )
          .map((step) => step.id);
        if (observationIds.length) {
          const nextBundle = {
            manifest: round.manifest,
            journal,
            step_ids: observationIds,
          };
          const projected = await createModelObservations(
            nextBundle,
            c.sourceContexts,
          );
          if (secretIn(projected, key)) throw Error();
          observations = projected;
          observationBundle = nextBundle;
          round.observations = copy(projected);
        }
        const content = JSON.stringify({ kind: "plan", plan });
        if (content.length <= 8000) {
          history.push({ role: "assistant", content });
          while (
            history.length > 12 ||
            history.reduce((sum, h) => sum + h.content.length, 0) > 16000
          )
            history.shift();
        }
        await publish();
        if (!(await gate())) return await finish("stopped");
      }
      if (!(await gate())) return await finish("stopped");
      return await finish("budget_exhausted");
    } catch {
      if (stopped) cancelRequestAudit();
      state.error = stopped
        ? null
        : "Autonomous request or verification failed.";
      state.status = stopped ? "stopped" : "failed";
      state.finished_at = new Date().toISOString();
      try {
        await publish();
      } catch {}
      return snapshot();
    }
  }
  return {
    start,
    snapshot,
    pause() {
      if (started && !stopped && !paused && !terminal.has(state.status)) {
        paused = true;
        state.status = "paused";
        controlsUpdate();
      }
      return snapshot();
    },
    resume() {
      if (started && paused && !terminal.has(state.status)) {
        paused = false;
        state.status = "running";
        wake?.();
        controlsUpdate();
      }
      return snapshot();
    },
    stop() {
      if (started && !stopped && !terminal.has(state.status)) {
        stopped = true;
        paused = false;
        cancelRequestAudit();
        abort?.abort();
        wake?.();
        controlsUpdate();
      }
      return snapshot();
    },
  };
}
