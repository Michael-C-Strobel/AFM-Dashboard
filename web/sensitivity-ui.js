import { apiFetch } from "./api.js";
import { getAnalysisSnapshot } from "./app.js";
const $ = (id) => document.getElementById("sensitivity-" + id);
let baseline = null,
  result = null,
  busy = false;
const fmt = (v) => (Number.isFinite(v) ? v.toExponential(4) : "unavailable");
function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function sync() {
  for (const id of ["capture", "variants", "calibration-note", "model-note"])
    $(id).disabled = busy;
  for (const id of ["add-current", "add-mean", "add-plane", "run"])
    $(id).disabled = busy || !baseline;
  for (const id of ["json", "tsv", "tar", "metric"])
    $(id).disabled = busy || !result;
}
function invalidate(message) {
  result = null;
  for (const id of ["metric", "rows", "warnings", "assumptions", "range"])
    $(id).replaceChildren();
  sync();
  draw();
  status(message);
}
$("capture").onclick = () => {
  if (busy) return;
  const snapshot = getAnalysisSnapshot();
  if (!snapshot) {
    status(
      "Capture refused: current analysis is dirty, pending or unavailable. Recalculate first.",
      true,
    );
    return;
  }
  baseline = structuredClone(snapshot.recipe);
  $("variants").value = "[]";
  $("source").textContent =
    `Baseline: ${baseline.source.file} · channel ${baseline.source.channel} (${baseline.source.title})\nSource SHA-256 ${baseline.source.sha256}\nProcessed SHA-256 ${baseline.output.sha256}\nOperations ${JSON.stringify(baseline.operations)}\nSelection ${JSON.stringify(baseline.selection)}\nProfile ${JSON.stringify(baseline.profile)} · plateaus ${JSON.stringify(baseline.plateaus)} · reference ${JSON.stringify(baseline.reference)}\nDetached baseline: later viewer edits do not change this recipe.`;
  invalidate(
    "Baseline captured. Add and review alternatives; nothing has been executed.",
  );
};
function definitions() {
  const values = JSON.parse($("variants").value);
  if (!Array.isArray(values))
    throw Error("Variant definitions must be a JSON array.");
  return values;
}
function add(label, operations, selection) {
  const variants = definitions();
  if (variants.length >= 16)
    throw Error("At most 16 alternatives are supported.");
  if (!Array.isArray(operations) || operations.length > 32)
    throw Error("Each alternative supports at most 32 operations.");
  let n = 1;
  while (variants.some((v) => v?.id === "variant_" + n)) n++;
  variants.push({
    id: "variant_" + n,
    label,
    operations: structuredClone(operations),
    selection: structuredClone(selection),
  });
  $("variants").value = JSON.stringify(variants, null, 2);
  invalidate(
    "Alternative added for review. Run explicitly when definitions are ready.",
  );
}
for (const name of ["mean", "plane"])
  $("add-" + name).onclick = () => {
    if (busy || !baseline) return;
    try {
      add(
        "Baseline + " + (name === "mean" ? "mean removal" : "plane leveling"),
        [...baseline.operations, { name, params: {} }],
        baseline.selection,
      );
    } catch (error) {
      status(error.message, true);
    }
  };
$("add-current").onclick = () => {
  if (busy || !baseline) return;
  const snapshot = getAnalysisSnapshot();
  if (!snapshot) {
    status("Add current refused: recalculate the main viewer first.", true);
    return;
  }
  const r = snapshot.recipe;
  if (
    ["file", "sha256", "channel"].some(
      (k) => r.source[k] !== baseline.source[k],
    )
  ) {
    status(
      "Add current refused: source file, SHA-256 and channel must match the captured baseline.",
      true,
    );
    return;
  }
  try {
    add("Current processing and selection", r.operations, r.selection);
  } catch (error) {
    status(error.message, true);
  }
};
for (const id of ["variants", "calibration-note", "model-note"])
  $(id).addEventListener("input", () =>
    invalidate(
      "Definitions or assumptions changed. Run again for a current report.",
    ),
  );
