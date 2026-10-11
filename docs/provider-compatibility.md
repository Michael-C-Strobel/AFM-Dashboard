# Model provider presets

Presets supply documented Chat Completions endpoints, not live-provider certification. Official documentation was checked on 2026-10-11; tests exercise local validation without credentials or provider requests. Enter an explicit model ID available to your account. No default model is selected.

## Documented endpoints

| Preset ID | Full POST endpoint                                                         | Authentication and JSON evidence                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`  | `https://api.openai.com/v1/chat/completions`                               | Bearer API key; `response_format: {type: "json_object"}` is documented. See the [official OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).                                                                                                                   |
| `gemini`  | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | Bearer Gemini API key. Google's [OpenAI compatibility documentation](https://ai.google.dev/gemini-api/docs/openai) documents this endpoint and structured JSON output through `response_format`. The inspected page does not explicitly document the literal `json_object` option; acceptance of this dashboard's exact payload remains unverified. |
| `groq`    | `https://api.groq.com/openai/v1/chat/completions`                          | Bearer Groq API key. See [OpenAI compatibility](https://console.groq.com/docs/openai), the [API reference](https://console.groq.com/docs/api-reference), and [JSON Object Mode](https://console.groq.com/docs/structured-outputs#json-object-mode).                                                                                                 |
| `custom`  | Enter the full compatible endpoint URL                                     | The existing adapter uses optional Bearer authentication. The service must implement the same request/response protocol.                                                                                                                                                                                                                            |

## Local contract

`web/provider-presets.js` exports the deeply frozen `providerPresets` array and `resolveProvider(id, {endpoint, model})`. The resolver returns a fresh `{endpoint, model}` object. Model IDs are trimmed, nonempty, and bounded to 200 characters. Named presets reject changed endpoints; choose Custom to supply another URL. Custom URLs require HTTPS, or HTTP on localhost/IPv4 loopback/IPv6 loopback, without embedded credentials, query strings, or fragments. Unknown fields and accessor properties are rejected. This module never accepts, stores, or sends an API key.

## Browser and protocol limits

The browser must be permitted by both the dashboard host's connection policy and the provider's CORS policy, including the authorization/content-type preflight. A preset does not configure either policy. A successful server-side SDK example does not establish browser compatibility.

The current proposal adapter sends non-streaming Chat Completions JSON with `response_format: {type: "json_object"}`, `store: false`, messages, and the chosen model. A provider/model must accept that exact combination. JSON mode alone does not guarantee the required proposal schema. Local validation still requires a complete, non-refused response containing a bound plan, clarification, or selected verified evidence IDs; it rejects malformed output and never executes a proposal automatically. Model availability, quotas, CORS, and provider-specific handling remain untested here.

Anthropic's native [Messages API](https://platform.claude.com/docs/en/api/messages/create) uses a different request/response contract. It is not a preset and cannot be used as a native Messages URL with this adapter; a separate adapter is outside this implementation.

Run `node --test tests/provider-presets.test.mjs` for endpoint, immutability, model, and malformed-input checks.
