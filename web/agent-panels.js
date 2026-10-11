import { createSopRecord, checkSopConformance } from "./sop-conformance.js";
import { workflowSops, sopPrompt } from "./workflow-sops.js";
import { askHelp } from "./help-agent.js";
import { createAutonomousAgent } from "./autonomous-agent.js";

export function mountAgentModes({
  host,
  getConnection,
  getSources,
  execute,
  getJournal,
  isBusy,
  setBusy,
}) {
  const el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const save = (value, name) => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const a = el("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const group = (title, id) => {
    const d = el("details");
    d.className = "model-panel";
    d.id = id;
    d.append(el("summary", title));
    host.append(d);
    return d;
  };
  const button = (parent, text, id) => {
    const b = el("button", text);
    b.id = id;
    parent.append(b);
    return b;
  };
  const field = (parent, text, id, type = "textarea") => {
    const label = el("label", text),
      input = el(type);
    input.id = id;
    label.append(input);
    parent.append(label);
    return input;
  };
  const help = group("Help agent · interface and workflow guide", "help-agent");
  help.append(
    el(
      "p",
      "Uses the provider connection above. Sends your question and the built-in guide; no selected measurements or analysis results are included. This agent cannot run tools. Answers are model-generated guidance; check the linked documentation.",
    ),
  );
  const question = field(help, "Ask how to use the dashboard", "help-question");
  question.rows = 3;
  question.maxLength = 8000;
  const helpActions = el("div");
  helpActions.className = "toolbar";
  help.append(helpActions);
  const send = button(helpActions, "Ask help", "help-send"),
    cancelHelp = button(helpActions, "Cancel help", "help-cancel"),
    resetHelp = button(helpActions, "New help conversation", "help-reset"),
    downloadHelp = button(helpActions, "Download help audit", "help-download");
  const guide = el("a", "Read the built-in guide");
  guide.href = "help.html";
  guide.target = "_blank";
  guide.rel = "noopener";
  help.append(guide);
  const helpStatus = el("p", "No help request sent.");
  helpStatus.id = "help-status";
  helpStatus.setAttribute("role", "status");
  help.append(helpStatus);
  const helpLog = el("ol");
  helpLog.id = "help-conversation";
  help.append(helpLog);
  let helpController = null,
    history = [],
    helpAudits = [],
    connectionIdentity = null;
  resetHelp.onclick = () => {
    history = [];
    helpLog.replaceChildren();
    helpStatus.textContent = "New conversation; audits retained.";
  };
  cancelHelp.onclick = () => helpController?.abort();
  downloadHelp.onclick = () =>
    save({ schema_version: 1, requests: helpAudits }, "afm-help-audit.json");
  send.onclick = async () => {
    if (isBusy()) return;
    if (!question.value.trim()) {
      helpStatus.textContent = "Enter a help question.";
      return;
    }
    if (helpAudits.length >= 16) {
      helpStatus.textContent =
        "Request limit reached. Download the audit before reloading.";
      return;
    }
    helpController = new AbortController();
    setBusy(true);
    sync();
    try {
      const connection = await getConnection();
      const identity = JSON.stringify([connection.endpoint, connection.model]);
      if (connectionIdentity !== identity) {
        history = [];
        connectionIdentity = identity;
      }
      const q = question.value.trim();
      helpStatus.textContent = "Consulting the interface guide…";
      const result = await askHelp({
        ...connection,
        question: q,
        history,
        signal: helpController.signal,
      });
      helpAudits.push(result.audit);
      if (!result.answer) {
        helpStatus.textContent = result.audit.error;
        return;
      }
      const item = el("li");
      item.append(el("strong", q), el("p", result.answer.answer));
      for (const topic of result.answer.topics) {
        const link = el("a", topic.title);
        link.href = "help.html#" + topic.id;
        link.target = "_blank";
        link.rel = "noopener";
        item.append(link, document.createTextNode(" "));
        if (topic.target) {
          const locate = el("button", "Show control");
          locate.onclick = () => {
            const target = document.getElementById(topic.target);
            if (!target) return;
            const panel = target.closest('[role="tabpanel"]');
            if (panel)
              document
                .getElementById(panel.getAttribute("aria-labelledby"))
                ?.click();
            if (target.matches('[role="tab"]')) target.click();
            for (let n = target.parentElement; n; n = n.parentElement)
              if (n.tagName === "DETAILS") n.open = true;
            const inspector = target.closest("#data-inspector");
            if (inspector && getComputedStyle(inspector).display === "none")
              document.getElementById("toggle-inspector").click();
            target.scrollIntoView({ block: "center" });
            target.focus();
          };
          item.append(locate);
        }
      }
      helpLog.append(item);
      history.push(
        { role: "user", content: q },
        {
          role: "assistant",
          content: JSON.stringify({
            answer: result.answer.answer,
            topic_ids: result.answer.topic_ids,
          }),
        },
      );
      while (
        history.length > 12 ||
        history.reduce((n, m) => n + m.content.length, 0) > 16000 ||
        history.some((m) => m.content.length > 8000)
      )
        history.splice(0, 2);
      question.value = "";
      helpStatus.textContent =
        "Help answer received. No analysis tools executed.";
    } catch {
      helpStatus.textContent =
        "Help connection is unavailable. Check the endpoint, model and host connection policy.";
    } finally {
      helpController = null;
      setBusy(false);
      sync();
    }
  };

  const autonomous = group(
    "Autonomous analysis · start a bounded goal",
    "autonomous-agent",
  );
  autonomous.append(
    el(
      "p",
      "Start authorizes automatic planning and tool execution on the selected channels above. Each round sends selected source metadata and verified compact surface evidence and quality, segmentation, texture or sensitivity summaries from completed rounds; raw images remain local. Review scientific choices and recorded results. Stop and pause take effect after any running local tool finishes.",
    ),
  );
  const sopLabel = el("label", "Optional workflow SOP"),
    sop = el("select");
  sop.id = "autonomous-sop";
  const none = el("option", "No SOP — custom goal");
  none.value = "";
  sop.append(none);
  for (const item of workflowSops) {
    const option = el("option", `${item.title} · ${item.version} · pilot`);
    option.value = item.id;
    sop.append(option);
  }
  sopLabel.append(sop);
  autonomous.append(sopLabel);
  const sopDetails = el("details");
  sopDetails.append(el("summary", "Read selected SOP"));
  const sopText = el("pre");
  sopText.tabIndex = 0;
  sopText.setAttribute("aria-label", "Selected SOP instructions");
  sopDetails.append(sopText);
  autonomous.append(sopDetails);
  sop.onchange = () => {
    sopText.textContent = sop.value ? sopPrompt(sop.value) : "No SOP selected.";
  };
  sop.onchange();
  const deviations = field(
    autonomous,
    "SOP deviations or approved choices (optional)",
    "autonomous-deviations",
  );
  deviations.rows = 2;
  deviations.maxLength = 1000;
  const expectedDetails = el("details");
  expectedDetails.append(el("summary", "Expected SOP settings (optional)"));
  expectedDetails.append(
    el(
      "p",
      "Record the source, operations and selection you approve before starting. These JSON settings are sent with the goal and checked against the resulting records. Leave blank to report this requirement as missing. Scientific suitability still needs review.",
    ),
  );
  const expected = field(
    expectedDetails,
    "Approved settings JSON",
    "autonomous-sop-settings",
  );
  expected.rows = 5;
  expected.maxLength = 12000;
  const template = button(
    expectedDetails,
    "Start from selected source",
    "autonomous-sop-template",
  );
  template.onclick = () => {
    const source = getSources()[0];
    if (!source) return;
    expected.value = JSON.stringify(
      {
        source: {
          file: source.file,
          source_sha256: source.source_sha256,
          channel: source.channel,
        },
        operations: [],
        selection: { roi: null, exclude_polygons: [] },
        reference: null,
        justification: "",
        fit_point_provenance: "",
      },
      null,
      2,
    );
  };
  autonomous.append(expectedDetails);
  const goal = field(
    autonomous,
    "Analysis goal and scientific constraints",
    "autonomous-goal",
  );
  goal.rows = 3;
  goal.maxLength = 6000;
  const bounds = el("div");
  bounds.className = "toolbar";
  autonomous.append(bounds);
  const rounds = field(
    bounds,
    "Maximum provider rounds (1–8)",
    "autonomous-rounds",
    "input",
  );
  rounds.type = "number";
  rounds.min = 1;
  rounds.max = 8;
  rounds.value = 4;
  const calls = field(
    bounds,
    "Maximum tool calls (1–64)",
    "autonomous-calls",
    "input",
  );
  calls.type = "number";
  calls.min = 1;
  calls.max = 64;
  calls.value = 24;
  const actions = el("div");
  actions.className = "toolbar";
  autonomous.append(actions);
  const start = button(actions, "Start goal", "autonomous-start"),
    pause = button(actions, "Pause", "autonomous-pause"),
    resume = button(actions, "Resume", "autonomous-resume"),
    stop = button(actions, "Stop", "autonomous-stop"),
    download = button(actions, "Download goal audit", "autonomous-download"),
    checkSop = button(actions, "Check SOP records", "autonomous-sop-check");
  const status = el("p", "No autonomous goal started.");
  status.id = "autonomous-status";
  status.setAttribute("role", "status");
  autonomous.append(status);
  const output = el("pre");
  output.id = "autonomous-output";
  output.tabIndex = 0;
  output.setAttribute("aria-label", "Autonomous progress and evidence");
  autonomous.append(output);
  const sopOutput = el("pre");
  sopOutput.id = "autonomous-sop-report";
  sopOutput.tabIndex = 0;
  sopOutput.setAttribute("aria-label", "SOP record checks and required review");
  autonomous.append(sopOutput);
  let agent = null,
    active = false,
    snapshot = null,
    conformance = null;
  checkSop.onclick = async () => {
    if (isBusy() || !snapshot?.sop) return;
    setBusy(true);
    sync();
    try {
      conformance = await checkSopConformance({
        record: snapshot.sop,
        runs: snapshot.rounds.filter((r) => r.manifest).map((r) => r.manifest),
        journal: await getJournal(),
        sources: snapshot.sources,
      });
      sopOutput.textContent = JSON.stringify(conformance, null, 2);
    } catch {
      conformance = null;
      sopOutput.textContent =
        "SOP records could not be verified. Keep the goal audit and review its source, recipe and journal records.";
    } finally {
      setBusy(false);
      sync();
    }
  };
  const update = (s) => {
    snapshot = s;
    status.textContent = "Goal " + s.status;
    output.textContent = JSON.stringify(
      {
        status: s.status,
        calls: s.calls,
        bounds: s.bounds,
        rounds: s.rounds.map((r) => ({
          number: r.number,
          status: r.status,
          title: r.proposal?.plan?.title,
          question: r.proposal?.question,
          steps: r.manifest?.steps.map((t) => ({
            id: t.id,
            status: t.status,
            artifact_id: t.result?.artifact?.id,
          })),
          claims: r.report?.claims,
          warnings: r.report?.warnings,
          selected_claim_ids: r.proposal?.claim_ids,
          observations: r.observations?.observations,
          observation_warnings: r.observations?.warnings,
          selected_observation_ids: r.proposal?.observation_ids,
        })),
        error: s.error,
      },
      null,
      2,
    );
    sync();
  };
  start.onclick = async () => {
    if (isBusy()) return;
    if (!goal.value.trim() || !getSources().length) {
      status.textContent =
        "Enter a goal and select an inspected source channel.";
      return;
    }
    const maxRounds = Number(rounds.value),
      maxCalls = Number(calls.value);
    if (
      !Number.isInteger(maxRounds) ||
      maxRounds < 1 ||
      maxRounds > 8 ||
      !Number.isInteger(maxCalls) ||
      maxCalls < 1 ||
      maxCalls > 64
    ) {
      status.textContent = "Use round limits 1–8 and tool limits 1–64.";
      return;
    }
    let sopRecord;
    if (sop.value) {
      try {
        sopRecord = createSopRecord(sop.value, {
          approved_settings: expected.value.trim()
            ? JSON.parse(expected.value)
            : null,
          deviations: deviations.value.trim(),
        });
      } catch {
        status.textContent =
          "Check the approved settings JSON: include source, operations, selection and a nonempty justification. No goal started.";
        return;
      }
    }
    const goalText = [
      sop.value ? sopPrompt(sop.value) : "",
      sopRecord?.approved_settings
        ? "User-approved SOP settings: " +
          JSON.stringify(sopRecord.approved_settings)
        : "",
      deviations.value.trim()
        ? "User-specified choices/deviations: " + deviations.value.trim()
        : "",
      goal.value.trim(),
      sop.value
        ? "Record any additional deviation explicitly in step rationale; ask clarification if a prerequisite is missing."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if ([...goalText].length > 6000) {
      status.textContent =
        "Goal, SOP and deviations exceed 6000 characters; shorten the goal or deviations.";
      return;
    }
    conformance = null;
    sopOutput.textContent = "";
    active = true;
    setBusy(true);
    sync();
    try {
      const connection = await getConnection();
      agent = createAutonomousAgent({ execute, getJournal, onUpdate: update });
      update(
        await agent.start({
          ...connection,
          goal: goalText,
          sourceContexts: structuredClone(getSources()),
          maxRounds,
          maxCalls,
          ...(sopRecord ? { sop: sopRecord } : {}),
        }),
      );
    } catch {
      status.textContent =
        "Goal stopped: connection or execution configuration failed. Check settings and retained audit.";
    } finally {
      active = false;
      setBusy(false);
      sync();
    }
  };
  pause.onclick = () => agent?.pause();
  resume.onclick = () => agent?.resume();
  stop.onclick = () => agent?.stop();
  download.onclick = async () => {
    if (!snapshot) return;
    try {
      save(
        {
          schema_version: 1,
          goal: snapshot,
          journal: await getJournal(),
          ...(conformance ? { sop_conformance: conformance } : {}),
        },
        "afm-autonomous-audit.json",
      );
    } catch {
      status.textContent =
        "Could not export the local journal; goal state remains available.";
    }
  };
  function sync() {
    const busy = isBusy();
    for (const n of [
      question,
      send,
      resetHelp,
      goal,
      sop,
      deviations,
      expected,
      template,
      rounds,
      calls,
      start,
    ])
      n.disabled = busy;
    cancelHelp.disabled = !helpController;
    downloadHelp.disabled = !helpAudits.length;
    start.disabled = busy || !getSources().length;
    pause.disabled = !active;
    resume.disabled = !active;
    stop.disabled = !active;
    download.disabled = !snapshot;
    checkSop.disabled = busy || !snapshot?.sop;
  }
  sync();
  return { sync };
}
