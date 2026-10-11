import { apiFetch } from "./api.js";
import { getAnalysisSnapshot } from "./app.js";
import { validMask } from "./engine.js";
const $ = (id) => document.getElementById("features-" + id);
let captured = null,
  channel = null,
  eligible = null,
  result = null,
  selected = null,
  page = 0,
  busy = false,
  bounds = null;
const PAGE_SIZE = 100;
const config = ["threshold", "direction", "connectivity", "min", "boundary"];
function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = String(value);
  return node;
}
function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function fmt(value, unit) {
  return Number.isFinite(value)
    ? value.toPrecision(6) + " " + (unit ?? "unknown")
    : "—";
}
function sync() {
  $("capture").disabled = busy;
  for (const id of config) $(id).disabled = busy;
  $("run").disabled = busy || !captured;
  $("json").disabled = $("tsv").disabled = !result;
}
function warnings() {
  const messages = [];
  for (const [key, value] of Object.entries(captured?.channel.metadata || {}))
    if (/import|warning/i.test(key))
      messages.push(
        key +
          ": " +
          (typeof value === "string" ? value : JSON.stringify(value)),
      );
  if (captured && !channel.z_unit)
    messages.push(
      "Vertical units are unknown; threshold retains the stored numeric scale.",
    );
  messages.push(
    ...(result?.warnings || []),
    ...(result?.report.warnings || []),
  );
  $("warnings").textContent = [...new Set(messages)].join("\n");
}
function clearResult(message) {
  result = null;
  selected = null;
  page = 0;
  renderRows();
  draw();
  warnings();
  sync();
  status(message);
}
$("capture").onclick = () => {
  if (busy) return;
  const snapshot = getAnalysisSnapshot();
  if (!snapshot) {
    status(
      "Capture refused: the current analysis is dirty, pending, or unavailable. Recalculate the main viewer first.",
      true,
    );
    return;
  }
  captured = snapshot;
  const data = snapshot.data.flat().map((v) => (v === null ? NaN : v));
  channel = {
    ...snapshot.channel,
    width: snapshot.channel.shape[1],
    height: snapshot.channel.shape[0],
    data: Float64Array.from(data),
    mask: null,
  };
  eligible = validMask(channel, snapshot.recipe.selection);
  $("threshold").value = "";
  $("unit").textContent = "(" + (channel.z_unit || "unknown unit") + ")";
  $("source").textContent = [
    "Captured processed snapshot · " +
      snapshot.recipe.source.file +
      " · channel " +
      snapshot.recipe.source.channel +
      " (" +
      snapshot.recipe.source.title +
      ")",
    channel.width +
      " × " +
      channel.height +
      " pixels · X " +
      fmt(channel.xreal, channel.xy_unit) +
      " · Y " +
      fmt(channel.yreal, channel.xy_unit) +
      " · offsets " +
      fmt(channel.xoff, channel.xy_unit) +
      ", " +
      fmt(channel.yoff, channel.xy_unit),
    "Output SHA-256 " + snapshot.recipe.output.sha256,
    "Independent snapshot: later viewer edits do not change these captured values. ROI/polygon selections are preserved.",
  ].join("\n");
  clearResult(
    "Snapshot captured. Enter an explicit threshold in its stored vertical units.",
  );
};
for (const id of config)
  $(id).addEventListener("input", () =>
    clearResult(
      "Parameters changed. Segment the captured surface to produce a new result.",
    ),
  );
