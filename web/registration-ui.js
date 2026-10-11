import { apiFetch } from "./api.js";
import { getAnalysisSnapshot } from "./app.js";
const $ = (id) => document.getElementById("registration-" + id);
const captures = { fixed: null, moving: null };
let result = null,
  measuredRequest = null,
  busy = false;
const fmt = (value) => (Number.isFinite(value) ? value.toExponential(3) : "—");
const unit = (value) => value || "unknown unit";
function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function sync() {
  const auto = $("mode").value === "automatic";
  $("manual").hidden = auto;
  $("automatic").hidden = !auto;
  for (const id of ["capture-fixed", "capture-moving", "mode"])
    $(id).disabled = busy;
  for (const id of ["tx", "ty", "interpolation"]) $(id).disabled = busy || auto;
  for (const id of ["radius-x", "radius-y", "min-overlap"])
    $(id).disabled = busy || !auto;
  $("run").disabled = busy || !captures.fixed || !captures.moving;
  $("json").disabled = $("tar").disabled = busy || !result;
}
function invalidate(message) {
  result = null;
  measuredRequest = null;
  $("summary").replaceChildren();
  $("candidates").replaceChildren();
  $("warnings").textContent = "";
  for (const id of ["aligned", "difference"])
    $(id + "-legend").textContent = "No current registration result.";
  sync();
  draw();
  status(message);
}
for (const kind of ["fixed", "moving"])
  $("capture-" + kind).onclick = () => {
    if (busy) return;
    const snapshot = getAnalysisSnapshot();
    if (!snapshot) {
      status(
        "Capture refused: current analysis is dirty, pending or unavailable. Recalculate the main viewer first.",
        true,
      );
      return;
    }
    captures[kind] = structuredClone(snapshot.recipe);
    const r = captures[kind];
    $(kind + "-source").textContent =
      `${kind === "fixed" ? "Fixed" : "Moving"}: ${r.source.file} · channel ${r.source.channel} (${r.source.title})\nSource SHA-256 ${r.source.sha256}\nProcessed SHA-256 ${r.output.sha256}\nSelection ${JSON.stringify(r.selection)}\nLateral unit: ${unit(r.output.geometry.xy_unit)} · value unit: ${unit(r.output.geometry.z_unit)}\nDetached capture: later viewer edits do not change this recipe.`;
    invalidate(
      "Capture updated. Review both inputs and explicit transform settings, then register.",
    );
  };
for (const id of [
  "mode",
  "tx",
  "ty",
  "interpolation",
  "radius-x",
  "radius-y",
  "min-overlap",
])
  $(id).addEventListener("input", () =>
    invalidate(
      "Registration settings changed. Run again to create a current report.",
    ),
  );
