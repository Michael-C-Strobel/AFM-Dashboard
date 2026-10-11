import { mountThreePointEditor } from "./three-point-ui.js";
import { apiFetch } from "./api.js";
import { runBatch } from "./batch.js";
import {
  createHistogramReadout,
  createProfileReadout,
  mountMeasurementReadout,
} from "./measurement-readout.js";
("use strict");
const $ = (id) => document.getElementById(id);
const state = {
  files: [],
  channels: [],
  tracePairs: [],
  support: null,
  reference: null,
  referenceChannels: [],
  referenceSequence: 0,
  operations: [],
  selection: { roi: null, exclude_polygons: [] },
  profile: null,
  plateaus: [null, null],
  polygon: [],
  response: null,
  sequence: 0,
  zoom: 1,
  pan: [0, 0],
  drag: null,
  rasters: {},
};
const acquisition = { sequence: 0, result: null };
let levelEditor = null,
  levelPreview = null,
  levelRequest = 0;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
function format(value, unit) {
  if (!finite(value)) return "—";
  if (unit === "m") {
    const a = Math.abs(value),
      factor = a > 0 && a < 1e-6 ? 1e9 : a < 0.001 ? 1e6 : a < 1 ? 1e3 : 1;
    return (
      (value * factor).toLocaleString(undefined, {
        maximumSignificantDigits: 4,
      }) +
      " " +
      { 1: "m", 1000: "mm", 1000000: "µm", 1000000000: "nm" }[factor]
    );
  }
  return (
    value.toLocaleString(undefined, { maximumSignificantDigits: 4 }) +
    (unit ? " " + unit : " (unit unknown)")
  );
}
function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
async function api(path, body) {
  const response = await apiFetch(
    path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  if (!response.ok) {
    let error;
    try {
      error = await response.json();
    } catch {
      error = { detail: response.statusText };
    }
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : JSON.stringify(error.detail || error),
    );
  }
  return response.json();
}
function option(select, value, label) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  select.append(el);
}
function currentChannel() {
  return state.channels.find((c) => String(c.id) === $("channel").value);
}
function body() {
  return {
    file: $("file").value,
    channel: Number($("channel").value),
    operations: structuredClone(state.operations),
    selection: structuredClone(state.selection),
    profile: state.profile,
    plateaus: state.plateaus.every(Boolean)
      ? structuredClone(state.plateaus)
      : null,
    reference:
      $("compare").checked &&
      state.reference &&
      $("reference-channel").value !== ""
        ? {
            file: state.reference,
            channel: Number($("reference-channel").value),
          }
        : null,
  };
}
function dirty(message = "Selection changed. Recalculate to update analysis.") {
  levelEditor?.cancel();
  clearLevelPreview();
  invalidateAcquisition();
  ++state.sequence;
  status(message);
  $("download").disabled = true;
  $("export").disabled = true;
}
function resetSelections() {
  invalidateAcquisition();
  state.selection = { roi: null, exclude_polygons: [] };
  state.profile = null;
  state.plateaus = [null, null];
  state.polygon = [];
  selectionLabel();
}
function selectionLabel() {
  $("plateau-info").textContent =
    state.plateaus
      .map(
        (roi, i) =>
          "Plateau " +
          (i ? "B" : "A") +
          ": " +
          (roi
            ? roi.map((v) => format(v, currentChannel()?.xy_unit)).join(" · ")
            : "not selected"),
      )
      .join(" | ") +
    ". Step regions ignore the measurement ROI; exclusions still apply. Applied processing keeps its recorded fit selection.";

  $("selection-info").textContent =
    (state.selection.roi
      ? "ROI: " +
        state.selection.roi
          .map((v) => format(v, currentChannel()?.xy_unit))
          .join(" · ")
      : "Full field") +
    " · " +
    state.selection.exclude_polygons.length +
    " excluded polygon(s)" +
    (state.polygon.length
      ? " · " + state.polygon.length + " unfinished vertices"
      : "") +
    (state.profile ? " · Line profile selected" : "") +
    ". Draw a measurement selection, then recalculate. Applied processing keeps its recorded fit selection. Nonfinite pixels appear checkerboard.";
}
async function loadFile() {
  levelEditor?.sync(null, null);
  clearLevelPreview();
  resetComparison();
  $("download").disabled = true;
  $("export").disabled = true;
  const seq = ++state.sequence;
  state.response = null;
  state.operations = [];
  resetSelections();
  state.zoom = 1;
  state.pan = [0, 0];
  state.rasters = {};
  render();
  $("channel").replaceChildren();
  status("Reading calibrated channels…");
  try {
    const result = await api(
      "/api/channels?file=" + encodeURIComponent($("file").value),
    );
    if (seq !== state.sequence) return;
    state.channels = result.channels;
    state.tracePairs = result.trace_pairs || [];
    configureAcquisition();
    state.support = result.support || null;
    renderSupport();
    for (const c of state.channels)
      option(
        $("channel"),
        c.id,
        c.id + " · " + c.title + " (" + c.shape.join(" × ") + ")",
      );
    if (!state.channels.length)
      throw new Error("This file contains no supported image channels.");
    syncReference();
    configureAcquisition();
    await analyze();
  } catch (e) {
    if (seq === state.sequence) status(e.message, true);
  }
}
function syncChemist() {
  $("chemist").disabled =
    $("file").value !== "sample-input.gwy" ||
    $("channel").value !== "0" ||
    state.response?.source?.sha256 !==
      "ea0287a8afbed275d2d780f31508f89bd937796ab357f5a7d9389152e27abaab";
}
function syncReference() {
  syncChemist();
}
function resetComparison() {
  $("compare").checked = false;
  $("view").value = "processed";
}
function referenceOptions(preferred = state.reference) {
  $("reference-file").replaceChildren();
  for (const file of state.files)
    option($("reference-file"), file.name, file.name);
  if (state.files.some((file) => file.name === preferred))
    $("reference-file").value = preferred;
}
async function loadReference(
  preferredChannel = $("reference-channel").value,
  recalculate = false,
) {
  const seq = ++state.referenceSequence,
    name = $("reference-file").value;
  $("compare").disabled = true;
  state.reference = name || null;
  state.referenceChannels = [];
  $("reference-channel").replaceChildren();
  if (!name) {
    $("compare").checked = false;
    return;
  }
  try {
    const result = await api("/api/channels?file=" + encodeURIComponent(name));
    if (seq !== state.referenceSequence) return;
    state.referenceChannels = result.channels;
    for (const c of result.channels)
      option($("reference-channel"), c.id, c.id + " · " + c.title);
    if (result.channels.some((c) => String(c.id) === String(preferredChannel)))
      $("reference-channel").value = String(preferredChannel);
    $("compare").disabled = !result.channels.length;
    if (recalculate && $("compare").checked) await analyze();
  } catch (error) {
    if (seq !== state.referenceSequence) return;
    state.reference = null;
    $("compare").checked = false;
    status(
      "Reference unavailable: " +
        error.message +
        ". Local imports remain available.",
      true,
    );
  }
}
async function analyze() {
  if (!$("channel").value) return;
  levelEditor?.cancel();
  clearLevelPreview();
  const seq = ++state.sequence;
  const request = body();
  status("Analyzing surface…");
  $("download").disabled = true;
  $("export").disabled = true;
  try {
    const result = await api("/api/analyze", request);
    if (seq !== state.sequence) return;
    state.response = result;
    state.operations = result.recipe.operations.map((operation) => ({
      ...structuredClone(operation),
      selection: structuredClone(
        operation.selection ?? result.recipe.selection,
      ),
    }));
    state.rasters = {};
    renderAll();
    const warnings = [
      ...new Set([
        ...(result.warnings || []),
        ...(result.quality?.warnings || []),
      ]),
    ];
    status(
      warnings.length
        ? warnings.join(" · ")
        : "Analysis complete · " +
            (result.statistics?.valid_count ?? 0).toLocaleString() +
            " valid pixels · original file preserved",
    );
    $("download").disabled = false;
    $("export").disabled = false;
  } catch (e) {
    if (seq === state.sequence) status(e.message, true);
  }
}
function renderAll() {
  renderSupport();
  $("hover").textContent =
    "Hover over either map for physical coordinates and height.";
  syncChemist();
  const r = state.response;
  if (!r) return;
  levelEditor?.sync(levelContext(), recordedLevelPoints());
  $("title").textContent = r.source?.file || $("file").value;
  $("metadata").textContent = JSON.stringify(r.channel, null, 2);
  $("coordinate-units").textContent =
    "Coordinates use " +
    (r.channel.xy_unit || "unknown units") +
    " (source base units). Enter metres as e.g. 2e-6 for 2 µm when the unit is m.";
  $("log").textContent =
    typeof r.channel?.log === "string"
      ? r.channel.log
      : JSON.stringify(r.channel?.log || [], null, 2);
  $("history").replaceChildren();
  state.operations.forEach((op, index) => {
    const item = document.createElement("li"),
      button = document.createElement("button");
    button.textContent = op.name + " " + JSON.stringify(op.params);
    button.title =
      "Keep pipeline through this step. Processing selection: " +
      JSON.stringify(op.selection ?? r.recipe.selection);
    button.onclick = () => {
      state.operations = state.operations.slice(0, index + 1);
      analyze();
    };
    item.append(button);
    $("history").append(item);
  });
  const s = r.statistics || {};
  $("statistics").replaceChildren();
  for (const [label, value] of [
    ["Sa · selected mean", format(s.sa, s.z_unit)],
    ["Sq · selected mean", format(s.sq, s.z_unit)],
    ["Peak to valley", format(s.peak_to_valley, s.z_unit)],
    ["Valid pixels", String(s.valid_count ?? "—")],
  ]) {
    const el = document.createElement("div"),
      name = document.createElement("span"),
      val = document.createElement("strong");
    el.className = "stat";
    name.textContent = label;
    val.textContent = value;
    el.append(name, val);
    $("statistics").append(el);
  }
  $("quality").textContent =
    "Nonfinite source pixels: " +
    (r.quality?.nonfinite_count ?? "—") +
    " · Excluded pixels: " +
    (s.excluded_count ?? "—") +
    ". " +
    (r.quality?.warnings || []).join(" ");
  $("comparison").textContent = r.comparison
    ? "Reference RMSE: " +
      format(r.comparison.rmse, s.z_unit) +
      " · MAE: " +
      format(r.comparison.mae, s.z_unit) +
      " · Mean difference: " +
      format(r.comparison.mean_difference, s.z_unit)
    : "Enable reference comparison to evaluate the processed surface against the selected reference.";
  renderProfile(r.profile, r.recipe?.profile);
  renderHistogram(s.histogram, s.z_unit);
  renderStep(r.step);
  selectionLabel();
  render();
}
const palettes = {
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  inferno: [
    [0, 0, 4],
    [87, 15, 109],
    [188, 55, 84],
    [249, 142, 9],
    [252, 255, 164],
  ],
  grayscale: [
    [15, 20, 20],
    [247, 249, 246],
  ],
};
// Analysis response arrays are immutable; weak keys release old display ranges.
const displayRanges = new WeakMap();
function range(data) {
  if (!data) return [0, 1];
  if (displayRanges.has(data)) return displayRanges.get(data);
  let min = Infinity,
    max = -Infinity;
  for (const row of data || [])
    for (const x of row)
      if (finite(x)) {
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
  const limits = min === Infinity ? [0, 1] : [min, max];
  displayRanges.set(data, limits);
  return limits;
}
function rightData() {
  const r =
    levelPreview && $("view").value === "processed"
      ? levelPreview.result
      : state.response;
  return !r
    ? null
    : $("view").value === "reference"
      ? r.comparison?.target
      : $("view").value === "difference"
        ? r.comparison?.data
        : r.data;
}
function geometry(data, raw = false) {
  const c = state.response?.channel;
  return {
    xreal: c?.xreal || data?.[0]?.length || 1,
    yreal: c?.yreal || data?.length || 1,
    xoff: c?.xoff || 0,
    yoff: c?.yoff || 0,
    xy_unit: c?.xy_unit,
    z_unit: c?.z_unit,
  };
}
function rect(canvas, g) {
  const w = canvas.clientWidth,
    h = canvas.clientHeight,
    ratio = g.xreal / g.yreal;
  let rw = w - 36,
    rh = rw / ratio;
  if (rh > h - 36) {
    rh = h - 36;
    rw = rh * ratio;
  }
  rw *= state.zoom;
  rh *= state.zoom;
  return {
    x: (w - rw) / 2 + state.pan[0],
    y: (h - rh) / 2 + state.pan[1],
    w: rw,
    h: rh,
  };
}
function render() {
  const r = state.response,
    raw = r?.original,
    result = rightData(),
    rawRange = range(raw),
    resultRange = range(result);
  const shared = $("shared").checked && $("view").value !== "difference";
  const both = [
    Math.min(rawRange[0], resultRange[0]),
    Math.max(rawRange[1], resultRange[1]),
  ];
  const overrides = (limits) => [
    $("display-min").value !== "" ? Number($("display-min").value) : limits[0],
    $("display-max").value !== "" ? Number($("display-max").value) : limits[1],
  ];
  draw("raw", raw, geometry(raw, true), overrides(shared ? both : rawRange));
  draw(
    "result",
    result,
    geometry(result),
    overrides(shared ? both : resultRange),
  );
  $("result-title").textContent = {
    processed: "Processed",
    reference: "Reference",
    difference: "Processed − reference",
  }[$("view").value];
  if (levelPreview && $("view").value === "processed")
    $("result-title").textContent =
      "Three-point preview · apply to update measurements";
  $("result-badge").textContent =
    levelPreview && $("view").value === "processed"
      ? "DRAFT PREVIEW"
      : $("view").value === "processed"
        ? "RECIPE OUTPUT"
        : $("view").value === "reference"
          ? "BENCHMARK"
          : "RESIDUAL";
}
function draw(id, data, g, limits) {
  const canvas = $(id),
    dpr = window.devicePixelRatio || 1,
    w = canvas.clientWidth,
    h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  if (!data?.length) {
    ctx.fillStyle = "#6c8076";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(
      id === "result" && state.response
        ? "Enable comparison and recalculate."
        : "Select a calibrated channel.",
      w / 2,
      h / 2,
    );
    $(id + "-scale").textContent = "";
    return;
  }
  const key =
    id +
    ":" +
    limits.join(",") +
    ":" +
    $("palette").value +
    ":" +
    $("view").value;
  if (!state.rasters[key]) {
    const raster = document.createElement("canvas");
    raster.width = data[0].length;
    raster.height = data.length;
    const c = raster.getContext("2d"),
      pixels = c.createImageData(raster.width, raster.height),
      stops = palettes[$("palette").value],
      intervals = stops.length - 1,
      span = limits[1] - limits[0] || 1;
    // Keep interpolation identical while avoiding DOM reads and arrays per pixel.
    for (let y = 0; y < data.length; y++)
      for (let x = 0; x < data[y].length; x++) {
        const value = data[y][x],
          i = (y * raster.width + x) * 4;
        if (finite(value)) {
          const v =
              Math.max(0, Math.min(1, (value - limits[0]) / span)) * intervals,
            lower = Math.min(intervals - 1, Math.floor(v)),
            fraction = v - lower,
            a = stops[lower],
            b = stops[lower + 1];
          for (let component = 0; component < 3; component++)
            pixels.data[i + component] = Math.round(
              a[component] * (1 - fraction) + b[component] * fraction,
            );
          pixels.data[i + 3] = 255;
        }
      }
    c.putImageData(pixels, 0, 0);
    state.rasters[key] = raster;
  }
  const box = rect(canvas, g);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(state.rasters[key], box.x, box.y, box.w, box.h);
  ctx.strokeStyle = "#284f46";
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  const point = (p) => [
    box.x + ((p[0] - g.xoff) / g.xreal) * box.w,
    box.y + ((p[1] - g.yoff) / g.yreal) * box.h,
  ];
  function path(points, close = false, fill = false, stroke = "#ffaf66") {
    if (!points?.length) return;
    ctx.beginPath();
    points
      .map(point)
      .forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    if (close) ctx.closePath();
    if (fill) {
      ctx.fillStyle = "rgba(255,120,90,.25)";
      ctx.fill();
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (state.selection.roi) {
    const [a, b, c, d] = state.selection.roi;
    path(
      [
        [a, b],
        [c, b],
        [c, d],
        [a, d],
      ],
      true,
    );
  }
  for (const polygon of state.selection.exclude_polygons)
    path(polygon, true, true);
  path(state.polygon);
  path(state.profile);
  state.plateaus.forEach((roi, i) => {
    if (!roi) return;
    const [a, b, c, d] = roi;
    path(
      [
        [a, b],
        [c, b],
        [c, d],
        [a, d],
      ],
      true,
      false,
      i ? "#ffb2dc" : "#8ff2eb",
    );
    const pos = point([a, b]);
    ctx.fillStyle = "#153e42";
    ctx.fillRect(pos[0] + 2, pos[1] + 2, 18, 18);
    ctx.fillStyle = "#fff";
    ctx.font = "12px system-ui";
    ctx.fillText(i ? "B" : "A", pos[0] + 6, pos[1] + 15);
  });
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  levelEditor?.draw(ctx, point);
  ctx.restore();
  ctx.fillStyle = "#214b42";
  ctx.font = "10px system-ui";
  ctx.textAlign = "left";
  ctx.fillText(
    format(g.xreal, g.xy_unit) + " × " + format(g.yreal, g.xy_unit),
    8,
    h - 5,
  );

  // A physical scale bar follows the calibrated image size and current zoom.
  const target = g.xreal / 5 / state.zoom,
    power = 10 ** Math.floor(Math.log10(target)),
    scale = [1, 2, 5].filter((v) => v * power <= target).at(-1) * power;
  if (finite(scale) && scale > 0) {
    const length = (scale / g.xreal) * box.w;
    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.fillRect(w - length - 34, h - 48, length + 24, 31);
    ctx.strokeStyle = "#214b42";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w - length - 22, h - 28);
    ctx.lineTo(w - 22, h - 28);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = "#214b42";
    ctx.fillText(format(scale, g.xy_unit), w - length / 2 - 22, h - 34);
  }
  const scaleEl = $(id + "-scale"),
    low = document.createElement("span"),
    ramp = document.createElement("span"),
    high = document.createElement("span");
  low.textContent = format(limits[0], g.z_unit);
  high.textContent =
    format(limits[1], g.z_unit) +
    (limits[0] >= limits[1] ? " · Check limits" : "");
  ramp.className = "color-ramp";
  ramp.style.background =
    "linear-gradient(to right," +
    palettes[$("palette").value]
      .map((c) => "rgb(" + c.join(",") + ")")
      .join(",") +
    ")";
  scaleEl.replaceChildren(low, ramp, high);
}
function physical(event, canvas, clamp = false) {
  const data = canvas.id === "raw" ? state.response?.original : rightData();
  if (!data) return null;
  const g = geometry(data, canvas.id === "raw"),
    box = rect(canvas, g),
    bounds = canvas.getBoundingClientRect();
  let u = (event.clientX - bounds.left - box.x) / box.w,
    v = (event.clientY - bounds.top - box.y) / box.h;
  if (!clamp && (u < 0 || v < 0 || u > 1 || v > 1)) return null;
  u = Math.max(0, Math.min(1, u));
  v = Math.max(0, Math.min(1, v));
  return { point: [g.xoff + u * g.xreal, g.yoff + v * g.yreal], u, v, data, g };
}
for (const id of ["raw", "result"]) {
  const canvas = $(id);
  canvas.addEventListener(
    "wheel",
    (event) => {
      if (!state.response) return;
      event.preventDefault();
      state.zoom = Math.max(
        1,
        Math.min(20, state.zoom * Math.exp(-event.deltaY * 0.001)),
      );
      render();
    },
    { passive: false },
  );
  canvas.addEventListener("pointerdown", (event) => {
    if (!state.response) return;
    const p = physical(event, canvas);
    if (!p) return;
    if ($("tool").value === "level-points") {
      if (event.button !== 0) return;
      if (!levelEditor.isActive()) {
        if ($("download").disabled || !levelContext()) {
          status("Recalculate before placing leveling points.", true);
          return;
        }
        levelEditor.start(levelContext());
      }
      const box = rect(canvas, p.g),
        bounds = canvas.getBoundingClientRect();
      const project = (point) => [
        box.x + ((point[0] - p.g.xoff) / p.g.xreal) * box.w,
        box.y + ((point[1] - p.g.yoff) / p.g.yreal) * box.h,
      ];
      const index =
        levelEditor.hitTest(
          project,
          event.clientX - bounds.left,
          event.clientY - bounds.top,
        ) ?? levelEditor.selectedIndex();
      try {
        if (!levelEditor.setPoint(index, p.point)) return;
      } catch (error) {
        status(error.message, true);
        return;
      }
      state.drag = {
        canvas,
        tool: "level-points",
        index,
        pointerId: event.pointerId,
      };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if ($("tool").value === "polygon") {
      state.polygon.push(p.point);
      dirty();
      selectionLabel();
      render();
      return;
    }
    state.drag = {
      canvas,
      start: p.point,
      x: event.clientX,
      y: event.clientY,
      pan: [...state.pan],
      tool: $("tool").value,
    };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const p = physical(event, canvas, !!state.drag);
    if (p) {
      const row = Math.min(p.data.length - 1, Math.floor(p.v * p.data.length)),
        col = Math.min(
          p.data[0].length - 1,
          Math.floor(p.u * p.data[0].length),
        );
      $("hover").textContent =
        (id === "raw" ? "Original" : $("result-title").textContent) +
        " · x " +
        format(p.point[0], p.g.xy_unit) +
        " · y " +
        format(p.point[1], p.g.xy_unit) +
        " · z " +
        format(p.data[row][col], p.g.z_unit) +
        " · pixel [" +
        row +
        ", " +
        col +
        "]";
    }
    const d = state.drag;
    if (!d || d.canvas !== canvas || !p) return;
    if (d.tool === "level-points") {
      if (event.pointerId !== d.pointerId) return;
      try {
        levelEditor.setPoint(d.index, p.point);
      } catch (error) {
        status(error.message, true);
      }
      return;
    }
    if (d.tool === "navigate") {
      state.pan = [
        d.pan[0] + event.clientX - d.x,
        d.pan[1] + event.clientY - d.y,
      ];
    } else if (d.tool === "roi") {
      state.selection.roi = [
        Math.min(d.start[0], p.point[0]),
        Math.min(d.start[1], p.point[1]),
        Math.max(d.start[0], p.point[0]),
        Math.max(d.start[1], p.point[1]),
      ];
    } else if (d.tool === "profile") {
      state.profile = [d.start, p.point];
    }
    render();
  });
  const end = () => {
    if (state.drag?.tool === "level-points") {
      const next = levelEditor.snapshot().points.findIndex((p) => p === null);
      if (next >= 0) {
        $("level-point").value = String(next);
        $("level-point").dispatchEvent(new Event("change"));
      }
    }
    if (state.drag && !["navigate", "level-points"].includes(state.drag.tool)) {
      dirty();
      selectionLabel();
    }
    state.drag = null;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("lostpointercapture", end);
}
function renderProfile(profile, endpoints) {
  $("profile").replaceChildren();
  if (!profile?.distance?.length) {
    const text = document.createElement("p");
    text.className = "hint";
    text.textContent =
      "Choose Line profile and drag across a surface, then recalculate.";
    $("profile").append(text);
    return;
  }
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 500 210");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Calibrated height along selected line");
  function el(tag, attrs, text) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text) e.textContent = text;
    svg.append(e);
    return e;
  }
  const xmin = Math.min(...profile.distance),
    xmax = Math.max(...profile.distance),
    yr = range([profile.height]);
  const x = (v) => 65 + ((v - xmin) / (xmax - xmin || 1)) * 415,
    y = (v) => 165 - ((v - yr[0]) / (yr[1] - yr[0] || 1)) * 140;
  el("path", { d: "M65 15V165H480", fill: "none", stroke: "#bac9bd" });
  let d = "",
    fresh = true;
  profile.distance.forEach((distance, i) => {
    const height = profile.height[i];
    if (!finite(height)) {
      fresh = true;
      return;
    }
    d += (fresh ? "M" : "L") + x(distance) + "," + y(height);
    fresh = false;
  });
  el("path", { d, fill: "none", stroke: "#28676a", "stroke-width": 1.8 });
  el("text", { x: 65, y: 187 }, format(xmin, profile.xy_unit));
  el(
    "text",
    { x: 480, y: 187, "text-anchor": "end" },
    format(xmax, profile.xy_unit),
  );
  el(
    "text",
    { x: 57, y: 22, "text-anchor": "end" },
    format(yr[1], profile.z_unit),
  );
  el(
    "text",
    { x: 57, y: 166, "text-anchor": "end" },
    format(yr[0], profile.z_unit),
  );
  el(
    "text",
    { x: 270, y: 205, "text-anchor": "middle" },
    "Distance along profile",
  );
  $("profile").append(svg);
  const model = createProfileReadout(profile, endpoints);
  mountMeasurementReadout({
    svg,
    target: $("profile"),
    id: "profile-readout",
    model,
    plot: { x: 65, y: 15, width: 415, height: 150 },
    format,
    yAt: (index) => {
      const height = model.sample(index).height;
      return height === null ? null : y(height);
    },
  });
}
function save(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("file").onchange = loadFile;
$("channel").onchange = () => {
  configureAcquisition();
  resetComparison();
  state.operations = [];
  resetSelections();
  state.zoom = 1;
  state.pan = [0, 0];
  syncReference();
  analyze();
};
$("refresh").onclick = analyze;
$("operation").addEventListener("change", () => {
  const visible = $("operation").value === "line_polynomial";
  $("line-degree-control").hidden = $("line-polynomial-hint").hidden = !visible;
});
$("add").onclick = () => {
  const name = $("operation").value;
  let params = {};
  if (name === "robust_plane") params = { iterations: 5, sigma: 3 };
  if (name === "polynomial") params = { degree: 2 };
  if (name.startsWith("line_")) params = { axis: $("axis").value };
  if (name === "line_polynomial")
    params.degree = Number($("line-degree").value);
  if (name === "gaussian") {
    const sigma = Number($("sigma").value);
    if (!finite(sigma) || sigma <= 0) {
      status("Smoothing sigma must be positive.", true);
      return;
    }
    params = { sigma };
  }
  if (name === "crop") {
    if (!state.selection.roi) {
      status("Draw an ROI before adding a crop.", true);
      return;
    }
    params = { bounds: [...state.selection.roi] };
  }
  state.operations.push({
    name,
    params,
    selection: structuredClone(state.selection),
  });
  analyze();
};
$("undo").onclick = () => {
  state.operations.pop();
  analyze();
};
$("clear").onclick = () => {
  state.operations = [];
  analyze();
};
$("preset").onclick = () => {
  state.operations = [
    { name: "robust_plane", params: { iterations: 5, sigma: 3 } },
    { name: "zero_min", params: {} },
  ];
  state.operations = state.operations.map((operation) => ({
    ...operation,
    selection: structuredClone(state.selection),
  }));
  analyze();
};
$("chemist").onclick = () => {
  if ($("chemist").disabled) return;
  state.operations = [
    {
      name: "three_point",
      params: {
        points: [],
        radius: 1,
      },
    },
    { name: "zero_min", params: {} },
  ];
  state.operations = state.operations.map((operation) => ({
    ...operation,
    selection: structuredClone(state.selection),
  }));
  analyze();
};
$("finish-polygon").onclick = () => {
  if (state.polygon.length < 3) {
    status("Add at least three polygon vertices.", true);
    return;
  }
  state.selection.exclude_polygons.push(state.polygon);
  state.polygon = [];
  dirty();
  selectionLabel();
  render();
};
$("reset-selection").onclick = () => {
  resetSelections();
  dirty();
  render();
};
$("reset-view").onclick = () => {
  state.zoom = 1;
  state.pan = [0, 0];
  render();
};
for (const id of ["palette", "shared", "display-min", "display-max", "view"])
  $(id).onchange = () => {
    if (id === "view" && $("view").value !== "processed") levelEditor?.cancel();
    state.rasters = {};
    render();
  };
$("compare").onchange = analyze;
$("reference-file").onchange = async () => {
  const active = $("compare").checked;
  if (active) dirty("Loading reference channels…");
  await loadReference($("reference-channel").value, active);
};
$("reference-channel").onchange = () => {
  if ($("compare").checked) analyze();
};
$("download").onclick = () => {
  if (state.response)
    save(
      new Blob([JSON.stringify(state.response.recipe, null, 2)], {
        type: "application/json",
      }),
      "afm-recipe.json",
    );
};
let portableBusy = false;
function syncPortableDownload() {
  $("download-portable").disabled = portableBusy || $("download").disabled;
}
new MutationObserver(syncPortableDownload).observe($("download"), {
  attributes: true,
  attributeFilter: ["disabled"],
});
syncPortableDownload();
$("download-portable").onclick = async () => {
  if (portableBusy) return;
  const snapshot = getAnalysisSnapshot();
  if (!snapshot) return;
  const seq = state.sequence;
  portableBusy = true;
  syncPortableDownload();
  status("Verifying captured analysis before saving a portable recipe…");
  try {
    const document = await api("/api/recipe-document", {
      recipe: snapshot.recipe,
    });
    save(
      new Blob([JSON.stringify(document, null, 2)], {
        type: "application/json",
      }),
      "afm-recipe-v2.json",
    );
    if (seq === state.sequence)
      status("Verified portable recipe saved for the captured analysis.");
  } catch (error) {
    if (seq === state.sequence)
      status("Portable recipe export failed: " + error.message, true);
  } finally {
    portableBusy = false;
    syncPortableDownload();
  }
};
$("export").onclick = async () => {
  try {
    status("Preparing reproducible export…");
    const response = await apiFetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "The local operation failed.");
    }
    save(await response.blob(), "afm-analysis.tar");
    status("Analysis archive downloaded.");
  } catch (e) {
    status(e.message, true);
  }
};
/** Display an explicitly selected recipe after strict local replay. */
export async function showRecipeInViewer(input) {
  if (JSON.stringify(input).length > 1024 * 1024)
    throw new Error(
      "Recipe files must be at most 1 MiB. No replay was performed.",
    );
  const seq = ++state.sequence;
  invalidateAcquisition();
  try {
    $("download").disabled = true;
    $("export").disabled = true;
    status("Replaying recipe…");
    const result = await api("/api/replay", { recipe: input });
    const recipe = result.recipe;
    if (seq !== state.sequence)
      throw new Error(
        "Dashboard changed while replaying; this result was not applied.",
      );
    const source = result.source.file;
    $("file").value = source;
    const info = await api("/api/channels?file=" + encodeURIComponent(source));
    if (seq !== state.sequence)
      throw new Error(
        "Dashboard changed while replaying; this result was not applied.",
      );
    state.channels = info.channels;
    state.tracePairs = info.trace_pairs || [];
    state.support = info.support || null;
    $("channel").replaceChildren();
    for (const c of info.channels)
      option($("channel"), c.id, c.id + " · " + c.title);
    $("channel").value = String(result.channel.id);
    configureAcquisition();
    state.operations = (recipe.operations || result.history || []).map(
      (op) => ({
        name: op.name,
        params: op.params || {},
        selection: structuredClone(op.selection ?? recipe.selection),
      }),
    );
    state.selection = recipe.selection || { roi: null, exclude_polygons: [] };
    state.profile = recipe.profile || null;
    state.plateaus = recipe.plateaus || [null, null];
    state.polygon = [];
    syncReference();
    $("compare").checked = !!recipe.reference;
    if (recipe.reference) {
      referenceOptions(recipe.reference.file);
      await loadReference(recipe.reference.channel);
      if (seq !== state.sequence)
        throw new Error(
          "Dashboard changed while replaying; this result was not applied.",
        );
    }
    state.response = result;
    state.rasters = {};
    state.zoom = 1;
    state.pan = [0, 0];
    renderAll();
    $("download").disabled = false;
    $("export").disabled = false;
    status("Recipe replay complete.");
  } catch (e) {
    if (seq === state.sequence) status(e.message, true);
    throw e;
  }
}
$("upload").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024)
      throw new Error(
        "Recipe files must be at most 1 MiB. No replay was performed.",
      );
    await showRecipeInViewer(JSON.parse(await file.text()));
  } catch (error) {
    status(error.message, true);
  }
  event.target.value = "";
};
new ResizeObserver(() => render()).observe($("raw").parentElement);
async function refreshFiles(preferred) {
  const result = await api("/api/files");
  state.files = result.files;
  $("file").replaceChildren();
  for (const file of state.files) option($("file"), file.name, file.name);
  if (preferred && state.files.some((f) => f.name === preferred))
    $("file").value = preferred;
  referenceOptions();
  await loadReference();
  if (state.files.length) await loadFile();
}
$("import").onchange = async (event) => {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  try {
    dirty("Importing local measurements…");
    const response = await apiFetch("/api/import", {
      method: "POST",
      body: files,
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "The local operation failed.");
    }
    await refreshFiles(files[0].name);
  } catch (e) {
    status(e.message, true);
  }
  event.target.value = "";
};
async function init() {
  $("download").disabled = true;
  $("export").disabled = true;
  $("compare").disabled = true;
  try {
    const result = await api("/api/files");
    state.files = result.files;
    for (const file of state.files) option($("file"), file.name, file.name);
    if (state.files.some((file) => file.name === result.reference_pair?.raw))
      $("file").value = result.reference_pair.raw;
    referenceOptions(result.reference_pair?.reference);
    await loadReference();
    if (!state.files.length) {
      status("Import a local GWYP or NanoScope raster file to begin.");
      return;
    }
    await loadFile();
  } catch (error) {
    status(error.message + " Import a local AFM file to continue.", true);
  }
}
init();

