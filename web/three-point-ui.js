/** Explicit physical-point editing; numerical execution belongs to the caller. */
import {
  createThreePointDraft,
  samplingFootprint,
} from "./three-point-draft.js";
export function mountThreePointEditor({
  host,
  onChange,
  onStart,
  preview,
  apply,
}) {
  const doc = host.ownerDocument;
  const el = (tag, text) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const panel = el("details");
  panel.id = "three-point-editor";
  panel.append(el("summary", "Three-point leveling"));
  host.append(panel);
  const startButton = el("button", "Start three-point draft");
  startButton.id = "three-point-start";
  startButton.type = "button";
  panel.append(startButton);
  const explanation = el(
    "p",
    "Choose three noncollinear physical points. Draft markers do not change the analysis. Sampling footprints include excluded pixels; the analysis engine validates usable samples.",
  );
  explanation.className = "hint";
  panel.append(explanation);
  const units = el("p");
  units.id = "level-units";
  units.className = "hint";
  panel.append(units);
  const selectorLabel = el("label", "Point to place or move"),
    selector = el("select");
  selector.id = "level-point";
  for (let i = 0; i < 3; i++) {
    const option = el("option", "Point " + (i + 1));
    option.value = String(i);
    selector.append(option);
  }
  selectorLabel.append(selector);
  panel.append(selectorLabel);
  const grid = el("div");
  grid.className = "level-coordinate-grid";
  panel.append(grid);
  const coordinates = Array.from({ length: 3 }, (_, i) =>
    ["x", "y"].map((axis) => {
      const label = el("label", `Point ${i + 1} ${axis.toUpperCase()}`),
        input = el("input");
      input.type = "number";
      input.step = "any";
      input.id = `level-${axis}-${i}`;
      label.append(input);
      grid.append(label);
      return input;
    }),
  );
  const radiusLabel = el("label", "Sampling radius (pixels, 1–20)"),
    radius = el("input");
  radius.id = "level-radius";
  radius.type = "number";
  radius.min = 1;
  radius.max = 20;
  radius.step = 1;
  radius.value = 1;
  radiusLabel.append(radius);
  panel.append(radiusLabel);
  const actions = el("div");
  actions.className = "level-actions";
  panel.append(actions);
  const button = (id, text) => {
    const node = el("button", text);
    node.id = id;
    node.type = "button";
    actions.append(node);
    return node;
  };
  const updateButton = button("level-update", "Update coordinates"),
    previewButton = button("level-preview", "Preview plane"),
    applyButton = button("level-apply", "Apply previewed plane"),
    resetButton = button("level-reset", "Reset draft"),
    cancelButton = button("level-cancel", "Cancel draft");
  const status = el(
    "p",
    "No three-point draft. Start a draft to place points.",
  );
  status.id = "level-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.append(status);
  let draft = createThreePointDraft(),
    active = false,
    current = null,
    recorded = null,
    selected = 0,
    previewed = false,
    token = 0,
    busy = null,
    uncommitted = false;
  const copy = (v) => (v === null ? null : structuredClone(v));
  function displayState() {
    if (active) return draft.snapshot();
    if (recorded) {
      const display = createThreePointDraft();
      display.restore(recorded.operation, recorded.context);
      return display.snapshot();
    }
    return { context: current, points: [null, null, null], radius: 1 };
  }
  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }
  function controls() {
    const locked = busy === "apply";
    startButton.disabled = !!busy || !current;
    selector.disabled = !active || locked;
    radius.disabled = !active || locked;
    for (const pair of coordinates)
      for (const input of pair) {
        input.readOnly = !active;
        input.disabled = locked;
      }
    updateButton.disabled = !active || locked;
    previewButton.disabled = !active || !!busy || uncommitted;
    applyButton.disabled = !active || !!busy || !previewed || uncommitted;
    resetButton.disabled = !active || locked;
    cancelButton.disabled = !active || locked;
  }
  function render() {
    const state = displayState();
    state.points.forEach((point, i) =>
      coordinates[i].forEach((input, j) => {
        input.value = point === null ? "" : String(point[j]);
      }),
    );
    radius.value = String(state.radius);
    selector.value = String(selected);
    units.textContent =
      "Physical coordinates: " +
      (state.context?.geometry.xy_unit || "unit unknown") +
      ". Recorded markers use the geometry before their operation.";
    controls();
  }
  function invalidate() {
    token++;
    previewed = false;
    busy = null;
    controls();
    onChange();
  }
  function cancel() {
    active = false;
    draft = createThreePointDraft();
    uncommitted = false;
    invalidate();
    render();
    message(
      recorded
        ? "Recorded three-point operation shown read-only."
        : "Draft canceled; no operation applied.",
    );
  }
  function start(context) {
    draft = createThreePointDraft();
    draft.reset(context);
    current = copy(context);
    active = true;
    selected = 0;
    uncommitted = false;
    panel.open = true;
    invalidate();
    render();
    message(
      "Draft: place three points or enter all coordinates, then preview.",
    );
  }
  function setPoint(index, physical) {
    if (!active || busy === "apply") return false;
    try {
      draft.setPoint(index, physical);
      selected = index;
      uncommitted = false;
      invalidate();
      render();
      message(
        `Draft point ${index + 1} updated. Preview again before applying.`,
      );
      return true;
    } catch (error) {
      message(error.message, true);
      return false;
    }
  }
  function sync(context, lastRecorded = null) {
    const next = copy(context);
    const changed =
      active &&
      JSON.stringify(draft.snapshot().context) !== JSON.stringify(next);
    current = next;
    recorded =
      lastRecorded &&
      next &&
      lastRecorded.context?.source_key === next.source_key
        ? copy(lastRecorded)
        : null;
    // A recorded operation may use an earlier pipeline geometry. The caller's
    // current source key is its authority; never infer matching file identities.
    if (
      lastRecorded &&
      next &&
      lastRecorded.context?.source_key === next.source_key
    ) {
      const check = createThreePointDraft();
      check.restore(lastRecorded.operation, lastRecorded.context);
    }
    if (changed) {
      cancel();
      message("Analysis context changed. Draft and preview discarded.");
    } else if (!active) {
      render();
      message(
        recorded
          ? "Recorded three-point operation shown read-only."
          : "No three-point draft. Start a draft to place points.",
      );
    } else controls();
  }
  startButton.onclick = () => onStart();
  selector.onchange = () => {
    selected = Number(selector.value);
    invalidate();
    message("Point selected. Preview again before applying.");
  };
  for (const pair of coordinates)
    for (const input of pair)
      input.oninput = () => {
        if (!active) return;
        uncommitted = true;
        invalidate();
        message(
          "Coordinate edits are pending. Update coordinates before preview.",
        );
      };
  radius.oninput = () => {
    if (!active) return;
    uncommitted = true;
    invalidate();
    message("Radius edit is pending. Update coordinates before preview.");
  };
  updateButton.onclick = () => {
    if (!active) return;
    try {
      const candidate = createThreePointDraft();
      candidate.reset(draft.snapshot().context);
      coordinates.forEach((pair, i) => {
        if (pair.some((input) => !input.value.trim()))
          throw new Error("Enter both coordinates for all three points.");
        candidate.setPoint(
          i,
          pair.map((input) => Number(input.value)),
        );
      });
      candidate.setRadius(Number(radius.value));
      draft = candidate;
      uncommitted = false;
      invalidate();
      render();
      message("Draft coordinates updated. Preview before applying.");
    } catch (error) {
      message(error.message, true);
    }
  };
  resetButton.onclick = () => {
    if (active) start(draft.snapshot().context);
  };
  cancelButton.onclick = cancel;
  previewButton.onclick = async () => {
    if (!active || busy || uncommitted) return;
    let operation;
    try {
      operation = draft.operation();
    } catch (error) {
      message(error.message, true);
      return;
    }
    const request = ++token;
    previewed = false;
    busy = "preview";
    controls();
    message("Calculating draft preview…");
    try {
      await preview(copy(operation));
      if (request !== token || !active) return;
      previewed = true;
      message("Preview ready. Apply commits this exact draft operation.");
    } catch (error) {
      if (request === token) message("Preview failed: " + error.message, true);
    } finally {
      if (request === token) {
        busy = null;
        controls();
      }
    }
  };
  applyButton.onclick = async () => {
    if (!active || busy || !previewed || uncommitted) return;
    const request = token;
    busy = "apply";
    controls();
    message("Applying previewed operation…");
    try {
      await apply(copy(draft.operation()));
      if (request === token && active) {
        active = false;
        draft = createThreePointDraft();
        previewed = false;
        uncommitted = false;
        token++;
        busy = null;
        onChange();
        render();
        message("Three-point operation applied.");
      }
    } catch (error) {
      if (request === token) message("Apply failed: " + error.message, true);
    } finally {
      if (request === token) {
        busy = null;
        controls();
      }
    }
  };
  const projected = (project, p) => {
    const result = project(p);
    return Array.isArray(result) ? result : [result.x, result.y];
  };
  function hitTest(project, x, y) {
    if (!active) return null;
    let best = null,
      distance = 12;
    draft.snapshot().points.forEach((point, i) => {
      if (point === null) return;
      const [px, py] = projected(project, point),
        d = Math.hypot(px - x, py - y);
      if (d <= distance) {
        distance = d;
        best = i;
      }
    });
    return best;
  }
  function draw(ctx, project) {
    const state = displayState();
    if (!state.context) return;
    ctx.save();
    try {
      for (let i = 0; i < 3; i++) {
        const point = state.points[i];
        if (point === null) continue;
        ctx.fillStyle = "rgba(229,164,71,0.2)";
        ctx.strokeStyle = "#e5a447";
        ctx.lineWidth = 1;
        for (const { bounds } of samplingFootprint(
          point,
          state.radius,
          state.context.geometry,
        )) {
          const [x0, y0] = projected(project, bounds.slice(0, 2)),
            [x1, y1] = projected(project, bounds.slice(2));
          ctx.fillRect(
            Math.min(x0, x1),
            Math.min(y0, y1),
            Math.abs(x1 - x0),
            Math.abs(y1 - y0),
          );
          ctx.strokeRect(
            Math.min(x0, x1),
            Math.min(y0, y1),
            Math.abs(x1 - x0),
            Math.abs(y1 - y0),
          );
        }
        const [x, y] = projected(project, point);
        ctx.beginPath();
        ctx.arc(x, y, active && i === selected ? 11 : 9, 0, Math.PI * 2);
        ctx.fillStyle = "#142336";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#e5a447";
        ctx.stroke();
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
        ctx.fillText(String(i + 1), x, y);
      }
    } finally {
      ctx.restore();
    }
  }
  render();
  return {
    start,
    cancel,
    sync,
    setPoint,
    hitTest,
    draw,
    isActive: () => active,
    selectedIndex: () => selected,
    snapshot: () => ({ active, ...draft.snapshot(), previewed }),
  };
}
