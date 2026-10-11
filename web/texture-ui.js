import { apiFetch } from "./api.js";
import { getAnalysisSnapshot } from "./app.js";
const $ = (id) => document.getElementById("texture-" + id);
let captured = null,
  thumbnail = null,
  result = null,
  measuredParameters = null,
  busy = false;
const fmt = (v) => (Number.isFinite(v) ? v.toExponential(3) : "—");
const unit = (v) => v || "unknown unit";
function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function sync() {
  for (const id of ["capture", "scope", "detrend", "window"])
    $(id).disabled = busy;
  $("run").disabled = busy || !captured;
  $("json").disabled = $("tar").disabled = busy || !result;
  $("log").disabled = !result;
  $("normalized").disabled = !result?.acf.normalized_overview;
  if (!result?.acf.normalized_overview) $("normalized").checked = false;
}
function warn() {
  $("warnings").textContent = [
    ...new Set([
      ...(result?.warnings || []),
      "Finite-area sampling and mean/plane removal affect spectral and correlation estimates. Zero padding refines frequency sampling, not physical resolution.",
      "Small ROIs reduce the longest spatial wavelengths that can be assessed. Entire invalid outer rows or columns may be trimmed; internal holes are rejected, never filled.",
      "ACF uses the unwindowed residual. Edge lags have fewer overlapping pairs; normalized off-zero estimates can exceed one and are not clamped.",
      ...(result && !result.acf.normalized_overview
        ? ["Zero-energy residual: normalized ACF is unavailable."]
        : []),
    ]),
  ].join("\n");
}
function invalidate(message) {
  result = null;
  measuredParameters = null;
  $("summary").replaceChildren();
  sync();
  draw();
  warn();
  status(message);
}
$("scope").onchange = () => {
  $("scope-review").textContent =
    $("scope").value === "full"
      ? "On capture: remove the ROI and rerun the same processing operations in a separate analysis. Recorded processing selections stay fixed; legacy operations without their own selection can refit. Crop operations, imported masks and exclusion polygons remain. The viewer baseline stays unchanged. Review this choice before capturing."
      : "Capture retains the completed viewer recipe, including its ROI and exclusions. Later viewer edits do not update this snapshot.";
};
$("capture").onclick = async () => {
  if (busy) return;
  let snapshot = getAnalysisSnapshot();
  if (!snapshot) {
    status(
      "Capture refused: current analysis is dirty, pending or unavailable. Recalculate the main viewer first.",
      true,
    );
    return;
  }
  busy = true;
  sync();
  try {
    const baseline = snapshot.recipe;
    if ($("scope").value === "full" && baseline.selection.roi !== null) {
      status(
        "Creating a separate full-image capture with the same operations and exclusions…",
      );
      snapshot = await (
        await request("/api/analyze", {
          file: baseline.source.file,
          channel: Number(baseline.source.channel),
          operations: baseline.operations,
          selection: { ...baseline.selection, roi: null },
          profile: baseline.profile,
          plateaus: baseline.plateaus,
          reference: baseline.reference && {
            file: baseline.reference.file,
            channel: Number(baseline.reference.channel),
          },
        })
      ).json();
      if (
        snapshot.recipe.source.sha256 !== baseline.source.sha256 ||
        snapshot.recipe.engine.sha256 !== baseline.engine.sha256 ||
        snapshot.recipe.reference?.sha256 !== baseline.reference?.sha256
      )
        throw Error(
          "Capture source, reference or engine changed. Recalculate and review again.",
        );
    }
    captured = { recipe: structuredClone(snapshot.recipe) };
    thumbnail = makeThumbnail(snapshot.data);
    const r = captured.recipe;
    $("source").textContent =
      `Captured ${r.source.file} · channel ${r.source.channel} (${r.source.title})\nSource SHA-256 ${r.source.sha256}\nProcessed output SHA-256 ${r.output.sha256}\nSelection ${JSON.stringify(r.selection)}\nIndependent capture: later viewer edits do not change this recipe.`;
    invalidate(
      "Snapshot captured. Choose explicit preprocessing, then measure.",
    );
  } catch (error) {
    status(error.message + " Previous capture retained.", true);
  } finally {
    busy = false;
    sync();
    drawDomain();
  }
};
function makeThumbnail(data) {
  const height = data.length,
    width = data[0].length;
  const image = document.createElement("canvas");
  image.width = Math.min(192, width);
  image.height = Math.min(192, height);
  const values = [];
  let low = Infinity,
    high = -Infinity;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const value =
        data[Math.floor((y * height) / image.height)][
          Math.floor((x * width) / image.width)
        ];
      values.push(value);
      if (Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  const ctx = image.getContext("2d"),
    pixels = ctx.createImageData(image.width, image.height);
  values.forEach((value, i) => {
    const t = Number.isFinite(value)
      ? high === low
        ? 0.5
        : (value - low) / (high - low)
      : 0;
    pixels.data.set(
      Number.isFinite(value)
        ? [35 + 160 * t, 67 + 151 * t, 67 + 105 * t, 255]
        : [170, 170, 170, 255],
      i * 4,
    );
  });
  ctx.putImageData(pixels, 0, 0);
  return image;
}
function drawDomain() {
  const node = $("domain-map"),
    w = node.clientWidth,
    h = node.clientHeight;
  if (!w || !h) return;
  const dpr = devicePixelRatio || 1;
  node.width = Math.round(w * dpr);
  node.height = Math.round(h * dpr);
  const ctx = node.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#e8eeea";
  ctx.fillRect(0, 0, w, h);
  if (!captured) {
    $("domain").textContent = "No captured domain.";
    return;
  }
  const r = captured.recipe,
    g = r.output.geometry,
    roi = r.selection.roi;
  const label = roi
    ? "ROI"
    : r.operations.some((op) => op.name === "crop")
      ? "Cropped image"
      : "Full processed image";
  const ratio = Math.min((w - 28) / g.xreal, (h - 28) / g.yreal);
  const dw = g.xreal * ratio,
    dh = g.yreal * ratio,
    left = (w - dw) / 2,
    top = (h - dh) / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(thumbnail, left, top, dw, dh);
  const measured = result?.domain;
  const bounds = measured?.effective_physical_bounds ||
    roi || [g.xoff, g.yoff, g.xoff + g.xreal, g.yoff + g.yreal];
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, dw, dh);
  ctx.clip();
  ctx.strokeStyle = "#ffcf50";
  ctx.lineWidth = 3;
  ctx.setLineDash(measured ? [] : [5, 3]);
  ctx.strokeRect(
    left + (bounds[0] - g.xoff) * ratio,
    top + (bounds[1] - g.yoff) * ratio,
    (bounds[2] - bounds[0]) * ratio,
    (bounds[3] - bounds[1]) * ratio,
  );
  ctx.restore();
  const effective = result?.geometry;
  $("domain").textContent =
    `${label} · captured processed image ${g.shape[1]} × ${g.shape[0]} pixels · ${fmt(g.xreal)} × ${fmt(g.yreal)} ${unit(g.xy_unit)}. ` +
    (effective
      ? `Measured rectangle (solid amber): ${effective.shape[1]} × ${effective.shape[0]} pixels · ${fmt(effective.xreal)} × ${fmt(effective.yreal)} ${unit(effective.xy_unit)}. Effective physical bounds ${JSON.stringify(bounds)} ${unit(g.xy_unit)}; half-open processed pixel bounds ${JSON.stringify(result.source_bounds)}. `
      : "Dashed amber: requested domain; exact valid rectangle is established when measured. ") +
    `${r.selection.exclude_polygons.length} exclusion polygons; masks and nonfinite samples remain excluded. This is a snapshot, independent of the current viewer selection.`;
  node.dataset.pixelBounds = result ? JSON.stringify(result.source_bounds) : "";
  node.dataset.physicalBounds = measured ? JSON.stringify(bounds) : "";
}
for (const id of ["detrend", "window"])
  $(id).addEventListener("input", () =>
    invalidate(
      "Preprocessing changed. Measure again to produce a current report.",
    ),
  );