$("import-trigger").onclick = () => $("import").click();
$("upload-trigger").onclick = () => $("upload").click();
function coordinates() {
  const inputs = ["coord-x0", "coord-y0", "coord-x1", "coord-y1"];
  if (inputs.some((id) => $(id).value.trim() === ""))
    throw new Error("Enter all four physical coordinates.");
  const a = inputs.map((id) => Number($(id).value));
  if (!a.every(finite)) throw new Error("Coordinates must be finite numbers.");
  return a;
}
function setCoordinates(kind) {
  try {
    const [x0, y0, x1, y1] = coordinates();
    if (x0 === x1 && y0 === y1) throw new Error("Select two distinct points.");
    if (kind === "roi") {
      if (x0 === x1 || y0 === y1)
        throw new Error("ROI must have positive width and height.");
      state.selection.roi = [
        Math.min(x0, x1),
        Math.min(y0, y1),
        Math.max(x0, x1),
        Math.max(y0, y1),
      ];
    } else
      state.profile = [
        [x0, y0],
        [x1, y1],
      ];
    dirty();
    selectionLabel();
    render();
  } catch (e) {
    status(e.message, true);
  }
}
$("coordinate-roi").onclick = () => setCoordinates("roi");
$("coordinate-profile").onclick = () => setCoordinates("profile");
$("coordinate-exclude").onclick = () => {
  try {
    const points = JSON.parse($("coordinate-polygon").value);
    if (
      !Array.isArray(points) ||
      points.length < 3 ||
      points.some(
        (p) => !Array.isArray(p) || p.length !== 2 || !p.every(finite),
      )
    )
      throw new Error(
        "A polygon needs at least three [x,y] pairs of finite numbers.",
      );
    state.selection.exclude_polygons.push(points);
    dirty();
    selectionLabel();
    render();
  } catch (e) {
    status(e.message, true);
  }
};

