/** Reviewed inclusive-threshold connected regions; no material identification. */
import { geometry, normalizeSelection, validMask } from "./engine.js";
const MAX_PIXELS = 4194304,
  MAX_COMPONENTS = 65536;

function parameters(options) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw new Error("Segmentation options must be a plain object.");
  const allowed = [
    "threshold",
    "direction",
    "connectivity",
    "min_pixels",
    "boundary",
    "selection",
  ];
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.includes(key))
      throw new Error("Unknown segmentation option.");
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Segmentation options must contain plain values.");
  }
  if (
    !Object.hasOwn(options, "threshold") ||
    !Number.isFinite(options.threshold)
  )
    throw new Error("An explicit finite threshold is required.");
  const p = {
    threshold: options.threshold,
    direction: Object.hasOwn(options, "direction")
      ? options.direction
      : "above",
    connectivity: Object.hasOwn(options, "connectivity")
      ? options.connectivity
      : 4,
    min_pixels: Object.hasOwn(options, "min_pixels") ? options.min_pixels : 1,
    boundary: Object.hasOwn(options, "boundary") ? options.boundary : "include",
    selection: normalizeSelection(options.selection ?? {}),
  };
  if (
    !["above", "below"].includes(p.direction) ||
    ![4, 8].includes(p.connectivity) ||
    !Number.isSafeInteger(p.min_pixels) ||
    p.min_pixels < 1 ||
    p.min_pixels > MAX_PIXELS ||
    !["include", "exclude"].includes(p.boundary)
  )
    throw new Error(
      "Invalid segmentation direction, connectivity, minimum size or boundary policy.",
    );
  return p;
}