function numeric(id, integer = false) {
  const text = $(id).value,
    value = Number(text);
  if (
    text.trim() === "" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value))
  )
    throw Error(
      "Enter a finite " + (integer ? "integer " : "") + "value for " + id + ".",
    );
  return value;
}
function parameters() {
  if ($("mode").value === "manual")
    return {
      mode: "manual",
      tx: numeric("tx"),
      ty: numeric("ty"),
      interpolation: $("interpolation").value,
    };
  const radius_x = numeric("radius-x", true),
    radius_y = numeric("radius-y", true),
    min_overlap_fraction = numeric("min-overlap");
  if (radius_x < 0 || radius_x > 64 || radius_y < 0 || radius_y > 64)
    throw Error("Search radii must be integers from 0 through 64.");
  if (min_overlap_fraction <= 0 || min_overlap_fraction > 1)
    throw Error(
      "Minimum overlap fraction must be greater than zero and at most one.",
    );
  return { mode: "automatic", radius_x, radius_y, min_overlap_fraction };
}
async function request(path, body) {
  const response = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json();
    throw Error(error.detail || error.error || "Registration request failed.");
  }
  return response;
}
$("run").onclick = async () => {
  if (busy || !captures.fixed || !captures.moving) return;
  invalidate("Validating captured inputs and settings…");
  try {
    measuredRequest = structuredClone({
      fixed_recipe: captures.fixed,
      moving_recipe: captures.moving,
      parameters: parameters(),
    });
    busy = true;
    sync();
    status(
      "Strictly replaying both captured analyses and measuring common overlap…",
    );
    result = await (await request("/api/registration", measuredRequest)).json();
    render();
    status(
      "Registration complete. Review overlap, transform and warnings before using the result.",
    );
  } catch (error) {
    result = null;
    measuredRequest = null;
    status(error.message, true);
  } finally {
    busy = false;
    sync();
    draw();
  }
};
function metric(value, units = "") {
  return Number.isFinite(value)
    ? `${fmt(value)}${units ? " " + units : ""}`
    : "unavailable";
}
function metricSummary(m) {
  if (!m || !Number.isFinite(m.valid_count))
    return "Unavailable: " + (m?.reason || "no common valid overlap");
  return `${m.valid_count} pixels · fraction of valid fixed pixels ${fmt(m.overlap_fraction)} · area ${metric(m.area, m.area_unit)}\nRMSE ${metric(m.rmse, m.value_unit)} · MAE ${metric(m.mae, m.value_unit)}\nMean ${metric(m.mean_difference, m.value_unit)} · max |difference| ${metric(m.max_abs, m.value_unit)}`;
}
function render() {
  const r = result,
    g = r.fixed_geometry,
    m = r.moving_geometry,
    t = r.transform;
  const rows = [
    [
      "Transform · moving → fixed",
      `tx ${metric(t.tx, t.unit)} · ty ${metric(t.ty, t.unit)}\n${t.mapping}`,
    ],
    [
      "Sampling",
      `${r.parameters.interpolation || "integer"} interpolation\nFixed pitch X ${metric(g.xreal / g.shape[1], g.xy_unit)}, Y ${metric(g.yreal / g.shape[0], g.xy_unit)}\nMoving pitch X ${metric(m.xreal / m.shape[1], m.xy_unit)}, Y ${metric(m.yreal / m.shape[0], m.xy_unit)}`,
    ],
    ["Before · physical zero shift", metricSummary(r.before)],
    ["After · common overlap", metricSummary(r.metrics)],
    ["Fixed-grid overlap bounds", JSON.stringify(r.metrics.bounds)],
    ["Report SHA-256", r.report_sha256],
  ];
  if (r.search)
    rows.push([
      "Automatic proposal",
      `Pixel shift ${JSON.stringify(t.pixel_shift)}\n${r.search.origin_convention}\nTied candidates ${JSON.stringify(r.search.tied_candidates)}\nBoundary peak: ${r.search.boundary_peak ? "yes — review search extent" : "no"}`,
    ]);
  $("summary").replaceChildren(
    ...rows.map(([name, value]) => {
      const box = document.createElement("div"),
        label = document.createElement("span"),
        text = document.createElement("strong");
      label.textContent = name;
      text.textContent = value;
      box.append(label, text);
      return box;
    }),
  );
  $("warnings").textContent = [
    ...new Set([
      ...(r.warnings || []),
      "Output retains the entire fixed grid. Missing overlap remains invalid; no implicit cropping or extrapolation.",
      "Metrics describe the sampled overlap, not experimental uncertainty. Matching declared units does not certify calibration.",
      ...(r.search?.boundary_peak
        ? [
            "The best proposal lies on a search boundary; review whether a larger search is needed.",
          ]
        : []),
    ]),
  ].join("\n");
  $("candidates").replaceChildren();
  if (r.search) {
    const table = document.createElement("table"),
      caption = document.createElement("caption"),
      head = document.createElement("thead"),
      body = document.createElement("tbody");
    caption.textContent =
      "Top 10 scored candidates by signed correlation; full search and ties are in JSON.";
    const tr = document.createElement("tr");
    for (const name of [
      "X shift",
      "Y shift",
      "NCC",
      "Valid pixels",
      "Fraction of smaller valid input",
    ]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = name;
      tr.append(th);
    }
    head.append(tr);
    const candidates = r.search.candidates
      .filter((c) => Number.isFinite(c.ncc))
      .slice()
      .sort((a, b) => b.ncc - a.ncc || a.sy - b.sy || a.sx - b.sx)
      .slice(0, 10);
    for (const c of candidates) {
      const row = document.createElement("tr");
      for (const value of [
        c.sx,
        c.sy,
        fmt(c.ncc),
        c.valid_count,
        fmt(c.overlap_fraction),
      ]) {
        const td = document.createElement("td");
        td.textContent = String(value);
        row.append(td);
      }
      body.append(row);
    }
    table.append(caption, head, body);
    $("candidates").append(table);
  }
}
function rgb(a, b, t) {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}
function color(t, diverging) {
  return diverging
    ? t < 0.5
      ? rgb([48, 83, 169], [244, 245, 242], t * 2)
      : rgb([244, 245, 242], [204, 128, 30], t * 2 - 1)
    : t < 0.5
      ? rgb([23, 39, 79], [63, 106, 217], t * 2)
      : rgb([63, 106, 217], [246, 190, 73], t * 2 - 1);
}
function map(kind) {
  const node = $(kind),
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
  ctx.font = "10px system-ui";
  ctx.fillStyle = "#62718a";
  if (!result) {
    ctx.fillText("Capture both analyses and run registration.", 12, 24);
    return;
  }
  const o = result.overviews[kind],
    g = result.fixed_geometry,
    availableWidth = Math.max(1, w - 86),
    availableHeight = Math.max(1, h - 89),
    scale = Math.min(availableWidth / g.xreal, availableHeight / g.yreal),
    pw = g.xreal * scale,
    ph = g.yreal * scale,
    left = 60 + (availableWidth - pw) / 2,
    top = 12 + (availableHeight - ph) / 2;
  let low = Infinity,
    high = -Infinity;
  for (const v of o.data)
    if (v !== null && Number.isFinite(v)) {
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
  if (!Number.isFinite(low)) {
    low = 0;
    high = 0;
  }
  const diverging = kind === "difference";
  if (diverging) {
    high = Math.max(Math.abs(low), Math.abs(high));
    low = -high;
  }
  ctx.fillStyle = "#d9dfe6";
  ctx.fillRect(left, top, pw, ph);
  // Render half-open bins at their actual fixed-grid extent, not uniformly stretched centers.
  for (let y = 0; y < o.height; y++)
    for (let x = 0; x < o.width; x++) {
      const i = y * o.width + x,
        v = o.data[i];
      if (v === null || !Number.isFinite(v) || o.valid_counts[i] === 0)
        continue;
      const [xs, xe] = o.x_bins[x],
        [ys, ye] = o.y_bins[y];
      ctx.fillStyle = color(
        high === low ? 0.5 : (v - low) / (high - low),
        diverging,
      );
      ctx.fillRect(
        left + (xs / g.shape[1]) * pw,
        top + (1 - ye / g.shape[0]) * ph,
        ((xe - xs) / g.shape[1]) * pw,
        ((ye - ys) / g.shape[0]) * ph,
      );
    }
  ctx.strokeStyle = "#8191a7";
  ctx.strokeRect(left, top, pw, ph);
  ctx.fillStyle = "#35465e";
  ctx.textAlign = "left";
  ctx.fillText(fmt(g.xoff), left, top + ph + 14);
  ctx.textAlign = "right";
  ctx.fillText(fmt(g.xoff + g.xreal), left + pw, top + ph + 14);
  ctx.fillText(fmt(g.yoff + g.yreal), left - 4, top + 8);
  ctx.fillText(fmt(g.yoff), left - 4, top + ph);
  ctx.textAlign = "center";
  ctx.fillText("X / " + unit(g.xy_unit), left + pw / 2, top + ph + 29);
  ctx.save();
  ctx.translate(11, top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Y / " + unit(g.xy_unit), 0, 0);
  ctx.restore();
  const barY = h - 28;
  for (let i = 0; i < 100; i++) {
    ctx.fillStyle = color(i / 99, diverging);
    ctx.fillRect(left + (i * pw) / 100, barY, pw / 100 + 0.5, 7);
  }
  ctx.fillStyle = "#35465e";
  ctx.textAlign = "left";
  ctx.fillText(fmt(low), left, h - 8);
  ctx.textAlign = "right";
  ctx.fillText(fmt(high) + " " + unit(g.z_unit), left + pw, h - 8);
  $(kind + "-legend").textContent =
    `Linear value scale ${metric(low, g.z_unit)} to ${metric(high, g.z_unit)}. ${o.width} × ${o.height} recorded bins; common-valid mean per bin. Gray: no common-valid pixels. Physical coordinates refer to the fixed grid.`;
}
function draw() {
  map("aligned");
  map("difference");
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("json").onclick = () => {
  if (result && !busy)
    download(
      new Blob([JSON.stringify(result, null, 2) + "\n"], {
        type: "application/json",
      }),
      "registration-report.json",
    );
};
$("tar").onclick = async () => {
  if (!result || !measuredRequest || busy) return;
  busy = true;
  sync();
  status(
    "Replaying both captured recipes and verifying the report hash before export…",
  );
  try {
    const response = await request("/api/registration-export", {
      ...structuredClone(measuredRequest),
      report_sha256: result.report_sha256,
    });
    download(await response.blob(), "registration-evidence.tar");
    status("Verified numerical registration bundle downloaded.");
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    sync();
  }
};
new ResizeObserver(draw).observe($("aligned"));
new ResizeObserver(draw).observe($("difference"));
sync();
draw();