function setPlateau(index) {
  if (!state.selection.roi) {
    status("Draw or enter a rectangle ROI first.", true);
    return;
  }
  state.plateaus[index] = [...state.selection.roi];
  dirty("Plateau region updated. Recalculate to measure the step.");
  selectionLabel();
  render();
}
$("plateau-a").onclick = () => setPlateau(0);
$("plateau-b").onclick = () => setPlateau(1);
$("clear-plateaus").onclick = () => {
  state.plateaus = [null, null];
  dirty();
  selectionLabel();
  render();
};
function renderStep(step) {
  const target = $("step");
  target.replaceChildren();
  if (!step) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Set plateau A and plateau B, then recalculate.";
    target.append(p);
    return;
  }
  const height = document.createElement("p");
  height.className = "step-height";
  height.textContent = format(step.height, step.z_unit);
  target.append(height);
  const method = document.createElement("p");
  method.textContent = "Mean B − mean A";
  target.append(method);
  for (const [name, region] of [
    ["A", step.plateau_a],
    ["B", step.plateau_b],
  ]) {
    const p = document.createElement("p");
    p.textContent =
      "Plateau " +
      name +
      ": mean " +
      format(region.mean, step.z_unit) +
      " · SD " +
      format(region.sd, step.z_unit) +
      " · " +
      region.count.toLocaleString() +
      " valid pixels";
    target.append(p);
  }
}
function renderHistogram(histogram, unit) {
  const target = $("histogram");
  target.replaceChildren();
  if (!histogram?.counts?.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No finite selected heights.";
    target.append(p);
    return;
  }
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 500 210");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "Histogram of selected surface heights; horizontal axis height, vertical axis pixel count",
  );
  function el(tag, attrs, text) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs))
      node.setAttribute(key, value);
    if (text) node.textContent = text;
    svg.append(node);
  }
  const { counts, edges } = histogram,
    max = Math.max(...counts, 1),
    width = 420 / counts.length;
  el("path", { d: "M55 15V165H480", stroke: "#bac9bd", fill: "none" });
  counts.forEach((count, i) => {
    const h = (count / max) * 145;
    const node = document.createElementNS(ns, "rect");
    node.setAttribute("x", 55 + i * width);
    node.setAttribute("y", 165 - h);
    node.setAttribute("width", Math.max(0.2, width - 1));
    node.setAttribute("height", h);
    node.setAttribute("fill", "#397e7e");
    const title = document.createElementNS(ns, "title");
    title.textContent =
      format(edges[i], unit) +
      " to " +
      format(edges[i + 1], unit) +
      ": " +
      count +
      " pixels";
    node.append(title);
    svg.append(node);
  });
  el("text", { x: 48, y: 24, "text-anchor": "end" }, String(max));
  el("text", { x: 48, y: 165, "text-anchor": "end" }, "0");
  el("text", { x: 55, y: 185 }, format(edges[0], unit));
  el(
    "text",
    { x: 480, y: 185, "text-anchor": "end" },
    format(edges.at(-1), unit),
  );
  el(
    "text",
    { x: 270, y: 205, "text-anchor": "middle" },
    "Selected height · counts per bin",
  );
  target.append(svg);
  mountMeasurementReadout({
    svg,
    target,
    id: "histogram-readout",
    model: createHistogramReadout(histogram, unit),
    plot: { x: 55, y: 15, width: 420, height: 150 },
    format,
  });
}

