/** Optional exact provider origin; an unset value keeps the demo local-only. */
export function modelOrigin(value = "") {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "AFM_MODEL_ORIGIN must be an HTTPS or loopback HTTP origin.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "AFM_MODEL_ORIGIN must contain only an HTTPS or loopback HTTP origin, without credentials, path, query or fragment.",
    );
  return url.origin;
}
export function modelOrigins(value = "") {
  if (typeof value !== "string")
    throw new Error(
      "AFM_MODEL_ORIGINS must be a comma-separated list of exact origins.",
    );
  if (!value.trim()) return [];
  return [
    ...new Set(
      value.split(",").map((entry) => {
        if (!entry.trim())
          throw new Error("AFM_MODEL_ORIGINS contains an empty origin.");
        return modelOrigin(entry.trim());
      }),
    ),
  ];
}
export function contentSecurityPolicy(origin = null) {
  const origins = Array.isArray(origin)
    ? origin.map((entry) => {
        if (typeof entry !== "string" || !entry.trim())
          throw new Error(
            "Provider origins must be nonempty exact origin strings.",
          );
        return modelOrigin(entry);
      })
    : origin === null || origin === ""
      ? []
      : [modelOrigin(origin)];
  const unique = [...new Set(origins)];
  const allowed = unique.length ? " " + unique.join(" ") : "";
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'" +
    allowed +
    "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
}
