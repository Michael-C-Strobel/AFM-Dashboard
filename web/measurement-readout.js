/** Read recorded plot samples without modifying or recomputing scientific results. */
export function histogramIndex(normalizedX, count) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    typeof normalizedX !== "number" ||
    Number.isNaN(normalizedX)
  )
    return null;
  return Math.min(count - 1, Math.max(0, Math.floor(normalizedX * count)));
}
export function nearestProfileIndex(distances, distance) {
  if (!distances.length || !Number.isFinite(distance)) return null;
  let lo = 0,
    hi = distances.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (distances[mid] < distance) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  if (lo === distances.length) return lo - 1;
  return distance - distances[lo - 1] <= distances[lo] - distance ? lo - 1 : lo;
}
const coordinate = (v, unit) => `${v} ${unit || "(unit unknown)"}`;
export function createHistogramReadout(histogram, unit) {
  const counts = Array.from(histogram?.counts ?? []),
    edges = Array.from(histogram?.edges ?? []),
    count = counts.length;
  if (edges.length !== count + 1 && count)
    throw new Error("Histogram edges must bracket recorded bins.");
  return {
    count,
    indexAt: (x) => histogramIndex(x, count),
    position: (i) => (i + 0.5) / count,
    binWidth: count ? 1 / count : 0,
    sample: (i) =>
      i >= 0 && i < count
        ? {
            index: i,
            lower: edges[i],
            upper: edges[i + 1],
            count: counts[i],
            upper_inclusive: i === count - 1,
            unit,
          }
        : null,
    text(sample, format) {
      return `Bin ${sample.index + 1}/${count}: [${format(sample.lower, unit)}, ${format(sample.upper, unit)}${sample.upper_inclusive ? "]" : ")"} · ${sample.count} pixels${sample.upper_inclusive ? " · final upper edge included" : " · upper edge excluded"}`;
    },
    exact: (sample) =>
      `[${coordinate(sample.lower, unit)}, ${coordinate(sample.upper, unit)}${sample.upper_inclusive ? "]" : ")"}; count=${sample.count}`,
  };
}
export function createProfileReadout(profile, endpoints) {
  const distances = Array.from(profile?.distance ?? []),
    heights = Array.from(profile?.height ?? []),
    xyUnit = profile?.xy_unit ?? null,
    zUnit = profile?.z_unit ?? null,
    points = endpoints == null ? null : structuredClone(endpoints),
    count = distances.length;
  if (
    heights.length !== count ||
    distances.some(
      (v, i) => !Number.isFinite(v) || (i > 0 && v < distances[i - 1]),
    )
  )
    throw new Error(
      "Expected sorted recorded profile distances and matching heights.",
    );
  const validPoints =
    Array.isArray(points) &&
    points.length === 2 &&
    points.every(
      (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
    );
  const min = distances[0] ?? 0,
    max = distances.at(-1) ?? 0;
  return {
    count,
    indexAt: (x) =>
      nearestProfileIndex(
        distances,
        min + Math.max(0, Math.min(1, x)) * (max - min),
      ),
    position: (i) => (max === min ? 0 : (distances[i] - min) / (max - min)),
    sample: (i) => {
      if (i < 0 || i >= count) return null;
      const t = count === 1 ? 0 : i / (count - 1);
      return {
        index: i,
        distance: distances[i],
        height: Number.isFinite(heights[i]) ? heights[i] : null,
        x: validPoints ? points[0][0] * (1 - t) + points[1][0] * t : null,
        y: validPoints ? points[0][1] * (1 - t) + points[1][1] * t : null,
        xy_unit: xyUnit,
        z_unit: zUnit,
      };
    },
    text(s, format) {
      return `Interpolated profile sample ${s.index + 1}/${count} · Distance ${format(s.distance, xyUnit)} · Height ${s.height === null ? "unavailable (excluded or missing)" : format(s.height, zUnit)} · Source X ${s.x === null ? "unavailable" : format(s.x, xyUnit)} · Y ${s.y === null ? "unavailable" : format(s.y, xyUnit)}`;
    },
    exact: (s) =>
      `distance=${coordinate(s.distance, xyUnit)}; height=${s.height === null ? "unavailable" : coordinate(s.height, zUnit)}; x=${s.x === null ? "unavailable" : coordinate(s.x, xyUnit)}; y=${s.y === null ? "unavailable" : coordinate(s.y, xyUnit)}`,
  };
}
export function mountMeasurementReadout({
  svg,
  target,
  id,
  model,
  plot,
  format,
  yAt = null,
}) {
  if (!model.count) return null;
  const doc = svg.ownerDocument,
    ns = "http://www.w3.org/2000/svg",
    output = doc.createElement("div");
  output.id = id;
  output.className = "measurement-readout";
  output.setAttribute("aria-live", "off");
  svg.setAttribute("tabindex", "0");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-describedby", id);
  svg.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Home End");
  svg.setAttribute(
    "aria-label",
    (svg.getAttribute("aria-label") || "Measurement plot") +
      ". Hover or drag to inspect recorded data. Use Left/Right arrows, Home or End when focused.",
  );
  svg.classList.add("measurement-plot");
  svg.style.touchAction = "none";
  const marker = doc.createElementNS(ns, model.binWidth ? "rect" : "line");
  marker.setAttribute("class", "measurement-cursor");
  marker.setAttribute("pointer-events", "none");
  marker.setAttribute("aria-hidden", "true");
  if (model.binWidth) {
    marker.setAttribute("y", plot.y);
    marker.setAttribute("height", plot.height);
    marker.setAttribute("width", plot.width * model.binWidth);
    marker.setAttribute("fill", "#397e7e");
    marker.setAttribute("fill-opacity", ".18");
    marker.setAttribute("stroke", "#245f62");
  } else {
    marker.setAttribute("y1", plot.y);
    marker.setAttribute("y2", plot.y + plot.height);
    marker.setAttribute("stroke", "#b04f25");
    marker.setAttribute("stroke-dasharray", "3 3");
  }
  svg.append(marker);
  let dot = null;
  if (yAt) {
    dot = doc.createElementNS(ns, "circle");
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", "#b04f25");
    dot.setAttribute("pointer-events", "none");
    dot.setAttribute("aria-hidden", "true");
    svg.append(dot);
  }
  target.append(output);
  const hint = doc.createElement("p");
  hint.className = "measurement-readout-help";
  hint.textContent =
    "Recorded analysis · move or drag across the plot. Keyboard: ←/→, Home/End. Recalculate after changing selections.";
  target.append(hint);
  let index = 0,
    drag = null,
    hovered = false,
    keyboardActive = false;
  function syncMarker() {
    if (model.binWidth)
      marker.setAttribute(
        "visibility",
        hovered || drag !== null || keyboardActive ? "visible" : "hidden",
      );
  }
  function show(next, keyboard = false) {
    if (next === null) return;
    keyboardActive = keyboard;
    syncMarker();
    index = Math.max(0, Math.min(model.count - 1, next));
    const sample = model.sample(index),
      x = plot.x + plot.width * model.position(index);
    output.setAttribute("aria-live", keyboard ? "polite" : "off");
    output.textContent = model.text(sample, format);
    output.title = model.exact(sample);
    output.dataset.index = String(index);
    svg.dataset.readoutIndex = String(index);
    if (model.binWidth)
      marker.setAttribute("x", x - (plot.width * model.binWidth) / 2);
    else {
      marker.setAttribute("x1", x);
      marker.setAttribute("x2", x);
    }
    if (dot) {
      const y = yAt(index);
      dot.setAttribute("visibility", Number.isFinite(y) ? "visible" : "hidden");
      if (Number.isFinite(y)) {
        dot.setAttribute("cx", x);
        dot.setAttribute("cy", y);
      }
    }
  }
  function pointer(event) {
    if (drag !== null && event.pointerId !== drag) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(ctm.inverse());
    hovered =
      local.x >= plot.x &&
      local.x <= plot.x + plot.width &&
      local.y >= plot.y &&
      local.y <= plot.y + plot.height;
    show(model.indexAt((local.x - plot.x) / plot.width));
  }
  svg.addEventListener("pointermove", pointer);
  svg.addEventListener("pointerleave", () => {
    hovered = false;
    syncMarker();
  });
  svg.addEventListener("blur", () => {
    keyboardActive = false;
    syncMarker();
  });
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = event.pointerId;
    svg.setPointerCapture(event.pointerId);
    svg.focus({ preventScroll: true });
    event.preventDefault();
    pointer(event);
  });
  const end = (event) => {
    if (drag !== event.pointerId) return;
    if (event.type === "pointerup") pointer(event);
    if (svg.hasPointerCapture(event.pointerId))
      svg.releasePointerCapture(event.pointerId);
    drag = null;
    if (event.type === "pointercancel") hovered = false;
    syncMarker();
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("lostpointercapture", () => {
    drag = null;
    syncMarker();
  });
  svg.addEventListener("keydown", (event) => {
    const next = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: model.count - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    show(next, true);
  });
  show(0);
  return { show, index: () => index };
}