function renderSupport() {
  const support = state.support,
    channel = currentChannel();
  const unverified =
    !support ||
    support.status !== "validated" ||
    channel?.z_unit == null ||
    channel?.xy_unit == null;
  $("import-support").classList.toggle("unverified", unverified);
  $("support-title").textContent = unverified
    ? "Unverified configuration"
    : "Validated import subset";
  const lines = [$("file").value || "No source selected"];
  if (support) {
    lines.push(
      [support.format, support.configuration].filter(Boolean).join(" · "),
    );
    if (support.message) lines.push(support.message);
  } else
    lines.push(
      "This import has no validated configuration record. Inspect calibration before quantitative interpretation.",
    );
  if (channel && (channel.z_unit == null || channel.xy_unit == null))
    lines.push(
      "Channel " +
        channel.id +
        " calibration warning: " +
        (channel.z_unit == null ? "vertical unit is unknown. " : "") +
        (channel.xy_unit == null ? "lateral unit is unknown." : "") +
        " Values are not assumed to be metres.",
    );
  $("support-message").textContent = lines.filter(Boolean).join("\n");
}

function invalidateAcquisition() {
  ++acquisition.sequence;
  acquisition.result = null;
  $("acquisition-export").disabled = true;
  $("acquisition-report").replaceChildren();
  $("acquisition-status").classList.remove("error");
  $("acquisition-status").textContent =
    "Diagnostics not current. Check the original acquisition to refresh.";
}
function configureAcquisition() {
  invalidateAcquisition();
  const selector = $("acquisition-reference");
  selector.replaceChildren();
  option(selector, "", "None — no comparison");
  const id = $("channel").value;
  const pair = state.tracePairs.find(
    (pair) => String(pair.trace_id) === id || String(pair.retrace_id) === id,
  );
  const suggestion = pair
    ? String(pair.trace_id) === id
      ? String(pair.retrace_id)
      : String(pair.trace_id)
    : null;
  for (const channel of state.channels)
    option(
      selector,
      channel.id,
      channel.id +
        " · " +
        channel.title +
        (String(channel.id) === suggestion
          ? " · named trace/retrace pair"
          : ""),
    );
  selector.value = "";
  $("acquisition-pair").textContent =
    suggestion !== null
      ? "Named trace/retrace pairing suggests channel " +
        suggestion +
        ". Select it explicitly to compare; no alignment is performed."
      : "Select a reference explicitly to compare channels; no alignment is performed.";
}
function acquisitionText(tag, text, parent) {
  const node = document.createElement(tag);
  node.textContent = text;
  parent.append(node);
  return node;
}
function renderAcquisition(result) {
  const target = $("acquisition-report");
  target.replaceChildren();
  const report = result.report,
    counts = report.counts,
    unit = report.units?.z;
  acquisitionText(
    "p",
    "Original source: " +
      result.input.file +
      " · channel " +
      result.input.channel +
      " · " +
      result.input.channel_title,
    target,
  );
  const countBox = document.createElement("div");
  countBox.className = "acquisition-counts";
  for (const [label, count] of [
    ["Total", counts.total],
    ["Selected valid", counts.selected],
    ["Nonfinite (whole source)", counts.invalid],
    ["Imported mask (whole source)", counts.imported_mask],
    ["Selection-excluded valid", counts.selection_excluded_valid],
  ])
    acquisitionText(
      "span",
      label + ": " + Number(count).toLocaleString(),
      countBox,
    );
  target.append(countBox);
  const boundaries = document.createElement("div");
  boundaries.className = "acquisition-boundaries";
  for (const [label, axis] of [
    ["Row", report.rows],
    ["Column", report.columns],
  ]) {
    const section = document.createElement("section"),
      candidates = axis.candidates || [];
    acquisitionText(
      "h3",
      label + " boundaries: " + candidates.length + " candidate(s)",
      section,
    );
    acquisitionText(
      "p",
      "Threshold: " +
        format(axis.threshold, unit) +
        " · centered adjacent-median changes; first " +
        Math.min(20, candidates.length) +
        " shown.",
      section,
    );
    if (candidates.length) {
      const table = document.createElement("table"),
        head = document.createElement("tr");
      for (const text of ["Boundary index", "Delta", "Threshold"])
        acquisitionText("th", text, head);
      const thead = document.createElement("thead");
      thead.append(head);
      table.append(thead);
      const tbody = document.createElement("tbody");
      for (const candidate of candidates.slice(0, 20)) {
        const row = document.createElement("tr");
        for (const value of [
          String(candidate.boundary_index),
          format(candidate.delta, candidate.z_unit ?? unit),
          format(candidate.threshold, candidate.z_unit ?? unit),
        ])
          acquisitionText("td", value, row);
        tbody.append(row);
      }
      table.append(tbody);
      section.append(table);
    }
    boundaries.append(section);
  }
  target.append(boundaries);
  if (report.comparison) {
    const comparison = report.comparison;
    acquisitionText(
      "p",
      "Explicit reference channel " +
        result.input.reference_channel +
        ": RMSE " +
        format(comparison.rmse, comparison.z_unit ?? unit) +
        " · MAE " +
        format(comparison.mae, comparison.z_unit ?? unit) +
        " · mean difference " +
        format(comparison.mean_difference, comparison.z_unit ?? unit) +
        ". " +
        (comparison.definition || ""),
      target,
    );
  } else acquisitionText("p", "No reference comparison requested.", target);
  const warnings = [
    ...new Set([...(result.input.warnings || []), ...(report.warnings || [])]),
  ];
  if (warnings.length) {
    const list = document.createElement("ul");
    for (const warning of warnings) acquisitionText("li", warning, list);
    target.append(list);
  }
  acquisitionText(
    "p",
    "Source SHA-256: " +
      result.input.sha256 +
      " · Diagnostic code SHA-256: " +
      result.code.sha256,
    target,
  );
}
$("acquisition-check").onclick = async () => {
  invalidateAcquisition();
  const seq = acquisition.sequence;
  const file = $("file").value,
    channel = $("channel").value;
  if (!file || channel === "") {
    $("acquisition-status").textContent = "Select a source channel first.";
    $("acquisition-status").classList.add("error");
    return;
  }
  $("acquisition-status").textContent = "Checking original acquisition…";
  try {
    const result = await api("/api/quality", {
      file,
      channel,
      selection: structuredClone(state.selection),
      boundary_sigma: Number($("acquisition-sigma").value),
      reference_channel: $("acquisition-reference").value || null,
    });
    if (seq !== acquisition.sequence) return;
    acquisition.result = result;
    renderAcquisition(result);
    $("acquisition-export").disabled = false;
    $("acquisition-status").textContent =
      "Original acquisition diagnostics complete. Data and processing pipeline are unchanged.";
  } catch (error) {
    if (seq === acquisition.sequence) {
      $("acquisition-status").textContent = error.message;
      $("acquisition-status").classList.add("error");
    }
  }
};
$("acquisition-export").onclick = () => {
  if (acquisition.result)
    save(
      new Blob([JSON.stringify(acquisition.result, null, 2)], {
        type: "application/json",
      }),
      "afm-acquisition-quality.json",
    );
};
$("acquisition-reference").onchange = invalidateAcquisition;
$("acquisition-sigma").onchange = invalidateAcquisition;

