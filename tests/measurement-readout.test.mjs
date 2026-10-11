import test from "node:test";
import assert from "node:assert/strict";
import {
  histogramIndex,
  nearestProfileIndex,
  createHistogramReadout,
  createProfileReadout,
  mountMeasurementReadout,
} from "../web/measurement-readout.js";
const format = (n, u) => `${n} ${u ?? "(unit unknown)"}`;
test("histogram selection clamps both plot edges and selects exact bins including zeros", () => {
  for (const [x, expected] of [
    [-1, 0],
    [0, 0],
    [0.2499, 0],
    [0.25, 1],
    [0.5, 2],
    [0.999, 3],
    [1, 3],
    [2, 3],
  ])
    assert.equal(histogramIndex(x, 4), expected);
  assert.equal(histogramIndex(0.5, 0), null);
  assert.equal(histogramIndex(NaN, 3), null);
  const model = createHistogramReadout(
    { edges: [0, 1, 2, 3], counts: [4, 0, 7] },
    null,
  );
  assert.deepEqual(model.sample(1), {
    index: 1,
    lower: 1,
    upper: 2,
    count: 0,
    upper_inclusive: false,
    unit: null,
  });
  assert.match(model.text(model.sample(1), format), /0 pixels/);
  assert.match(model.text(model.sample(1), format), /unit unknown/);
  assert.equal(model.sample(2).upper_inclusive, true);
  assert.match(
    model.text(model.sample(2), format),
    /final upper edge included/,
  );
  const constant = createHistogramReadout({ edges: [2, 2], counts: [10] }, "m");
  assert.equal(constant.indexAt(1), 0);
  assert.equal(constant.sample(0).lower, constant.sample(0).upper);
});
test("profile lookup chooses nearest recorded distance with lower-index midpoint ties", () => {
  const d = [0, 1, 4, 10];
  assert.equal(nearestProfileIndex(d, -5), 0);
  assert.equal(nearestProfileIndex(d, 99), 3);
  assert.equal(nearestProfileIndex(d, 2.5), 1);
  assert.equal(nearestProfileIndex(d, 2.6), 2);
  assert.equal(nearestProfileIndex(d, 4), 2);
  assert.equal(nearestProfileIndex([], 2), null);
  assert.equal(nearestProfileIndex([3], 9), 0);
  assert.equal(nearestProfileIndex([0, 0, 1], 0), 0);
});
test("profile samples preserve recorded heights and captured endpoint fraction without new interpolation", () => {
  const p = {
      distance: [0, 1, 4],
      height: [2e-9, null, 7e-9],
      xy_unit: "m",
      z_unit: "m",
    },
    points = [
      [10, 20],
      [16, 32],
    ],
    model = createProfileReadout(p, points);
  assert.deepEqual(model.sample(1), {
    index: 1,
    distance: 1,
    height: null,
    x: 13,
    y: 26,
    xy_unit: "m",
    z_unit: "m",
  });
  assert.equal(model.indexAt(0.5), 1);
  assert.match(
    model.text(model.sample(1), format),
    /unavailable \(excluded or missing\)/,
  );
  assert.match(
    model.text(model.sample(0), format),
    /Interpolated profile sample/,
  );
  p.height[0] = 99;
  p.distance[1] = 100;
  points[0][0] = 999;
  assert.equal(model.sample(0).height, 2e-9);
  assert.equal(model.sample(1).distance, 1);
  assert.equal(model.sample(1).x, 13);
});
test("empty single and entirely missing profiles do not fabricate heights or coordinates", () => {
  const empty = createProfileReadout({ distance: [], height: [] }, null);
  assert.equal(empty.count, 0);
  assert.equal(empty.indexAt(0.5), null);
  const one = createProfileReadout(
    { distance: [0], height: [NaN], xy_unit: null, z_unit: null },
    [
      [2, 3],
      [5, 9],
    ],
  );
  assert.equal(one.position(0), 0);
  assert.equal(one.sample(0).height, null);
  assert.equal(one.sample(0).x, 2);
  assert.match(one.text(one.sample(0), format), /unit unknown/);
  const unknown = createProfileReadout(
    { distance: [0, 1], height: [null, null] },
    null,
  );
  assert.equal(unknown.sample(1).x, null);
  assert.match(unknown.text(unknown.sample(1), format), /Source X unavailable/);
  assert.throws(
    () => createProfileReadout({ distance: [2, 1], height: [1, 2] }, null),
    /sorted/,
  );
});
function fakeDOM() {
  class Node {
    constructor() {
      this.attributes = {};
      this.listeners = {};
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.classList = { add() {} };
      this.ownerDocument = doc;
      this.captured = null;
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    }
    getAttribute(k) {
      return this.attributes[k] ?? null;
    }
    append(n) {
      this.children.push(n);
    }
    addEventListener(k, fn) {
      this.listeners[k] = fn;
    }
    focus() {
      this.focused = true;
    }
    setPointerCapture(id) {
      this.captured = id;
    }
    hasPointerCapture(id) {
      return this.captured === id;
    }
    releasePointerCapture() {
      this.captured = null;
    }
    getScreenCTM() {
      return {
        inverse: () => ({
          map: (p) => ({ x: (p.x - 100) / 2, y: (p.y - 50) / 2 }),
        }),
      };
    }
    createSVGPoint() {
      return {
        x: 0,
        y: 0,
        matrixTransform(m) {
          return m.map(this);
        },
      };
    }
  }
  const doc = {
    createElement: () => new Node(),
    createElementNS: () => new Node(),
  };
  return { svg: new Node(), target: new Node() };
}
test("mounted readout uses inverse screen CTM, captured drag and keyboard without live pointer flooding", () => {
  const { svg, target } = fakeDOM(),
    model = createHistogramReadout(
      { edges: [0, 1, 2, 3, 4], counts: [1, 0, 4, 2] },
      "m",
    );
  mountMeasurementReadout({
    svg,
    target,
    id: "histogram-readout",
    model,
    plot: { x: 55, y: 15, width: 420, height: 150 },
    format,
  });
  const output = target.children[0],
    marker = svg.children[0];
  assert.equal(marker.getAttribute("visibility"), "hidden");
  assert.equal(svg.getAttribute("role"), "group");
  assert.equal(svg.getAttribute("aria-describedby"), "histogram-readout");
  assert.equal(output.dataset.index, "0");
  const event = {
    pointerId: 1,
    button: 0,
    clientX: 100 + 2 * (55 + 420 * 0.5),
    clientY: 50 + 2 * 80,
    preventDefault() {},
  };
  svg.listeners.pointerdown(event);
  assert.equal(output.dataset.index, "2");
  assert.equal(svg.captured, 1);
  assert.equal(marker.getAttribute("visibility"), "visible");
  assert.equal(output.getAttribute("aria-live"), "off");
  svg.listeners.pointermove({ ...event, clientX: 100 + 2 * 1000 });
  assert.equal(output.dataset.index, "3");
  svg.listeners.pointerup({ ...event, type: "pointerup" });
  assert.equal(svg.captured, null);
  svg.listeners.pointerleave();
  assert.equal(marker.getAttribute("visibility"), "hidden");
  svg.listeners.keydown({ key: "Home", preventDefault() {} });
  assert.equal(output.dataset.index, "0");
  assert.equal(output.getAttribute("aria-live"), "polite");
  assert.equal(marker.getAttribute("visibility"), "visible");
  svg.listeners.blur();
  assert.equal(marker.getAttribute("visibility"), "hidden");
  svg.listeners.keydown({ key: "ArrowRight", preventDefault() {} });
  assert.equal(output.dataset.index, "1");
  assert.match(output.textContent, /0 pixels/);
  svg.listeners.keydown({ key: "End", preventDefault() {} });
  assert.equal(output.dataset.index, "3");
  svg.listeners.pointermove(event);
  assert.equal(output.getAttribute("aria-live"), "off");
});
