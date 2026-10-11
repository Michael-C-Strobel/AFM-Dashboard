import { proposePlan } from "./model-planner.js";

/** Model conversation stays separate from the local tool journal and execution. */
export function mountModelPanel({
  host,
  getContext,
  getEvidenceOptions = () => null,
  getEvidenceBundle = async () => {
    throw new Error("No verified evidence available.");
  },
  acceptPlan,
  isBusy,
  setBusy,
}) {
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const panel = el("details");
  panel.className = "model-panel";
  panel.append(el("summary", "Ask for a plan · optional model connection"));
  const note = el(
    "p",
    "Your messages, explicitly selected source/channel calibration and support warnings are sent to the configured provider. Verified compact surface evidence is sent only when selected below. Raw images, full recipes and journals remain local. Proposed plans never execute automatically.",
  );
  note.className = "hint";
  panel.append(note);
  const settings = el("div");
  settings.className = "toolbar";
  function field(label, id, type, placeholder) {
    const wrapper = el("label", label),
      input = el("input");
    input.id = "model-" + id;
    input.type = type;
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    wrapper.append(input);
    settings.append(wrapper);
    return input;
  }
  const endpoint = field(
    "Chat Completions endpoint",
    "endpoint",
    "url",
    "https://provider.example/v1/chat/completions",
  );
  const model = field("Model identifier", "name", "text", "Provider model ID");
  const key = field(
    "API key (session only, optional for local providers)",
    "key",
    "password",
    "Never included in exports",
  );
  const clearKey = el("button", "Clear credential");
  clearKey.id = "model-clear-key";
  clearKey.onclick = () => {
    key.value = "";
  };
  settings.append(clearKey);
  panel.append(settings);
  const policy = el("p", "Checking this host’s provider connection policy…");
  policy.className = "hint";
  panel.append(policy);
  let serverConfig = undefined;
  const configReady = fetch("/__afm_config.json", { cache: "no-store" })
    .then(async (response) => {
      if (response.ok) serverConfig = await response.json();
    })
    .catch(() => {})
    .finally(() => {
      policy.textContent = serverConfig?.model_origin
        ? "This demo permits provider connections to " +
          serverConfig.model_origin +
          "."
        : serverConfig
          ? "Model connections are disabled on this demo. Restart with AFM_MODEL_ORIGIN set to your provider’s origin to enable them."
          : "This static host manages its own connection policy; the provider must allow browser CORS.";
    });
  const contextBox = el("section");
  contextBox.className = "model-context";
  contextBox.setAttribute("aria-label", "Provider context selection");
  contextBox.append(el("h3", "Select provider context"));
  const addSource = el("button", "Add current channel");
  addSource.id = "model-add-source";
  const sourceList = el("ul");
  sourceList.id = "model-sources";
  const fallback = el("p");
  fallback.id = "model-source-fallback";
  fallback.className = "hint";
  const evidenceBox = el("fieldset");
  evidenceBox.id = "model-evidence";
  const evidenceHelp = el(
    "p",
    "Verify a local run's evidence report to make surface/replay steps available. Nothing is selected automatically. Up to four steps; any recorded reference source must also be selected.",
  );
  evidenceHelp.className = "hint";
  contextBox.append(addSource, fallback, sourceList, evidenceHelp, evidenceBox);
  panel.append(contextBox);
  let selectedSources = [],
    selectedEvidence = [],
    evidenceRunId = null,
    contextSignature = null;
  function clearHistory(message) {
    history = [];
    boundSource = null;
    log.replaceChildren();
    if (message) tell(message);
  }
  function contextDescription(context) {
    return `${context.file} · channel ${context.channel} (${context.title})\nSHA-256 ${context.source_sha256}\nCalibration ${JSON.stringify(context.geometry)}\nSupport / warnings: ${(context.warnings || []).join(" · ") || "none recorded"}`;
  }
  function renderSources() {
    sourceList.replaceChildren(
      ...selectedSources.map((context, index) => {
        const item = el("li"),
          text = el("p", contextDescription(context)),
          remove = el(
            "button",
            "Remove " + context.file + " channel " + context.channel,
          );
        remove.disabled = isBusy();
        remove.onclick = () => {
          if (isBusy()) return;
          selectedSources.splice(index, 1);
          clearHistory(
            "Source selection changed. Conversation cleared; earlier audits remain available.",
          );
          renderSources();
          sync();
        };
        item.append(text, remove);
        return item;
      }),
    );
  }
  function renderEvidence(options) {
    evidenceBox.replaceChildren(
      el("legend", "Opt in to verified surface evidence"),
    );
    if (!options?.steps.length) {
      evidenceBox.append(el("p", "No verified surface steps available."));
      return;
    }
    for (const step of options.steps) {
      const label = el("label"),
        checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.value = step.id;
      checkbox.checked = selectedEvidence.includes(step.id);
      checkbox.onchange = () => {
        if (isBusy()) return;
        if (checkbox.checked && selectedEvidence.length >= 4) {
          checkbox.checked = false;
          tell("Select at most four verified steps.", true);
          return;
        }
        selectedEvidence = checkbox.checked
          ? [...selectedEvidence, step.id]
          : selectedEvidence.filter((id) => id !== step.id);
        clearHistory(
          "Evidence selection changed. Conversation cleared; evidence is sent only on the next explicit request.",
        );
        sync();
      };
      label.append(
        checkbox,
        el(
          "span",
          `${step.label} · ${step.claims_count} claims · ${step.file} channel ${step.channel} · SHA-256 ${step.source_sha256}`,
        ),
      );
      evidenceBox.append(label);
    }
  }
  addSource.onclick = () => {
    if (isBusy()) return;
    const context = getContext();
    if (!context)
      return tell("Inspect a loaded source and channel first.", true);
    if (selectedSources.length >= 8)
      return tell("Select at most eight source/channel contexts.", true);
    if (
      selectedSources.some(
        (c) =>
          c.file === context.file &&
          c.source_sha256 === context.source_sha256 &&
          c.channel === context.channel,
      )
    )
      return tell("That exact source/channel is already selected.");
    selectedSources.push(structuredClone(context));
    clearHistory(
      "Source added. The explicit list now defines all transmitted sources; earlier audits remain available.",
    );
    renderSources();
    sync();
  };
  const log = el("ol");
  log.id = "model-conversation";
  log.setAttribute("aria-label", "Model planning conversation");
  panel.append(log);
  const label = el("label", "Describe the analysis or answer a clarification");
  const prompt = el("textarea");
  prompt.id = "model-prompt";
  prompt.rows = 3;
  prompt.maxLength = 8000;
  prompt.placeholder =
    "For this height channel, propose robust leveling, roughness measurement, and a strict replay check.";
  label.append(prompt);
  panel.append(label);
  const actions = el("div");
  actions.className = "toolbar";
  const propose = el("button", "Propose plan"),
    cancel = el("button", "Cancel request"),
    download = el("button", "Download conversation audit"),
    reset = el("button", "New conversation");
  propose.id = "model-propose";
  cancel.id = "model-cancel";
  download.id = "model-download";
  reset.id = "model-reset";
  actions.append(propose, cancel, download, reset);
  panel.append(actions);
  const status = el("p", "No provider request sent.");
  status.id = "model-status";
  status.setAttribute("role", "status");
  panel.append(status);
  host.append(panel);
  let controller = null,
    audits = [],
    history = [],
    boundSource = null;
  const tell = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };
  function sync() {
    const options = getEvidenceOptions();
    if (evidenceRunId !== (options?.run_id ?? null)) {
      evidenceRunId = options?.run_id ?? null;
      selectedEvidence = [];
      clearHistory(
        "Verified evidence changed. Evidence selection and conversation cleared; earlier audits remain available.",
      );
      renderEvidence(options);
    }
    if (!evidenceBox.childNodes.length) renderEvidence(options);
    const contexts = selectedSources.length
      ? selectedSources
      : getContext()
        ? [getContext()]
        : [];
    const signature = JSON.stringify([
      contexts,
      selectedEvidence,
      evidenceRunId,
    ]);
    if (contextSignature !== null && signature !== contextSignature)
      clearHistory();
    contextSignature = signature;
    fallback.textContent = selectedSources.length
      ? `Explicit selection: ${selectedSources.length}/8 channels. Only this list is sent; the current inspected channel is not added automatically.`
      : getContext()
        ? "Default: current inspected channel only.\n" +
          contextDescription(getContext())
        : "Inspect a channel to use the single-source default.";
    for (const input of [
      endpoint,
      model,
      key,
      clearKey,
      prompt,
      reset,
      addSource,
    ])
      input.disabled = isBusy();
    addSource.disabled =
      isBusy() || !getContext() || selectedSources.length >= 8;
    for (const input of contextBox.querySelectorAll("input,button"))
      input.disabled =
        isBusy() ||
        (input === addSource && (!getContext() || selectedSources.length >= 8));
    propose.disabled = isBusy() || !contexts.length;
    cancel.disabled = !controller;
    download.disabled = !audits.length;
  }
  function entry(role, text) {
    const item = el("li"),
      title = el("strong", role),
      body = el("p", text);
    item.append(title, body);
    log.append(item);
  }
  reset.onclick = () => {
    history = [];
    boundSource = null;
    log.replaceChildren();
    tell(
      "New conversation. Earlier request audits remain available for download.",
    );
  };
  cancel.onclick = () => controller?.abort();
  download.onclick = () => {
    const url = URL.createObjectURL(
      new Blob(
        [JSON.stringify({ schema_version: 1, requests: audits }, null, 2)],
        { type: "application/json" },
      ),
    );
    const link = el("a");
    link.href = url;
    link.download = "afm-model-conversation.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  propose.onclick = async () => {
    if (isBusy()) return;
    if (!prompt.value.trim())
      return tell("Enter an analysis request first.", true);
    if (audits.length >= 16)
      return tell(
        "This session reached 16 provider requests. Download the audit and reload to start another session.",
        true,
      );
    const context = getContext();
    if (!selectedSources.length && !context)
      return tell("Inspect a loaded source and select a channel first.", true);
    const contextArguments = selectedSources.length
      ? { sourceContexts: structuredClone(selectedSources) }
      : { sourceContext: structuredClone(context) };
    const stepIds = selectedEvidence.slice();
    const source = JSON.stringify([contextArguments, stepIds, evidenceRunId]);
    if (boundSource !== source) {
      history = [];
      boundSource = source;
      log.replaceChildren();
    }
    controller = new AbortController();
    setBusy(true);
    sync();
    try {
      const evidenceBundle = stepIds.length
        ? structuredClone(await getEvidenceBundle(stepIds))
        : null;
      await configReady;
      if (
        serverConfig !== undefined &&
        new URL(endpoint.value).origin !== serverConfig?.model_origin
      )
        throw new Error(
          "This demo does not permit that provider origin. Set AFM_MODEL_ORIGIN to the endpoint origin and restart the demo.",
        );
      const question = prompt.value.trim();
      tell("Requesting a proposal. No analysis tools are running.");
      entry("You", question);
      const result = await proposePlan({
        endpoint: endpoint.value.trim(),
        model: model.value.trim(),
        apiKey: key.value,
        prompt: question,
        ...contextArguments,
        ...(evidenceBundle ? { evidenceBundle } : {}),
        history: structuredClone(history),
        signal: controller.signal,
      });
      audits.push(result.audit);
      if (!result.proposal) {
        entry("Request " + result.audit.status, result.audit.error);
        tell(result.audit.error, true);
        return;
      }
      history.push(
        { role: "user", content: question },
        { role: "assistant", content: JSON.stringify(result.proposal) },
      );
      // Keep complete exchanges within the adapter’s explicit context budget.
      while (
        history.length > 12 ||
        history.reduce((n, m) => n + [...m.content].length, 0) > 16000 ||
        history.some((m) => [...m.content].length > 8000)
      )
        history.splice(0, 2);
      prompt.value = "";
      if (result.proposal.kind === "clarification") {
        entry("Model clarification", result.proposal.question);
        tell(
          "Answer the clarification to request another proposal; no tools executed.",
        );
      } else if (result.proposal.kind === "evidence") {
        const context = result.audit.evidenceContext;
        const item = el("li");
        item.append(
          el(
            "strong",
            "Model-selected recorded evidence · not a new analysis or interpretation",
          ),
        );
        item.append(
          el(
            "p",
            `Plan ${context.plan_sha256} · journal ${context.journal_head_sha256}`,
          ),
        );
        for (const id of result.proposal.claim_ids) {
          const claim = context.claims.find((c) => c.claim_id === id);
          const row = el(
            "p",
            `${claim.file} · channel ${claim.channel} · source SHA-256 ${claim.source_sha256}\n${claim.metric}: ${claim.value} ${claim.unit ?? "(unit unknown)"}\n${claim.definition}\nClaim ${claim.claim_id}`,
          );
          const link = el("a", "Exact local artifact " + claim.artifact_id);
          link.href = "#artifact-" + claim.artifact_id.slice(9);
          row.append(el("br"), link);
          item.append(row);
        }
        for (const warning of context.warnings || [])
          item.append(el("p", warning));
        log.append(item);
        tell(
          "Selected recorded evidence shown. No draft changed and no tools executed.",
        );
      } else {
        acceptPlan(result.proposal.plan);
        entry(
          "Model proposal",
          result.proposal.plan.title +
            " · " +
            result.proposal.plan.steps.length +
            " steps. Review the draft below.",
        );
        tell(
          "Proposal copied to the review area. Validate and explicitly run it when ready; no tools executed.",
        );
      }
    } catch (error) {
      tell(error.message || "Provider configuration failed.", true);
    } finally {
      controller = null;
      setBusy(false);
      sync();
    }
  };
  sync();
  return { sync };
}
