import { proposePlan } from "./model-planner.js";

/** Model conversation stays separate from the local tool journal and execution. */
export function mountModelPanel({
  host,
  getContext,
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
    "Only your messages, selected filename/hash, channel calibration, and support warnings are sent to the configured provider. Raw images and numerical results remain local. Proposed plans never execute automatically.",
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
    for (const input of [endpoint, model, key, prompt, reset])
      input.disabled = isBusy();
    propose.disabled = isBusy() || !getContext();
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
    if (!context)
      return tell("Inspect a loaded source and select a channel first.", true);
    const source = JSON.stringify([
      context.file,
      context.source_sha256,
      context.channel,
    ]);
    if (boundSource !== source) {
      history = [];
      boundSource = source;
      log.replaceChildren();
    }
    controller = new AbortController();
    setBusy(true);
    sync();
    try {
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
        sourceContext: context,
        history,
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
