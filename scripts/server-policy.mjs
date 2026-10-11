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
export function contentSecurityPolicy(origin = null) {
  const allowed = origin === null ? "" : " " + modelOrigin(origin);
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'" +
    allowed +
    "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
}