async function request(path, body) {
  const response = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const e = await response.json();
    throw Error(e.detail || e.error || "Sensitivity request failed.");
  }
  return response;
}
$("run").onclick = async () => {
  if (busy || !baseline) return;
  invalidate("Validating reviewed alternatives…");
  try {
    const variants = definitions();
    if (variants.length < 1 || variants.length > 16)
      throw Error("Review between 1 and 16 alternatives before running.");
    const assumptions = {
      calibration_note: $("calibration-note").value,
      model_note: $("model-note").value,
    };
    if (Object.values(assumptions).some((v) => v.length > 2000))
      throw Error("Each assumptions note supports at most 2000 characters.");
    const body = structuredClone({
      baseline_recipe: baseline,
      variants,
      assumptions,
    });
    busy = true;
    sync();
    status(
      "Strictly replaying baseline and executing reviewed alternatives sequentially…",
    );
    result = await (await request("/api/sensitivity", body)).json();
    for (const m of result.summary.metrics) {
      const option = document.createElement("option");
      option.value = m.key;
      option.textContent = m.label + " · " + (m.unit || "unit not specified");
      $("metric").append(option);
    }
    $("warnings").textContent = [
      ...new Set([
        ...(result.warnings || []),
        ...(result.summary.warnings || []),
        "Selection and processing changes may alter the measured population. These alternatives are not independent observations.",
      ]),
    ].join("\n");
    $("assumptions").textContent =
      `Calibration uncertainty: ${result.calibration_uncertainty.status} (not assessed numerically)\nCalibration note: ${result.calibration_uncertainty.note || "None supplied"}\nMeasurement-model note: ${result.model_note || "None supplied"}`;
    render();
    status(
      result.status === "partial"
        ? "Partial sensitivity report: failed alternatives are retained below."
        : "Sensitivity report complete. Review alternatives and range membership.",
    );
  } catch (error) {
    result = null;
    status(error.message, true);
  } finally {
    busy = false;
    sync();
    draw();
  }
};
function metric() {
  return result?.summary.metrics.find((m) => m.key === $("metric").value);
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function render() {
  const m = metric();
  if (!m) return;
  const range = m.range;
  $("range").textContent =
    `${m.label} · ${m.unit || "unit not specified"}\nRange ${fmt(range.minimum)} to ${fmt(range.maximum)}; span ${fmt(range.span)}; maximum absolute delta ${fmt(range.max_abs_delta)}\nMembership (${range.count}): ${range.member_ids.join(", ")}. Includes baseline and available successful alternatives; not a confidence interval.`;
  const table = document.createElement("table"),
    caption = document.createElement("caption"),
    head = document.createElement("thead"),
    body = document.createElement("tbody"),
    headers = document.createElement("tr");
  caption.textContent = "All analysis outcomes — " + m.label;
  for (const text of [
    "Analysis / definition",
    "Status / reason",
    "Value",
    "Signed delta",
    "Relative delta (unitless)",
    "Valid / excluded pixels",
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = text;
    headers.append(th);
  }
  head.append(headers);
  const records = [
    {
      id: "baseline",
      label: "Captured baseline",
      status: "succeeded",
      result: result.baseline,
    },
    ...result.variants,
  ];
  for (const record of records) {
    const mv = m.values.find((v) => v.id === record.id);
    const definition =
      record.id === "baseline"
        ? result.request.baseline_recipe
        : result.request.variants.find((v) => v.id === record.id);
    const row = document.createElement("tr");
    row.className =
      record.id === "baseline"
        ? "baseline"
        : record.status === "failed"
          ? "failed"
          : "";
    const label = document.createElement("td");
    label.textContent = record.label + " (" + record.id + ")";
    const details = document.createElement("details"),
      summary = document.createElement("summary"),
      pre = document.createElement("pre");
    summary.textContent = "Processing and selection";
    pre.textContent = JSON.stringify(
      { operations: definition?.operations, selection: definition?.selection },
      null,
      2,
    );
    details.append(summary, pre);
    label.append(details);
    if (record.result?.recipe) {
      const button = document.createElement("button");
      button.textContent = "Download recipe";
      button.onclick = () =>
        download(
          new Blob([JSON.stringify(record.result.recipe, null, 2) + "\n"], {
            type: "application/json",
          }),
          record.id + "-recipe.json",
        );
      label.append(button);
    }
    row.append(label);
    const s = record.result?.statistics;
    for (const text of [
      record.status +
        (record.error ? " · " + record.error : "") +
        (mv?.reason ? " · " + mv.reason : ""),
      fmt(mv?.value),
      fmt(mv?.delta),
      fmt(mv?.relative_delta),
      s ? `${s.valid_count} / ${s.excluded_count}` : "unavailable",
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      row.append(td);
    }
    body.append(row);
  }
  table.append(caption, head, body);
  $("rows").replaceChildren(table);
  draw();
}
function draw() {
  const node = $("plot"),
    w = node.clientWidth,
    h = node.clientHeight;
  if (!w || !h) return;
  const dpr = globalThis.devicePixelRatio || 1;
  node.width = Math.round(w * dpr);
  node.height = Math.round(h * dpr);
  const ctx = node.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#f2f5fa";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "11px system-ui";
  ctx.fillStyle = "#62718a";
  const m = metric();
  if (!m) {
    ctx.fillText("Run reviewed alternatives to inspect metric values.", 12, 24);
    return;
  }
  const values = m.values,
    finite = values.filter((v) => Number.isFinite(v.value));
  if (!finite.length) {
    ctx.fillText(
      "No available values for this metric. See outcome table.",
      12,
      24,
    );
    return;
  }
  let min = Math.min(...finite.map((v) => v.value)),
    max = Math.max(...finite.map((v) => v.value));
  const pad = (max - min) * 0.1 || Math.abs(max) * 0.1 || 1;
  min -= pad;
  max += pad;
  const left = 80,
    right = w - 20,
    top = 25,
    bottom = h - 50,
    yp = (v) => bottom - ((v - min) / (max - min)) * (bottom - top),
    xp = (i) => left + ((i + 0.5) * (right - left)) / values.length;
  ctx.strokeStyle = "#aab8ca";
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();
  ctx.fillStyle = "#35465e";
  ctx.textAlign = "right";
  ctx.fillText(fmt(max), left - 5, top + 4);
  ctx.fillText(fmt(min), left - 5, bottom);
  ctx.textAlign = "left";
  ctx.fillText(m.label + " / " + (m.unit || "unit not specified"), left, 13);
  if (Number.isFinite(m.baseline)) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#bd861b";
    ctx.beginPath();
    ctx.moveTo(left, yp(m.baseline));
    ctx.lineTo(right, yp(m.baseline));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  values.forEach((v, i) => {
    const x = xp(i);
    if (Number.isFinite(v.value)) {
      ctx.fillStyle = i === 0 ? "#ba831e" : "#355ece";
      ctx.beginPath();
      ctx.arc(x, yp(v.value), 4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "#8e392a";
      ctx.textAlign = "center";
      ctx.fillText("×", x, bottom - 8);
    }
    ctx.fillStyle = "#35465e";
    ctx.save();
    ctx.translate(x, bottom + 10);
    ctx.rotate(-Math.PI / 5);
    ctx.textAlign = "right";
    ctx.fillText(i === 0 ? "baseline" : String(i), 0, 0);
    ctx.restore();
  });
  ctx.textAlign = "left";
  ctx.fillText(
    "Numbers follow variant order in the outcome table; × = unavailable.",
    left,
    h - 5,
  );
}
$("metric").onchange = render;
$("json").onclick = () => {
  if (result && !busy)
    download(
      new Blob([JSON.stringify(result, null, 2) + "\n"], {
        type: "application/json",
      }),
      "sensitivity-report.json",
    );
};
for (const format of ["tsv", "tar"])
  $(format).onclick = async () => {
    if (!result || busy) return;
    busy = true;
    sync();
    status(
      "Verifying saved report, successful recipes and recorded failures before export…",
    );
    try {
      const response = await request("/api/sensitivity-export", {
        report: structuredClone(result),
        format,
      });
      download(await response.blob(), "sensitivity-evidence." + format);
      status("Verified sensitivity " + format.toUpperCase() + " downloaded.");
    } catch (error) {
      status(error.message, true);
    } finally {
      busy = false;
      sync();
    }
  };
new ResizeObserver(draw).observe($("plot"));
sync();
draw();