export function segmentSurface(channel, options) {
  const p = parameters(options),
    { width, height } = channel,
    size = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error("Segmentation requires positive integer image dimensions.");
  if (size > MAX_PIXELS)
    throw new Error("Segmentation limit is 4194304 pixels.");
  if (
    !(channel.data instanceof Float64Array) ||
    channel.data.length !== size ||
    (channel.mask != null && channel.mask.length !== size)
  )
    throw new Error(
      "Segmentation channel arrays must match the image dimensions.",
    );
  if (
    !["xreal", "yreal", "xoff", "yoff"].every((k) =>
      Number.isFinite(channel[k]),
    ) ||
    channel.xreal <= 0 ||
    channel.yreal <= 0
  )
    throw new Error("Segmentation requires valid physical calibration.");
  for (const name of ["xy_unit", "z_unit"])
    if (channel[name] !== null && typeof channel[name] !== "string")
      throw new Error("Segmentation units must be declared strings or null.");
  const valid = validMask(channel, p.selection),
    foreground = new Uint8Array(size),
    labels = new Uint32Array(size),
    queue = new Uint32Array(size);
  let validCount = 0,
    thresholdCount = 0,
    acceptedPixels = 0,
    candidates = 0;
  for (let i = 0; i < size; i++)
    if (valid[i]) {
      validCount++;
      if (
        p.direction === "above"
          ? channel.data[i] >= p.threshold
          : channel.data[i] <= p.threshold
      ) {
        foreground[i] = 1;
        thresholdCount++;
      }
    }
  if (!validCount)
    throw new Error("Segmentation selection contains no valid pixels.");
  const dx = channel.xreal / width,
    dy = channel.yreal / height,
    pixelArea = dx * dy,
    regions = [],
    excluded = [];
  if (!(dx > 0 && dy > 0 && pixelArea > 0 && Number.isFinite(pixelArea)))
    throw new RangeError(
      "Segmentation pixel pitches exceed finite numeric range.",
    );
  const neighbors =
    p.connectivity === 4
      ? [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]
      : [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ];
  for (let seed = 0; seed < size; seed++) {
    if (!foreground[seed]) continue;
    if (++candidates > MAX_COMPONENTS)
      throw new Error("Segmentation limit is 65536 candidate components.");
    let head = 0,
      tail = 1,
      n = 0,
      sumX = 0,
      sumY = 0,
      min = Infinity,
      max = -Infinity,
      mean = 0,
      meanCorrection = 0,
      x0 = width,
      y0 = height,
      x1 = 0,
      y1 = 0,
      imageBoundary = false,
      selectionBoundary = false;
    queue[0] = seed;
    foreground[seed] = 0;
    while (head < tail) {
      const index = queue[head++],
        x = index % width,
        y = Math.floor(index / width),
        value = channel.data[index];
      labels[index] = candidates;
      n++;
      sumX += x + 0.5;
      sumY += y + 0.5;
      const delta = value - mean;
      if (Number.isFinite(delta)) {
        const increment = delta / n - meanCorrection;
        const updated = mean + increment;
        meanCorrection = updated - mean - increment;
        mean = updated;
      } else {
        mean = mean * ((n - 1) / n) + value / n;
        meanCorrection = 0;
      }
      min = Math.min(min, value);
      max = Math.max(max, value);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1)
        imageBoundary = true;
      if (
        (x > 0 && !valid[index - 1]) ||
        (x + 1 < width && !valid[index + 1]) ||
        (y > 0 && !valid[index - width]) ||
        (y + 1 < height && !valid[index + width])
      )
        selectionBoundary = true;
      for (const [ox, oy] of neighbors) {
        const nx = x + ox,
          ny = y + oy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (foreground[next]) {
          foreground[next] = 0;
          queue[tail++] = next;
        }
      }
    }
    const reasons = [];
    if (n < p.min_pixels) reasons.push("min_pixels");
    if (p.boundary === "exclude") {
      if (imageBoundary) reasons.push("image_boundary");
      if (selectionBoundary) reasons.push("selection_boundary");
    }
    const region = {
      id: candidates,
      pixel_count: n,
      area: n * pixelArea,
      area_unit: channel.xy_unit == null ? null : `(${channel.xy_unit})²`,
      bbox_pixel: [x0, y0, x1, y1],
      bbox: [
        channel.xoff + x0 * dx,
        channel.yoff + y0 * dy,
        channel.xoff + x1 * dx,
        channel.yoff + y1 * dy,
      ],
      width: (x1 - x0) * dx,
      height: (y1 - y0) * dy,
      centroid: [
        channel.xoff + (sumX / n) * dx,
        channel.yoff + (sumY / n) * dy,
      ],
      min,
      max,
      mean,
      excursion_height:
        p.direction === "above" ? max - p.threshold : p.threshold - min,
      touches_image_boundary: imageBoundary,
      touches_selection_boundary: selectionBoundary,
      excluded_reasons: reasons,
    };
    if (
      ![
        region.area,
        region.width,
        region.height,
        ...region.bbox,
        ...region.centroid,
        region.min,
        region.max,
        region.mean,
        region.excursion_height,
      ].every(Number.isFinite)
    )
      throw new RangeError(
        "Segmentation derived metrics exceed finite numeric range.",
      );
    if (reasons.length) {
      excluded.push(region);
      for (let i = 0; i < tail; i++) labels[queue[i]] = 0;
    } else {
      regions.push(region);
      acceptedPixels += n;
    }
  }
  const warnings = [
    ...(channel.warnings ?? []),
    "Threshold segmentation is descriptive and requires a reviewed threshold; regions are not material or defect identities, nor independent samples.",
    "Areas, bounds and boundary contacts use a pixel approximation; no subpixel contour or perimeter is estimated.",
  ];
  if (channel.xy_unit == null || channel.z_unit == null)
    warnings.push(
      "Unknown units: geometric and value metrics retain stored calibration without assuming metres or physical height.",
    );
  if (channel.xy_unit != null && channel.xy_unit !== "m")
    warnings.push(
      "Lateral units are not metres; areas and coordinates use the stored lateral unit.",
    );
  if (channel.z_unit != null && channel.z_unit !== "m")
    warnings.push(
      "Vertical units are not metres; excursion_height is a threshold-relative value difference, not an inferred topographic height.",
    );
  return {
    schema_version: 1,
    algorithm: "threshold_components_v1",
    parameters: p,
    geometry: geometry(channel),
    counts: {
      valid: validCount,
      invalid: size - validCount,
      threshold_pixels: thresholdCount,
      accepted_pixels: acceptedPixels,
      candidate_regions: candidates,
      accepted_regions: regions.length,
      excluded_regions: excluded.length,
    },
    regions,
    excluded_regions: excluded,
    warnings,
    labels,
  };
}