$("run").onclick = async () => {
  if (busy || !captured) return;
  const threshold = Number($("threshold").value),
    min = Number($("min").value);
  if (!$("threshold").value.trim() || !Number.isFinite(threshold)) {
    status(
      "Enter a finite threshold explicitly; no threshold is selected automatically.",
      true,
    );
    return;
  }
  if (!Number.isSafeInteger(min) || min < 1 || min > 4194304) {
    status("Minimum pixels must be an integer from 1 to 4194304.", true);
    return;
  }
  const parameters = {
    threshold,
    direction: $("direction").value,
    connectivity: Number($("connectivity").value),
    min_pixels: min,
    boundary: $("boundary").value,
  };
  busy = true;
  sync();
  status(
    "Strictly replaying the captured recipe and measuring threshold regions…",
  );
  try {
    const response = await apiFetch("/api/segment", {
      method: "POST",
      body: JSON.stringify({
        recipe: structuredClone(captured.recipe),
        parameters,
      }),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(value.detail || value.error || "Segmentation failed.");
    result = value;
    selected = null;
    page = 0;
    renderRows();
    draw();
    warnings();
    status(
      "Segmentation complete. Region measurements describe this captured processed surface.",
    );
  } catch (error) {
    result = null;
    renderRows();
    draw();
    status(error.message, true);
  } finally {
    busy = false;
    sync();
  }
};
function color(id) {
  const h = (id * 137.508) % 360,
    s = 0.72,
    l = 0.53,
    a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  });
}
function draw() {
  const canvas = $("canvas"),
    dpr = devicePixelRatio || 1,
    w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#e5e9ef";
  ctx.fillRect(0, 0, w, h);
  if (!channel) {
    ctx.fillStyle = "#627086";
    ctx.font = "12px system-ui";
    ctx.fillText("Capture an analyzed surface to preview regions.", 14, 24);
    return;
  }
  const scale = Math.min((w - 36) / channel.xreal, (h - 40) / channel.yreal),
    bw = channel.xreal * scale,
    bh = channel.yreal * scale;
  bounds = { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
  let min = Infinity,
    max = -Infinity;
  for (const value of channel.data)
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  const off = document.createElement("canvas");
  off.width = channel.width;
  off.height = channel.height;
  const oc = off.getContext("2d"),
    pixels = oc.createImageData(channel.width, channel.height);
  for (let i = 0; i < channel.data.length; i++) {
    const value = channel.data[i],
      label = result?.labels[i] || 0;
    let rgb;
    if (!Number.isFinite(value))
      rgb =
        (Math.floor(i / channel.width) + (i % channel.width)) % 2
          ? [190, 195, 204]
          : [240, 242, 245];
    else if (!eligible[i]) rgb = [91, 104, 123];
    else {
      const grey = Math.round(
        65 + 155 * (max === min ? 0.5 : (value - min) / (max - min)),
      );
      rgb = [grey, grey, grey];
      if (label) rgb = color(label);
      else if (
        result &&
        (result.parameters.direction === "above"
          ? value >= result.parameters.threshold
          : value <= result.parameters.threshold)
      )
        rgb = [201, 143, 71];
    }
    if (selected !== null && label && label !== selected)
      rgb = rgb.map((v) => Math.round(v * 0.4 + 150));
    pixels.data.set([...rgb, 255], i * 4);
  }
  oc.putImageData(pixels, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, bounds.x, bounds.y, bw, bh);
  ctx.strokeStyle = "#536882";
  ctx.strokeRect(bounds.x, bounds.y, bw, bh);
  const region = allRegions().find((r) => r.id === selected);
  if (region) {
    const [x0, y0, x1, y1] = region.bbox_pixel;
    ctx.strokeStyle = "#ff3048";
    ctx.lineWidth = 2;
    ctx.setLineDash(region.excluded_reasons.length ? [4, 3] : []);
    ctx.strokeRect(
      bounds.x + (x0 / channel.width) * bw,
      bounds.y + (y0 / channel.height) * bh,
      ((x1 - x0) / channel.width) * bw,
      ((y1 - y0) / channel.height) * bh,
    );
    ctx.setLineDash([]);
  }
  ctx.fillStyle = "#35465e";
  ctx.font = "10px system-ui";
  ctx.fillText(
    fmt(channel.xreal, channel.xy_unit) +
      " × " +
      fmt(channel.yreal, channel.xy_unit),
    8,
    h - 7,
  );
  $("legend").textContent =
    "Grayscale: eligible background; colors: accepted region IDs; amber: filtered threshold pixels; slate: ROI/polygon-excluded; checkerboard: missing/source-masked. " +
    (selected !== null ? "Red box: selected region pixel-cell bounds. " : "") +
    "Calibrated physical aspect; pixels are displayed without interpolation.";
}
function allRegions() {
  return result
    ? [...result.report.regions, ...result.report.excluded_regions]
    : [];
}
function visibleRegions() {
  return result
    ? $("excluded").checked
      ? allRegions()
      : result.report.regions
    : [];
}
function rowValues(r) {
  return [
    r.id,
    r.pixel_count,
    fmt(r.area, r.area_unit),
    fmt(r.width, channel.xy_unit),
    fmt(r.height, channel.xy_unit),
    fmt(r.mean, channel.z_unit),
    fmt(r.excursion_height, channel.z_unit),
    [
      r.touches_image_boundary ? "image" : "",
      r.touches_selection_boundary ? "selection" : "",
    ]
      .filter(Boolean)
      .join(", ") || "none",
    r.excluded_reasons.join(", ") || "accepted",
  ];
}
function renderRows() {
  const rows = $("rows");
  rows.replaceChildren();
  const regions = visibleRegions(),
    start = page * PAGE_SIZE;
  if (start >= regions.length && page)
    page = Math.max(0, Math.ceil(regions.length / PAGE_SIZE) - 1);
  for (const region of regions.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  )) {
    const row = document.createElement("tr");
    row.dataset.region = region.id;
    row.dataset.selected = String(selected === region.id);
    const values = rowValues(region),
      first = document.createElement("td"),
      button = text("button", "Region " + region.id);
    button.setAttribute("aria-pressed", String(selected === region.id));
    button.onclick = () => {
      selected = region.id;
      renderRows();
      draw();
    };
    first.append(button);
    row.append(first);
    for (const value of values.slice(1)) row.append(text("td", value));
    rows.append(row);
  }
  $("prev").disabled = page === 0;
  $("next").disabled = (page + 1) * PAGE_SIZE >= regions.length;
  $("counts").textContent = result
    ? result.report.counts.accepted_regions +
      " accepted · " +
      result.report.counts.excluded_regions +
      " excluded · " +
      result.report.counts.accepted_pixels +
      " accepted pixels. Showing " +
      (regions.length ? page * PAGE_SIZE + 1 : 0) +
      "–" +
      Math.min((page + 1) * PAGE_SIZE, regions.length) +
      " of " +
      regions.length +
      " rows; exports include all regions."
    : "No region measurements yet.";
}
$("excluded").onchange = () => {
  page = 0;
  renderRows();
};
$("prev").onclick = () => {
  page--;
  renderRows();
};
$("next").onclick = () => {
  page++;
  renderRows();
};
function download(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("json").onclick = () => {
  if (result)
    download(
      JSON.stringify(result, null, 2),
      "application/json",
      "afm-segmentation.json",
    );
};
$("tsv").onclick = () => {
  if (!result) return;
  const columns = [
    "id",
    "pixel_count",
    "area",
    "area_unit",
    "width",
    "height",
    "xy_unit",
    "mean",
    "excursion_height",
    "z_unit",
    "touches_image_boundary",
    "touches_selection_boundary",
    "excluded_reasons",
    "source_sha256",
    "output_sha256",
    "labels_sha256",
    "report_sha256",
  ];
  const lines = [columns.join("\t")];
  for (const r of allRegions())
    lines.push(
      [
        r.id,
        r.pixel_count,
        r.area,
        r.area_unit ?? "unknown",
        r.width,
        r.height,
        channel.xy_unit ?? "unknown",
        r.mean,
        r.excursion_height,
        channel.z_unit ?? "unknown",
        r.touches_image_boundary,
        r.touches_selection_boundary,
        r.excluded_reasons.join(","),
        captured.recipe.source.sha256,
        captured.recipe.output.sha256,
        result.labels_sha256,
        result.report_sha256,
      ]
        .map((v) => String(v).replace(/[\t\r\n]/g, " "))
        .join("\t"),
    );
  download(
    lines.join("\n") + "\n",
    "text/tab-separated-values",
    "afm-regions.tsv",
  );
};
$("canvas").onpointermove = (event) => {
  if (!bounds || !channel) return;
  const rect = $("canvas").getBoundingClientRect(),
    px = Math.floor(
      ((event.clientX - rect.left - bounds.x) / bounds.w) * channel.width,
    ),
    py = Math.floor(
      ((event.clientY - rect.top - bounds.y) / bounds.h) * channel.height,
    );
  if (px < 0 || py < 0 || px >= channel.width || py >= channel.height) return;
  const i = py * channel.width + px;
  $("hover").textContent =
    "Pixel [" +
    px +
    ", " +
    py +
    "] · center " +
    fmt(
      channel.xoff + ((px + 0.5) * channel.xreal) / channel.width,
      channel.xy_unit,
    ) +
    ", " +
    fmt(
      channel.yoff + ((py + 0.5) * channel.yreal) / channel.height,
      channel.xy_unit,
    ) +
    " · value " +
    fmt(channel.data[i], channel.z_unit) +
    " · region " +
    (result?.labels[i] || "unlabeled");
};
new ResizeObserver(draw).observe($("canvas").parentElement);
sync();
renderRows();
draw();
