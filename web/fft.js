/** Separable radix-2 DFT: forward exp(-2πi·), inverse exp(+2πi·)/N. */
const MAX_PIXELS = 4194304;
function powerOfTwo(n) {
  return (
    Number.isSafeInteger(n) && n > 0 && n <= MAX_PIXELS && (n & (n - 1)) === 0
  );
}
function roots(length, inverse) {
  const real = new Float64Array(length / 2),
    imag = new Float64Array(length / 2),
    sign = inverse ? 1 : -1;
  for (let i = 0; i < real.length; i++) {
    const angle = (2 * Math.PI * i) / length;
    real[i] = Math.cos(angle);
    imag[i] = sign * Math.sin(angle);
  }
  return { real, imag };
}
function transform(real, imag, start, length, twiddle) {
  for (let i = 1, j = 0; i < length; i++) {
    let bit = length >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const a = start + i,
        b = start + j,
        r = real[a],
        v = imag[a];
      real[a] = real[b];
      imag[a] = imag[b];
      real[b] = r;
      imag[b] = v;
    }
  }
  for (let span = 2; span <= length; span *= 2) {
    const half = span / 2,
      step = length / span;
    for (let block = 0; block < length; block += span) {
      for (let k = 0; k < half; k++) {
        const a = start + block + k,
          b = a + half,
          t = k * step,
          wr = twiddle.real[t],
          wi = twiddle.imag[t];
        const vr = real[b] * wr - imag[b] * wi,
          vi = real[b] * wi + imag[b] * wr,
          ur = real[a],
          ui = imag[a];
        real[a] = ur + vr;
        imag[a] = ui + vi;
        real[b] = ur - vr;
        imag[b] = ui - vi;
      }
    }
  }
}

export function fft2D(real, width, height, options = {}) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw new TypeError("FFT options must be a plain object.");
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !["imag", "inverse"].includes(key))
      throw new TypeError("Unknown FFT option.");
    const d = Object.getOwnPropertyDescriptor(options, key);
    if (!d.enumerable || !Object.hasOwn(d, "value"))
      throw new TypeError(
        "FFT options cannot contain accessors or hidden fields.",
      );
  }
  const imag = Object.hasOwn(options, "imag") ? options.imag : null,
    inverse = Object.hasOwn(options, "inverse") ? options.inverse : false;
  if (typeof inverse !== "boolean")
    throw new TypeError("FFT inverse option must be boolean.");
  if (!powerOfTwo(width) || !powerOfTwo(height))
    throw new RangeError("FFT dimensions must be positive powers of two.");
  const size = width * height;
  if (size > MAX_PIXELS) throw new RangeError("FFT limit is 4194304 samples.");
  if (
    !(real instanceof Float64Array) ||
    real.length !== size ||
    (imag !== null && (!(imag instanceof Float64Array) || imag.length !== size))
  )
    throw new TypeError(
      "FFT requires Float64Array inputs matching width × height.",
    );
  for (let i = 0; i < size; i++)
    if (
      !Number.isFinite(real[i]) ||
      (imag !== null && !Number.isFinite(imag[i]))
    )
      throw new RangeError("FFT inputs must be finite.");
  const outputReal = real.slice(),
    outputImag = imag === null ? new Float64Array(size) : imag.slice();
  if (width > 1) {
    const twiddle = roots(width, inverse);
    for (let y = 0; y < height; y++)
      transform(outputReal, outputImag, y * width, width, twiddle);
  }
  if (height > 1) {
    const twiddle = roots(height, inverse),
      columnReal = new Float64Array(height),
      columnImag = new Float64Array(height);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const index = y * width + x;
        columnReal[y] = outputReal[index];
        columnImag[y] = outputImag[index];
      }
      transform(columnReal, columnImag, 0, height, twiddle);
      for (let y = 0; y < height; y++) {
        const index = y * width + x;
        outputReal[index] = columnReal[y];
        outputImag[index] = columnImag[y];
      }
    }
  }
  for (let i = 0; i < size; i++) {
    if (!Number.isFinite(outputReal[i]) || !Number.isFinite(outputImag[i]))
      throw new RangeError("FFT arithmetic exceeds finite numeric range.");
    if (inverse) {
      outputReal[i] /= size;
      outputImag[i] /= size;
    }
  }
  return { real: outputReal, imag: outputImag, width, height };
}
