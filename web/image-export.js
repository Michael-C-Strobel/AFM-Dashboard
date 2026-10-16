/** Export a detached copy of a displayed map; never change scientific data. */
export async function createMapPNG(
  source,
  { title, subtitle, low, high, colors },
) {
  const width = source.clientWidth,
    height = source.clientHeight,
    ratio = source.width / width;
  if (!(width > 0 && height > 0 && Number.isFinite(ratio) && ratio > 0))
    throw new Error("The map is not visible. Open the surface viewer first.");
  const figure = document.createElement("canvas"),
    padding = 16,
    top = 64;
  figure.width = Math.round((width + padding * 2) * ratio);
  figure.height = Math.round((height + top + 72) * ratio);
  const ctx = figure.getContext("2d");
  if (!ctx) throw new Error("Image export is unavailable in this browser.");
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, figure.width / ratio, figure.height / ratio);
  function line(value, x, y, available) {
    let text = String(value);
    if (ctx.measureText(text).width > available) {
      while (text.length && ctx.measureText(text + "…").width > available)
        text = text.slice(0, -1);
      text += "…";
    }
    ctx.fillText(text, x, y);
  }
  ctx.fillStyle = "#214b42";
  ctx.font = "600 16px system-ui";
  line(title, padding, 26, width);
  ctx.font = "11px system-ui";
  line(subtitle, padding, 46, width);

  // Canvas pixels omit the CSS background. Retain the viewer's checkerboard
  // so missing pixels are visibly distinct from measured palette colors.
  ctx.save();
  ctx.beginPath();
  ctx.rect(padding, top, width, height);
  ctx.clip();
  for (let y = 0; y < height; y += 6)
    for (let x = 0; x < width; x += 6) {
      ctx.fillStyle = (x / 6 + y / 6) % 2 ? "#e8ebef" : "#dbe0e7";
      ctx.fillRect(padding + x, top + y, 6, 6);
    }
  ctx.drawImage(source, padding, top, width, height);
  ctx.restore();

  const barY = top + height + 16,
    gradient = ctx.createLinearGradient(padding, 0, padding + width, 0);
  colors.forEach((color, index) =>
    gradient.addColorStop(
      index / (colors.length - 1),
      `rgb(${color.join(",")})`,
    ),
  );
  ctx.fillStyle = gradient;
  ctx.fillRect(padding, barY, width, 10);
  ctx.fillStyle = "#214b42";
  ctx.font = "11px system-ui";
  line(low, padding, barY + 28, width / 2 - 8);
  ctx.textAlign = "right";
  line(high, padding + width, barY + 28, width / 2 - 8);
  return new Promise((resolve, reject) =>
    figure.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The browser could not encode the PNG image.")),
      "image/png",
    ),
  );
}