const batch = {
  template: null,
  files: [],
  selected: new Set(),
  manifest: null,
  preflight: [],
  busy: false,
  cancel: false,
  generation: 0,
};
function batchStatus(message, error = false) {
  $("batch-status").textContent = message;
  $("batch-status").classList.toggle("error", error);
}
function syncBatchControls() {
  $("batch-capture").disabled =
    batch.busy || $("download").disabled || !state.response?.recipe;
  for (const id of ["batch-refresh", "batch-reset"])
    $(id).disabled = batch.busy;
  $("batch-files").disabled = batch.busy;
  for (const id of ["batch-preflight", "batch-start"])
    $(id).disabled = batch.busy || !batch.template || !batch.selected.size;
  $("batch-cancel").disabled =
    !batch.busy || batch.phase !== "running" || batch.cancel;
  $("batch-download").disabled = !batch.manifest;
}
function describeBatchTemplate() {
  const t = batch.template,
    g = t?.source.geometry;
  $("batch-template").textContent = t
    ? "Captured from " +
      t.source.file +
      " · channel " +
      t.source.channel +
      " (" +
      (t.source.title || "untitled") +
      ")" +
      " · operations: " +
      (t.operations.map((op) => op.name).join(" → ") || "none") +
      " · " +
      g.shape.join(" × ") +
      " pixels" +
      " · span " +
      format(g.xreal, g.xy_unit) +
      " × " +
      format(g.yreal, g.xy_unit) +
      " · offsets x " +
      format(g.xoff, g.xy_unit) +
      ", y " +
      format(g.yoff, g.xy_unit) +
      " · vertical unit " +
      (g.z_unit || "unknown") +
      ". This snapshot is independent of later interactive edits."
    : "No template captured. Analyze a source channel first.";
}
async function refreshBatchFiles() {
  if (batch.busy) return;
  const generation = ++batch.generation;
  try {
    const result = await api("/api/files");
    if (generation !== batch.generation) return;
    batch.files = result.files;
    batch.selected = new Set(
      [...batch.selected].filter((name) =>
        batch.files.some((file) => file.name === name),
      ),
    );
    const root = $("batch-files");
    root.replaceChildren();
    const legend = document.createElement("legend");
    legend.textContent = "Select input files";
    root.append(legend);
    for (const file of batch.files) {
      const label = document.createElement("label"),
        input = document.createElement("input"),
        text = document.createElement("span");
      input.type = "checkbox";
      input.value = file.name;
      input.checked = batch.selected.has(file.name);
      text.textContent = file.name;
      input.onchange = () => {
        if (input.checked) batch.selected.add(file.name);
        else batch.selected.delete(file.name);
        batch.preflight = [];
        if (!batch.manifest) renderBatchRecords();
        syncBatchControls();
      };
      label.append(input, text);
      root.append(label);
    }
    syncBatchControls();
  } catch (error) {
    batchStatus(error.message, true);
  }
}
function renderBatchRecords() {
  const root = $("batch-records");
  root.replaceChildren();
  const records = batch.manifest?.records || batch.preflight;
  for (const record of records) {
    const details = record.result || record;
    const row = document.createElement("article");
    row.className = "batch-record";
    row.dataset.file = record.file;
    row.dataset.status = record.status;
    acquisitionText("h3", record.file + " · " + record.status, row);
    if (details.support)
      acquisitionText(
        "p",
        "Import support: " +
          details.support.status +
          " · " +
          (details.support.configuration || details.support.format || "") +
          " · " +
          (details.support.message || ""),
        row,
      );
    if (record.error) acquisitionText("p", "Error: " + record.error, row);
    if (details.warnings?.length)
      acquisitionText("p", "Warnings: " + details.warnings.join(" · "), row);
    if (record.status === "complete" && details.recipe) {
      const controls = document.createElement("div");
      controls.className = "button-row";
      const recipeButton = document.createElement("button");
      recipeButton.textContent = "Download recipe";
      recipeButton.dataset.action = "recipe";
      recipeButton.disabled = batch.busy;
      recipeButton.onclick = () =>
        save(
          new Blob([JSON.stringify(details.recipe, null, 2)], {
            type: "application/json",
          }),
          record.file + "-recipe.json",
        );
      const tarButton = document.createElement("button");
      tarButton.textContent = "Export verified TAR";
      tarButton.dataset.action = "tar";
      tarButton.disabled = batch.busy;
      tarButton.onclick = async () => {
        if (batch.busy) return;
        const generation = batch.generation;
        batch.busy = true;
        batch.phase = "export";
        syncBatchControls();
        renderBatchRecords();
        batchStatus("Verifying " + record.file + " before export…");
        try {
          const response = await apiFetch("/api/batch-export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: record.file, recipe: details.recipe }),
          });
          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Batch export failed.");
          }
          const blob = await response.blob();
          if (generation !== batch.generation) return;
          save(blob, record.file + "-analysis.tar");
          batchStatus("Verified archive downloaded for " + record.file + ".");
        } catch (error) {
          if (generation === batch.generation) batchStatus(error.message, true);
        } finally {
          if (generation === batch.generation) {
            batch.busy = false;
            batch.phase = null;
            syncBatchControls();
            renderBatchRecords();
          }
        }
      };
      controls.append(recipeButton, tarButton);
      row.append(controls);
    }
    root.append(row);
  }
}
$("batch-capture").onclick = () => {
  if (batch.busy || $("download").disabled || !state.response?.recipe) {
    batchStatus(
      "Recalculate the current analysis before capturing a template.",
      true,
    );
    return;
  }
  if (state.response.recipe.reference) {
    batchStatus(
      "Reference-bearing recipes cannot be batch templates. Disable comparison and recalculate, then capture again.",
      true,
    );
    return;
  }
  batch.template = structuredClone(state.response.recipe);
  batch.manifest = null;
  batch.preflight = [];
  ++batch.generation;
  describeBatchTemplate();
  renderBatchRecords();
  syncBatchControls();
  batchStatus("Recipe snapshot captured. Select the files to process.");
};
$("batch-refresh").onclick = refreshBatchFiles;
$("batch-reset").onclick = () => {
  if (batch.busy) return;
  ++batch.generation;
  batch.template = null;
  batch.manifest = null;
  batch.preflight = [];
  batch.selected.clear();
  batch.cancel = false;
  describeBatchTemplate();
  renderBatchRecords();
  refreshBatchFiles();
  syncBatchControls();
  batchStatus("Batch reset. Interactive analysis is unchanged.");
};
$("batch-preflight").onclick = async () => {
  if (batch.busy || !batch.template || !batch.selected.size) return;
  batch.busy = true;
  batch.phase = "preflight";
  batch.preflight = [];
  batch.manifest = null;
  const generation = ++batch.generation,
    template = structuredClone(batch.template),
    files = [...batch.selected];
  syncBatchControls();
  renderBatchRecords();
  try {
    for (const file of files) {
      batchStatus("Checking " + file + "…");
      try {
        const result = await api("/api/batch-check", { file, template });
        batch.preflight.push({ ...result, file, status: "compatible" });
      } catch (error) {
        batch.preflight.push({
          file,
          status: "incompatible",
          error: error.message,
        });
      }
      if (generation !== batch.generation) return;
      renderBatchRecords();
    }
    batchStatus(
      "Preflight complete: " +
        batch.preflight.filter((r) => r.status === "compatible").length +
        " of " +
        files.length +
        " compatible. Running still validates each input.",
    );
  } finally {
    if (generation === batch.generation) {
      batch.busy = false;
      batch.phase = null;
      syncBatchControls();
    }
  }
};
$("batch-start").onclick = async () => {
  if (batch.busy || !batch.template || !batch.selected.size) return;
  batch.busy = true;
  batch.phase = "running";
  batch.cancel = false;
  batch.manifest = null;
  batch.preflight = [];
  const generation = ++batch.generation,
    template = structuredClone(batch.template),
    files = [...batch.selected];
  syncBatchControls();
  renderBatchRecords();
  try {
    const finalManifest = await runBatch({
      template,
      files,
      execute: (file, snapshot) =>
        api("/api/batch-run", { file, template: snapshot }),
      shouldCancel: () => batch.cancel,
      onUpdate: (manifest) => {
        if (generation !== batch.generation) return;
        batch.manifest = structuredClone(manifest);
        renderBatchRecords();
        syncBatchControls();
        const done = manifest.records.filter((r) =>
          ["complete", "failed"].includes(r.status),
        ).length;
        batchStatus(
          (batch.cancel
            ? "Cancellation requested; finishing the current file. "
            : "Processing batch. ") +
            done +
            " of " +
            files.length +
            " finished.",
        );
      },
    });
    if (generation !== batch.generation) return;
    if (finalManifest) batch.manifest = structuredClone(finalManifest);
    batchStatus(
      batch.manifest?.canceled
        ? "Batch canceled after the current file; remaining inputs were not run."
        : "Batch finished. Inspect individual records for failures and warnings.",
    );
  } catch (error) {
    if (generation === batch.generation) batchStatus(error.message, true);
  } finally {
    if (generation === batch.generation) {
      batch.busy = false;
      batch.phase = null;
      renderBatchRecords();
      syncBatchControls();
    }
  }
};
$("batch-cancel").onclick = () => {
  if (batch.busy && batch.phase === "running") {
    batch.cancel = true;
    batchStatus(
      "Cancellation requested. The current file finishes; later files will not run.",
    );
    syncBatchControls();
  }
};
$("batch-download").onclick = () => {
  if (batch.manifest)
    save(
      new Blob([JSON.stringify(batch.manifest, null, 2)], {
        type: "application/json",
      }),
      "afm-batch-manifest.json",
    );
};
new MutationObserver(syncBatchControls).observe($("download"), {
  attributes: true,
  attributeFilter: ["disabled"],
});
refreshBatchFiles();

