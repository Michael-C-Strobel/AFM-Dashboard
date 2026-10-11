import { apiFetch } from "./api.js";
("use strict");
const $ = (id) => document.getElementById(id);
const state = {
  files: [],
  channels: [],
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
  ++state.sequence;
  status(message);
  $("download").disabled = true;
  $("export").disabled = true;
}
function resetSelections() {
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
    ". Step regions ignore the global ROI; exclusions still apply.";

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
    ". Draw a selection, then recalculate. Nonfinite pixels appear checkerboard.";
}
async function loadFile() {
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
  const seq = ++state.sequence;
  const request = body();
  status("Analyzing surface…");
  $("download").disabled = true;
  $("export").disabled = true;
  try {
    const result = await api("/api/analyze", request);
    if (seq !== state.sequence) return;
    state.response = result;
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
    button.title = "Keep pipeline through this step";
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
  renderProfile(r.profile);
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
function color(t) {
  const stops = palettes[$("palette").value],
    v = Math.max(0, Math.min(1, t)) * (stops.length - 1),
    i = Math.min(stops.length - 2, Math.floor(v)),
    f = v - i;
  return stops[i].map((x, j) => Math.round(x * (1 - f) + stops[i + 1][j] * f));
}
function range(data) {
  let min = Infinity,
    max = -Infinity;
  for (const row of data || [])
    for (const x of row)
      if (finite(x)) {
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
  return min === Infinity ? [0, 1] : [min, max];
}
function rightData() {
  const r = state.response;
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
  $("result-badge").textContent =
    $("view").value === "processed"
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
      pixels = c.createImageData(raster.width, raster.height);
    for (let y = 0; y < data.length; y++)
      for (let x = 0; x < data[y].length; x++) {
        const value = data[y][x],
          i = (y * raster.width + x) * 4;
        if (finite(value)) {
          const rgb = color((value - limits[0]) / (limits[1] - limits[0] || 1));
          pixels.data.set([...rgb, 255], i);
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
    if (state.drag && state.drag.tool !== "navigate") {
      dirty();
      selectionLabel();
    }
    state.drag = null;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}
function renderProfile(profile) {
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
  resetComparison();
  state.operations = [];
  resetSelections();
  state.zoom = 1;
  state.pan = [0, 0];
  syncReference();
  analyze();
};
$("refresh").onclick = analyze;
$("add").onclick = () => {
  const name = $("operation").value;
  let params = {};
  if (name === "robust_plane") params = { iterations: 5, sigma: 3 };
  if (name === "polynomial") params = { degree: 2 };
  if (name.startsWith("line_")) params = { axis: $("axis").value };
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
  state.operations.push({ name, params });
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
$("upload").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const seq = ++state.sequence;
  try {
    status("Replaying recipe…");
    const recipe = JSON.parse(await file.text());
    const result = await api("/api/replay", { recipe });
    if (seq !== state.sequence) return;
    const source = result.source.file;
    $("file").value = source;
    const info = await api("/api/channels?file=" + encodeURIComponent(source));
    if (seq !== state.sequence) return;
    state.channels = info.channels;
    state.support = info.support || null;
    $("channel").replaceChildren();
    for (const c of info.channels)
      option($("channel"), c.id, c.id + " · " + c.title);
    $("channel").value = String(result.channel.id);
    state.operations = (recipe.operations || result.history || []).map(
      (op) => ({ name: op.name, params: op.params || {} }),
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
      if (seq !== state.sequence) return;
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

for (const label of document.querySelectorAll(".button[role=button]"))
  label.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      label.querySelector("input").click();
    }
  });
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
