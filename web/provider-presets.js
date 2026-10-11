/** Documented Chat Completions addresses, not live-provider certification. */
export const providerPresets = Object.freeze([
  Object.freeze({
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    modelHint:
      "Enter an OpenAI model ID that supports Chat Completions JSON mode.",
  }),
  Object.freeze({
    id: "gemini",
    label: "Google Gemini (OpenAI compatibility)",
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    modelHint:
      "Enter a Gemini model ID supported by the OpenAI compatibility endpoint.",
  }),
  Object.freeze({
    id: "groq",
    label: "Groq (OpenAI compatibility)",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    modelHint: "Enter a Groq-hosted model ID that supports JSON object mode.",
  }),
  Object.freeze({
    id: "custom",
    label: "Custom Chat Completions endpoint",
    endpoint: "",
    modelHint: "Enter the exact model ID served by your compatible endpoint.",
  }),
]);
function invalid(message) {
  throw new Error(message);
}
export function resolveProvider(id, options = {}) {
  const preset = providerPresets.find((p) => p.id === id);
  if (!preset) invalid("Unknown provider preset.");
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    invalid("Provider options must be a plain object.");
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      !["endpoint", "model"].includes(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      invalid("Provider options allow only endpoint and model values.");
  }
  const { endpoint = "", model = "" } = options;
  if (
    typeof model !== "string" ||
    /[\x00-\x1f\x7f]/.test(model) ||
    !model.trim() ||
    [...model.trim()].length > 200
  )
    invalid("Enter a nonempty model ID of at most 200 characters.");
  if (
    typeof endpoint !== "string" ||
    /[\x00-\x1f\x7f]/.test(endpoint) ||
    [...endpoint.trim()].length > 2048
  )
    invalid("Invalid provider endpoint.");
  const address = endpoint.trim();
  if (preset.id !== "custom") {
    if (address && address !== preset.endpoint)
      invalid("Preset endpoints cannot be overridden; choose Custom.");
    return { endpoint: preset.endpoint, model: model.trim() };
  }
  if (!/^https?:\/\//i.test(address) || /[\\?#]/.test(address))
    invalid(
      "Enter a full HTTPS or loopback HTTP endpoint without query or fragment.",
    );
  let url;
  try {
    url = new URL(address);
  } catch {
    invalid("Invalid provider endpoint URL.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/.test(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    invalid(
      "Endpoint requires HTTPS or loopback HTTP and must not contain credentials.",
    );
  return { endpoint: url.href, model: model.trim() };
}