/** Detached current processed analysis for explicitly captured downstream measurements. */
export function getAnalysisSnapshot() {
  if ($("download").disabled || !state.response?.recipe) return null;
  return structuredClone({
    recipe: state.response.recipe,
    data: state.response.data,
    channel: state.response.channel,
    statistics: state.response.statistics,
  });
}

function levelContext() {
  const r = state.response;
  if (!r?.recipe) return null;
  return {
    source_key: JSON.stringify({
      request: body(),
      source: r.recipe.source,
      output: r.recipe.output.sha256,
    }),
    geometry: structuredClone(r.recipe.output.geometry),
  };
}
function recordedLevelPoints() {
  const r = state.response,
    context = levelContext();
  if (!context) return null;
  let g = structuredClone(r.recipe.source.geometry),
    recorded = null;
  for (const step of r.history || []) {
    if (step.name === "three_point")
      recorded = {
        operation: { name: step.name, params: structuredClone(step.params) },
        context: {
          source_key: context.source_key,
          geometry: structuredClone(g),
        },
      };
    if (step.name === "crop") {
      const [x0, y0, x1, y1] = step.details.pixel_bounds,
        dx = g.xreal / g.shape[1],
        dy = g.yreal / g.shape[0];
      g = {
        ...g,
        shape: [y1 - y0, x1 - x0],
        xreal: (x1 - x0) * dx,
        yreal: (y1 - y0) * dy,
        xoff: g.xoff + x0 * dx,
        yoff: g.yoff + y0 * dy,
      };
    }
  }
  return recorded;
}
function clearLevelPreview() {
  ++levelRequest;
  const saved = levelPreview;
  levelPreview = null;
  if (saved) {
    state.rasters = {};
    if (saved.sequence === state.sequence) {
      $("download").disabled = saved.downloadDisabled;
      $("export").disabled = saved.exportDisabled;
    }
  }
}
levelEditor = mountThreePointEditor({
  host: $("three-point-host"),
  onChange: () => {
    clearLevelPreview();
    render();
  },
  onStart: () => {
    if (!levelContext() || $("download").disabled) {
      status(
        "Recalculate the current surface before starting a point draft.",
        true,
      );
      return;
    }
    $("view").value = "processed";
    $("tool").value = "level-points";
    state.rasters = {};
    levelEditor.start(levelContext());
  },
  preview: async (operation) => {
    clearLevelPreview();
    const requestId = ++levelRequest,
      sequence = state.sequence,
      context = levelContext();
    if (!context || $("download").disabled)
      throw Error("Recalculate before previewing leveling.");
    const request = body();
    request.operations.push({
      ...operation,
      selection: structuredClone(state.selection),
    });
    const result = await api("/api/analyze", request);
    if (
      requestId !== levelRequest ||
      sequence !== state.sequence ||
      context.source_key !== levelContext()?.source_key ||
      !levelEditor.isActive()
    )
      throw Error("Point preview was superseded by a workspace change.");
    levelPreview = {
      result,
      operation: structuredClone(operation),
      source_key: context.source_key,
      sequence,
      downloadDisabled: $("download").disabled,
      exportDisabled: $("export").disabled,
    };
    $("download").disabled = true;
    $("export").disabled = true;
    $("view").value = "processed";
    state.rasters = {};
    render();
  },
  apply: async (operation) => {
    if (
      !levelPreview ||
      levelPreview.source_key !== levelContext()?.source_key ||
      JSON.stringify(levelPreview.operation) !== JSON.stringify(operation)
    )
      throw Error("Preview these exact points before applying.");
    levelEditor.cancel();
    state.operations.push({
      ...structuredClone(operation),
      selection: structuredClone(state.selection),
    });
    await analyze();
    if ($("download").disabled)
      throw Error(
        "Leveling could not be committed. Review the analysis error.",
      );
  },
});
levelEditor.sync(levelContext(), recordedLevelPoints());