for (const id of ["log", "normalized"]) $(id).addEventListener("change", draw);
async function request(path, body) {
  const response = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || error.error || "Texture request failed.");
  }
  return response;
}
$("run").onclick = async () => {
  if (busy || !captured) return;
  result = null;
  measuredParameters = {
    detrend: $("detrend").value,
    window: $("window").value,
  };
  busy = true;
  sync();
  draw();
  $("summary").replaceChildren();
  status(
    "Strictly replaying the captured recipe and measuring spatial texture…",
  );
  try {
    result = await (
      await request("/api/texture", {
        recipe: captured.recipe,
        parameters: measuredParameters,
      })
    ).json();
    summary();
    status(
      "Texture complete. Overviews are reduced bin means; full numerical arrays are available in TAR.",
    );
  } catch (error) {
    result = null;
    status(error.message, true);
  } finally {
    busy = false;
    sync();
    warn();
    draw();
  }
};
function summary() {
  const p = result.psd,
    a = result.acf,
    s = result.sampling,
    g = result.geometry;
  const values = [
    ["PSD integral", `${fmt(p.integral)} ${unit(a.unit)}`],
    [
      "Expected windowed mean square",
      `${fmt(p.expected_mean_square)} ${unit(a.unit)}`,
    ],
    ["Unwindowed zero-lag ACF", `${fmt(a.zero_lag)} ${unit(a.unit)}`],
    [
      "Region / padded FFT",
      `${g.shape[1]} × ${g.shape[0]} / ${s.fft_width} × ${s.fft_height}`,
    ],
    ["Pixel pitch X / Y", `${fmt(s.dx)} / ${fmt(s.dy)} ${unit(g.xy_unit)}`],
    [
      "Frequency step X / Y",
      `${fmt(s.dfx)} / ${fmt(s.dfy)} ${unit(s.frequency_unit)}`,
    ],
    [
      "Preprocessing",
      `${result.parameters.detrend} detrend; ${result.parameters.window} window`,
    ],
    ["Half-open processed pixel bounds", JSON.stringify(result.source_bounds)],
    ["Report SHA-256", result.report_sha256],
  ];
  $("summary").replaceChildren(
    ...values.map(([label, value]) => {
      const div = document.createElement("div"),
        name = document.createElement("span"),
        val = document.createElement("strong");
      name.textContent = label;
      val.textContent = value;
      div.append(name, val);
      return div;
    }),
  );
}
function canvas(id) {
  const node = $(id),
    w = node.clientWidth,
    h = node.clientHeight;
  if (!w || !h) return null;
  const dpr = devicePixelRatio || 1;
  node.width = Math.round(w * dpr);
  node.height = Math.round(h * dpr);
  const ctx = node.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#f2f5fa";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "10px system-ui";
  if (!result) {
    ctx.fillStyle = "#62718a";
    ctx.fillText("Capture and measure a processed surface.", 12, 24);
    return null;
  }
  return {
    ctx,
    w,
    h,
    left: 58,
    top: 12,
    pw: Math.max(1, w - 82),
    ph: Math.max(1, h - 75),
  };
}
function axes(c, xmin, xmax, ymin, ymax, xlabel, ylabel) {
  const { ctx, left, top, pw, ph, w, h } = c;
  ctx.strokeStyle = "#8191a7";
  ctx.strokeRect(left, top, pw, ph);
  ctx.fillStyle = "#35465e";
  ctx.textAlign = "left";
  ctx.fillText(fmt(xmin), left, top + ph + 14);
  ctx.textAlign = "right";
  ctx.fillText(fmt(xmax), left + pw, top + ph + 14);
  ctx.textAlign = "center";
  ctx.fillText(xlabel, left + pw / 2, h - 7);
  ctx.textAlign = "right";
  ctx.fillText(fmt(ymax), left - 4, top + 8);
  ctx.fillText(fmt(ymin), left - 4, top + ph);
  ctx.save();
  ctx.translate(11, top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(ylabel, 0, 0);
  ctx.restore();
  ctx.textAlign = "left";
}
function rgb(a, b, t) {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}
function psdColor(t) {
  return t < 0.5
    ? rgb([23, 39, 79], [63, 106, 217], t * 2)
    : rgb([63, 106, 217], [246, 190, 73], t * 2 - 1);
}
function acfColor(t) {
  return t < 0.5
    ? rgb([48, 83, 169], [244, 245, 242], t * 2)
    : rgb([244, 245, 242], [204, 128, 30], t * 2 - 1);
}
function scale(values, log, diverging = false) {
  let min = Infinity,
    max = -Infinity,
    positive = Infinity;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    if (v > 0) positive = Math.min(positive, v);
  }
  if (diverging) {
    max = Math.max(Math.abs(min), Math.abs(max));
    min = -max;
  }
  const useLog = log && Number.isFinite(positive) && max > 0;
  const low = useLog ? Math.log10(positive) : min,
    high = useLog ? Math.log10(max) : max;
  return {
    min: useLog ? positive : min,
    max,
    log: useLog,
    value: (v) =>
      high === low
        ? 0.5
        : ((useLog ? Math.log10(v > 0 ? v : positive) : v) - low) /
          (high - low),
  };
}
function map(kind) {
  const c = canvas(kind);
  if (!c) return;
  const normalized = kind === "acf" && $("normalized").checked;
  const overview =
    kind === "psd"
      ? result.psd.overview
      : normalized
        ? result.acf.normalized_overview
        : result.acf.overview;
  const metadata = result.arrays[kind],
    { x_axis: x, y_axis: y } = metadata;
  const valueUnit =
    kind === "psd"
      ? result.psd.unit
      : normalized
        ? "dimensionless"
        : result.acf.unit;
  const s = scale(
    overview.data,
    kind === "psd" && $("log").checked,
    kind === "acf",
  );
  const color = kind === "psd" ? psdColor : acfColor,
    { ctx, left, top, pw, ph } = c;
  for (let row = 0; row < overview.height; row++)
    for (let col = 0; col < overview.width; col++) {
      const [xs, xe] = overview.x_bins[col],
        [ys, ye] = overview.y_bins[row];
      ctx.fillStyle =
        kind === "psd" &&
        s.log &&
        overview.data[row * overview.width + col] === 0
          ? "#dce2eb"
          : color(s.value(overview.data[row * overview.width + col]));
      // Half-open source-bin boundaries preserve unequal ACF reduction bins.
      ctx.fillRect(
        left + (xs / x.count) * pw,
        top + (1 - ye / y.count) * ph,
        ((xe - xs) / x.count) * pw,
        ((ye - ys) / y.count) * ph,
      );
    }
  axes(
    c,
    x.start - x.step / 2,
    x.start + (x.count - 0.5) * x.step,
    y.start - y.step / 2,
    y.start + (y.count - 0.5) * y.step,
    `${kind === "psd" ? "X frequency" : "X lag"} (${unit(x.unit)})`,
    kind === "psd" ? "Y frequency" : "Y lag",
  );
  const gy = top + ph + 26,
    gw = pw;
  for (let i = 0; i < 100; i++) {
    ctx.fillStyle = color(i / 99);
    ctx.fillRect(left + (i / 100) * gw, gy, gw / 100 + 1, 6);
  }
  ctx.fillStyle = "#35465e";
  ctx.fillText(fmt(s.min), left, gy + 17);
  ctx.textAlign = "right";
  ctx.fillText(fmt(s.max), left + gw, gy + 17);
  ctx.textAlign = "left";
  $(kind + "-legend").textContent =
    `${overview.width} × ${overview.height} overview from ${metadata.width} × ${metadata.height} samples. Arithmetic bin means; recorded half-open bin boundaries determine cell widths. Both axes: ${unit(x.unit)}. Values: ${unit(valueUnit)}. ${s.log ? "Log10 color mapping; zero PSD bins are light gray." : "Linear color mapping."} ${kind === "acf" ? "Diverging cobalt / neutral zero / amber; signed lags increase upward and right." : ""}`;
}
function cut(kind) {
  const c = canvas(kind + "-cuts");
  if (!c) return;
  const normalized = kind === "acf" && $("normalized").checked;
  const cuts = result[kind].cuts,
    divisor = normalized ? result.acf.zero_lag : 1;
  const values = [...cuts.x.values, ...cuts.y.values].map((v) => v / divisor),
    s = scale(values, kind === "psd" && $("log").checked);
  const coordinates = [...cuts.x.coordinates, ...cuts.y.coordinates],
    xmin = Math.min(...coordinates),
    xmax = Math.max(...coordinates),
    { ctx, left, top, pw, ph } = c;
  for (const [axis, color] of [
    ["x", "#365fd1"],
    ["y", "#b97a12"],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    cuts[axis].coordinates.forEach((x, i) => {
      const px = left + ((x - xmin) / (xmax - xmin || 1)) * pw,
        py = top + (1 - s.value(cuts[axis].values[i] / divisor)) * ph;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  const coordinateUnit =
      kind === "psd" ? result.sampling.frequency_unit : result.geometry.xy_unit,
    valueUnit = normalized ? "dimensionless" : result[kind].unit;
  axes(
    c,
    xmin,
    xmax,
    s.min,
    s.max,
    `${kind === "psd" ? "Frequency" : "Lag"} (${unit(coordinateUnit)})`,
    s.log ? "Value (log10)" : "Value",
  );
  $(kind + "-cut-legend").textContent =
    `Cobalt: X cut at Y = 0. Amber: Y cut at X = 0. Each point averages its recorded half-open cut bin (up to 2048 bins per axis); connecting lines guide the eye. Values: ${unit(valueUnit)}. ${s.log ? "Log10 display; zero values appear at the minimum positive display level." : "Linear display."}`;
}
function draw() {
  drawDomain();
  for (const kind of ["psd", "acf"]) {
    map(kind);
    cut(kind);
  }
  if (!result)
    for (const kind of ["psd", "acf"])
      $(kind + "-legend").textContent =
        "No current texture result. Capture and explicitly measure a processed surface.";
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
  if (result)
    download(
      new Blob([JSON.stringify(result, null, 2) + "\n"], {
        type: "application/json",
      }),
      "afm-texture.json",
    );
};
$("tar").onclick = async () => {
  if (!result || busy) return;
  busy = true;
  sync();
  status(
    "Recomputing the captured texture and verifying its report hash before export…",
  );
  try {
    const response = await request("/api/texture-export", {
      recipe: result.input_recipe,
      parameters: measuredParameters,
      report_sha256: result.report_sha256,
    });
    download(await response.blob(), "afm-texture.tar");
    status(
      "Full numerical archive downloaded; recomputed report hash matched.",
    );
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    sync();
  }
};
new ResizeObserver(draw).observe($("psd").parentElement);
sync();
warn();
draw();
