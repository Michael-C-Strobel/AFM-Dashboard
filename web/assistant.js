import { apiFetch } from "./api.js";
import { validatePlan, runPlan } from "./tool-plans.js";
import { createEvidenceReport } from "./evidence-report.js";

const $ = (id) => document.getElementById("assistant-" + id);
let busy = false,
  inspected = null,
  validated = null,
  manifest = null,
  cancel = false,
  evidence = null,
  evidenceRun = null;
const controls = [
  "refresh",
  "source",
  "channel",
  "inspect",
  "measure",
  "robust",
  "quality",
  "replay",
  "plan",
  "validate",
  "run",
];
function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function sync() {
  for (const id of controls) $(id).disabled = busy;
  for (const id of ["inspect", "measure", "robust", "quality"])
    $(id).disabled = busy || !inspected || !$("channel").value;
  $("validate").disabled = busy || !$("plan").value.trim();
  $("run").disabled = busy || !validated;
  $("cancel").disabled =
    !busy || !manifest || manifest.status !== "running" || cancel;
  $("download-plan").disabled = !$("plan").value.trim();
  $("download-run").disabled = !manifest;
  $("report-create").disabled =
    busy || !manifest || manifest.status === "running";
  $("report-json").disabled = !evidence;
  $("report-markdown").disabled = !evidence;
}
async function api(path, body) {
  const response = await apiFetch(
    path,
    body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Local request failed.");
  return value;
}
async function tool(call) {
  return api("/api/tool", call);
}
function success(envelope) {
  if (envelope.record?.status !== "succeeded" || !envelope.artifact)
    throw new Error(envelope.record?.error || "Tool invocation failed.");
  return envelope.artifact.content.result;
}
function save(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function units(number, unit) {
  return Number.isFinite(number)
    ? number.toPrecision(5) + " " + (unit || "unknown unit")
    : "unavailable";
}
function showSource() {
  const channel = inspected?.channels.find(
    (c) => String(c.id) === $("channel").value,
  );
  if (!channel) return;
  const warnings = [...(inspected.warnings || []), ...(channel.warnings || [])];
  $("source-info").textContent = [
    inspected.file +
      " · " +
      channel.title +
      " · " +
      channel.shape.join(" × ") +
      " pixels",
    "X " +
      units(channel.xreal, channel.xy_unit) +
      " · Y " +
      units(channel.yreal, channel.xy_unit) +
      " · vertical " +
      (channel.z_unit || "unknown unit"),
    "SHA-256 " + inspected.sha256,
    (inspected.support?.status === "validated"
      ? "Validated import subset"
      : "Unverified configuration") +
      ": " +
      (inspected.support?.message || "No support statement available."),
    ...new Set(warnings),
  ].join("\n");
}
function dirty(
  message = "Plan changed. Validate the complete plan before running.",
) {
  validated = null;
  renderPlan();
  sync();
  status(message);
}
function renderPlan() {
  const root = $("steps");
  root.replaceChildren();
  try {
    const plan = JSON.parse($("plan").value);
    if (!Array.isArray(plan.steps)) throw new Error("Missing steps.");
    for (const step of plan.steps) {
      const row = element("li");
      row.append(
        element("strong", step.id + " · " + step.call?.name),
        element("p", step.rationale || "No rationale supplied."),
      );
      const params = element("details"),
        summary = element("summary", "Review exact arguments"),
        pre = element("pre", JSON.stringify(step.call?.arguments, null, 2));
      params.append(summary, pre);
      row.append(params);
      root.append(row);
    }
  } catch {
    root.append(
      element(
        "li",
        "Plan JSON is incomplete or invalid. Validation will show the error.",
      ),
    );
  }
}
async function inspectFile() {
  inspected = null;
  validated = null;
  sync();
  if (!$("source").value) return;
  const result = success(
    await tool({
      name: "inspect_source",
      arguments: { file: $("source").value },
    }),
  );
  inspected = result;
  $("channel").replaceChildren();
  for (const channel of result.channels) {
    const option = element(
      "option",
      String(channel.id) + " · " + channel.title,
    );
    option.value = String(channel.id);
    $("channel").append(option);
  }
  showSource();
  status("Source inspected. Choose a starter; no processing has run.");
  sync();
}
$("refresh").onclick = async () => {
  if (busy) return;
  busy = true;
  sync();
  try {
    const previous = $("source").value;
    const result = success(await tool({ name: "list_sources", arguments: {} }));
    $("source").replaceChildren();
    for (const source of result.sources) {
      const option = element("option", source.file);
      option.value = source.file;
      $("source").append(option);
    }
    if (result.sources.some((s) => s.file === previous))
      $("source").value = previous;
    if (!result.sources.length) {
      inspected = null;
      status(
        "No loaded sources. Import a measurement in Data & processing, then refresh.",
      );
    } else await inspectFile();
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    sync();
  }
};
$("source").onchange = async () => {
  if (busy) return;
  busy = true;
  sync();
  try {
    await inspectFile();
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    sync();
  }
};
$("channel").onchange = () => {
  showSource();
  validated = null;
  sync();
  status(
    "Plan channel changed. Choose a starter to bind a new plan; existing draft is unchanged.",
  );
};
function starter(kind) {
  if (busy || !inspected) return;
  const identity = {
    file: inspected.file,
    source_sha256: inspected.sha256,
    channel: $("channel").value,
  };
  const steps = [
    {
      id: "inspect",
      rationale:
        "Record source calibration, supported import configuration, and warnings before interpreting data.",
      call: { name: "inspect_source", arguments: { file: identity.file } },
    },
  ];
  if (kind === "quality")
    steps.push({
      id: "quality",
      rationale:
        "Check original acquisition boundaries without classifying defects or modifying values.",
      call: {
        name: "check_quality",
        arguments: { ...identity, boundary_sigma: 6 },
      },
    });
  else if (kind !== "inspect") {
    steps.push({
      id: "analyze",
      rationale:
        kind === "robust"
          ? "Subtract an explicit robust plane and zero the minimum; measure descriptive surface roughness. This is not a reconstruction of manual processing."
          : "Measure original channel values with no processing operations.",
      call: {
        name: "analyze_surface",
        arguments: {
          ...identity,
          operations:
            kind === "robust"
              ? [
                  { name: "robust_plane", params: { iterations: 5, sigma: 3 } },
                  { name: "zero_min", params: {} },
                ]
              : [],
        },
      },
    });
    if ($("replay").checked)
      steps.push({
        id: "replay",
        rationale:
          "Strictly replay the generated recipe against the same source and verify its output identity.",
        call: {
          name: "replay_recipe",
          arguments: {
            file: identity.file,
            source_sha256: identity.source_sha256,
            recipe_artifact: "$step:analyze",
          },
        },
      });
  }
  $("plan").value = JSON.stringify(
    {
      schema_version: 1,
      title: {
        inspect: "Inspect source",
        quality: "Check acquisition",
        robust: "Robust plane and roughness",
        measure: "Measure current values",
      }[kind],
      steps,
    },
    null,
    2,
  );
  dirty("Draft prepared. Review each step and its arguments, then validate.");
}
for (const kind of ["inspect", "measure", "robust", "quality"])
  $(kind).onclick = () => starter(kind);
$("plan").oninput = () => dirty();
$("validate").onclick = () => {
  try {
    validated = validatePlan(JSON.parse($("plan").value));
    $("plan").value = JSON.stringify(validated, null, 2);
    renderPlan();
    status(
      "Plan validated. " +
        validated.steps.length +
        " steps reviewed; validation executes no tools.",
    );
  } catch (error) {
    validated = null;
    status("Validation failed: " + error.message, true);
  }
  sync();
};
function renderResults() {
  const root = $("results");
  root.replaceChildren();
  if (!manifest) return;
  for (const step of manifest.steps) {
    const row = element("article", undefined, "assistant-result");
    row.dataset.step = step.id;
    row.dataset.status = step.status;
    row.append(element("h3", step.id + " / " + step.status));
    if (step.error) row.append(element("p", step.error, "error"));
    const artifact = step.result?.artifact,
      result = artifact?.content?.result;
    if (result?.statistics) {
      const s = result.statistics;
      row.append(
        element(
          "p",
          "Sa " +
            units(s.sa, s.z_unit) +
            " · Sq " +
            units(s.sq, s.z_unit) +
            " · valid " +
            s.valid_count,
          "assistant-metrics",
        ),
      );
    }
    if (result?.replay_verified)
      row.append(element("p", "Strict recipe replay verified."));
    if (result?.report?.counts)
      row.append(
        element(
          "p",
          "Acquisition counts: " + JSON.stringify(result.report.counts),
          "assistant-metrics",
        ),
      );
    for (const warning of new Set([
      ...(result?.warnings || []),
      ...(result?.quality?.warnings || []),
    ]))
      row.append(element("p", warning, "hint"));
    if (artifact) {
      const actions = element("div", undefined, "toolbar");
      const download = element("button", "Download artifact JSON");
      download.onclick = () =>
        save(artifact, "afm-" + step.id + "-artifact.json");
      actions.append(download);
      if (result?.recipe) {
        const recipe = element("button", "Download recipe");
        recipe.onclick = () =>
          save(result.recipe, "afm-" + step.id + "-recipe.json");
        actions.append(recipe);
      }
      const detail = element("details"),
        summary = element("summary", "Artifact " + artifact.id),
        pre = element("pre", JSON.stringify(artifact, null, 2));
      const anchor = "artifact-" + artifact.sha256;
      if (!document.getElementById(anchor)) detail.id = anchor;
      detail.append(summary, pre);
      row.append(actions, detail);
    }
    root.append(row);
  }
}
$("run").onclick = async () => {
  if (busy || !validated) return;
  // The runner validates again and snapshots before executing its first tool.
  const snapshot = structuredClone(validated);
  busy = true;
  cancel = false;
  manifest = null;
  evidence = null;
  evidenceRun = null;
  renderEvidence();
  sync();
  try {
    manifest = await runPlan(snapshot, {
      execute: tool,
      shouldCancel: () => cancel,
      onUpdate: (update) => {
        manifest = structuredClone(update);
        renderResults();
        sync();
        const complete = manifest.steps.filter(
          (s) => s.status === "complete",
        ).length;
        status(
          (cancel ? "Cancellation requested; finishing current step. " : "") +
            "Plan " +
            manifest.status +
            " · " +
            complete +
            "/" +
            manifest.steps.length +
            " completed",
          manifest.status === "failed",
        );
      },
    });
    renderResults();
    status(
      "Plan " + manifest.status + ". Completed artifacts remain available.",
      manifest.status === "failed",
    );
  } catch (error) {
    status("Plan execution stopped: " + error.message, true);
  } finally {
    busy = false;
    sync();
  }
};
$("cancel").onclick = () => {
  cancel = true;
  status(
    "Cancellation requested. The current step finishes; subsequent steps will not run.",
  );
  sync();
};
$("download-plan").onclick = () => {
  try {
    save(JSON.parse($("plan").value), "afm-plan.json");
  } catch (error) {
    status("Cannot download invalid plan JSON: " + error.message, true);
  }
};
$("download-run").onclick = () => {
  if (manifest) save(manifest, "afm-plan-run.json");
};
$("download-journal").onclick = async () => {
  try {
    save(await api("/api/tool-journal"), "afm-tool-journal.json");
  } catch (error) {
    status(error.message, true);
  }
};

function renderEvidence() {
  const root = $("report");
  root.replaceChildren();
  if (!evidence) return;
  root.append(element("h3", "Evidence report · " + evidenceRun.title));
  root.append(
    element(
      "p",
      "Run " + evidenceRun.status + " · plan SHA-256 " + evidence.plan_sha256,
      "assistant-report-identity",
    ),
  );
  root.append(
    element(
      "p",
      "Artifact and journal integrity verification is not a signature or calibration certification. These recorded numeric results do not establish independent sample counts, confidence intervals, or defect identities.",
      "assistant-report-notice",
    ),
  );
  const wrapper = element("div", undefined, "assistant-report-table");
  const table = element("table"),
    caption = element("caption", "Verified numeric claims");
  table.append(caption);
  const head = element("thead"),
    header = element("tr");
  for (const title of [
    "Step",
    "Metric",
    "Value",
    "Unit",
    "Definition",
    "Evidence",
  ]) {
    const cell = element("th", title);
    cell.scope = "col";
    header.append(cell);
  }
  head.append(header);
  table.append(head);
  const body = element("tbody");
  for (const claim of evidence.claims) {
    const row = element("tr");
    row.dataset.sourceSha256 = claim.source_sha256;
    row.dataset.channel = claim.channel;
    for (const value of [
      claim.step_id,
      claim.metric,
      String(claim.value),
      claim.unit ?? "unknown",
      claim.definition,
    ])
      row.append(element("td", value));
    const cell = element("td"),
      link = element("a", claim.step_id + " artifact");
    link.href = "#artifact-" + claim.artifact_id.slice(9);
    link.title = claim.artifact_id;
    link.onclick = (event) => {
      event.preventDefault();
      const target = document.getElementById(
        link.getAttribute("href").slice(1),
      );
      if (target) {
        target.open = true;
        target.querySelector("summary").focus();
        target.scrollIntoView({ block: "nearest" });
      }
    };
    cell.append(link);
    row.append(cell);
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  root.append(wrapper);
  if (!evidence.claims.length)
    root.append(
      element(
        "p",
        "No numeric analysis claims were produced by completed verified analysis steps.",
      ),
    );
  root.append(element("h3", "Recorded warnings"));
  const warnings = element("ul");
  for (const warning of evidence.warnings)
    warnings.append(element("li", warning));
  if (evidence.warnings.length) root.append(warnings);
  else root.append(element("p", "No additional recorded warnings."));
}
$("report-create").onclick = async () => {
  if (busy || !manifest || manifest.status === "running") return;
  busy = true;
  sync();
  const snapshot = structuredClone(manifest);
  status(
    "Verifying plan, journal, artifact identities, and numeric provenance…",
  );
  try {
    evidence = await createEvidenceReport({
      manifest: snapshot,
      journal: await api("/api/tool-journal"),
    });
    evidenceRun = { title: snapshot.plan.title, status: snapshot.status };
    renderEvidence();
    status(
      "Evidence report verified for " +
        snapshot.plan.title +
        ". Integrity verification does not certify calibration.",
    );
  } catch (error) {
    evidence = null;
    evidenceRun = null;
    renderEvidence();
    status("Evidence verification failed: " + error.message, true);
  } finally {
    busy = false;
    sync();
  }
};
$("report-json").onclick = () => {
  if (evidence) save(evidence, "afm-evidence-report.json");
};
$("report-markdown").onclick = () => {
  if (!evidence) return;
  const url = URL.createObjectURL(
    new Blob([evidence.markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "afm-evidence-report.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

sync();
