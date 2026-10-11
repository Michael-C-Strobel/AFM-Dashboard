# Optional model proposal adapter

`web/model-planner.js` exports `proposePlan({ endpoint, model, apiKey = '', prompt, sourceContext, history = [], signal, fetchImpl = fetch, timeoutMs = 60000 })`. It makes one explicit browser request and returns `{ proposal, audit }`. It never executes tools, retries, loads measurements, or changes application state. The caller must present a proposed plan for review separately from execution.

Provide the full Chat Completions endpoint, using HTTPS or HTTP on `localhost`, IPv4 loopback, or `::1`. URL credentials, query strings and fragments are rejected. Requests use POST, `credentials: 'omit'`, `redirect: 'error'`, `cache: 'no-store'`, and `referrerPolicy: 'no-referrer'`. An optional key is sent only as a Bearer header, never saved by this module. Browser CORS rules still apply. Provider compatibility and availability are not assumed; no live provider test is included.

## Transmitted context

`sourceContext` requires `file`, `source_sha256`, and `channel`. Optional fields are `title` (255 characters), `warnings` (up to 32 strings of 1,000 characters), `units: { xy_unit, z_unit }`, and `geometry: { shape, xreal, yreal, xoff, yoff, xy_unit, z_unit }`. Geometry is complete when supplied: shape is exactly two positive integers `[height, width]`, extents are positive finite numbers, offsets finite, and units strings or null. Supplied units must agree with geometry. Raster arrays, full instrument metadata and other keys are rejected. Titles and warnings are explicitly marked as untrusted data in the model instructions.

The prompt is limited to 8,000 characters. Optional history is capped at 12 strict `{ role, content }` messages, with roles `user` or `assistant`, 8,000 characters per message and 16,000 total. History follows the system instructions and precedes the current request. Callers should provide only prior user prompts and validated proposal text, never numerical result arrays, and reset history when the selected source/hash/channel changes. The request includes the actual typed tool catalog, plan constraints and curated context. It requests `response_format: { type: 'json_object' }`, `stream: false`, and `store: false`, following the [Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). JSON mode does **not** guarantee schema adherence; local schema validation remains mandatory, as described in the [structured outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat). `store: false` is a request option, not a claim about arbitrary providers' retention policies.

## Validation and audit

Accepted responses are `{ kind: 'plan', plan }` or `{ kind: 'clarification', question }`. Plans pass `validatePlan`, remain limited to 16 steps, and must bind every file, hash, channel and reference to the selected source. Artifact arguments must reference earlier steps through `$step:ID`; raw artifact IDs are rejected. Clarification questions are limited to 2,000 characters. Refusals, incomplete completions, malformed JSON, invalid plans and API-key reflection are rejected.

Response bytes are read incrementally and capped at 1 MiB. Timeout and external cancellation cover both fetch and body reads, including providers that ignore abort signals. Failed requests return `proposal: null` with a generic audit error; local configuration errors may throw a sanitized message before fetching. Audit status is `proposed`, `clarification`, `failed`, or `canceled`; it includes protocol, endpoint, model identifiers when available, timestamps, request-body SHA-256, the exact credential-free request body (including messages), curated context and validated proposal. A configured API key occurring anywhere in the request body, endpoint or model causes local rejection before fetching. Headers, API keys, raw provider responses and provider error text are excluded. For validated plans, `audit.proposal_plan_sha256` hashes the UTF-8 `JSON.stringify(proposal.plan)` text exactly as `runPlan` computes its manifest `plan_sha256`. The hashes match only if the reviewed draft remains unchanged; edits produce a different execution hash. Clarification and failed/canceled requests record null. Audit provenance records what was proposed; it does not certify scientific correctness.

```bash
node --test tests/model-planner.test.mjs
```

Tests inject fake fetch implementations only; no API key or network request is needed.

## Browser workflow

Start the supplied server with `AFM_MODEL_ORIGIN=https://your-provider.example npm run dev` (HTTP is permitted for localhost/127.0.0.1/::1). Its CSP permits that exact origin, and `GET /__afm_config.json` exposes the non-secret setting. With the variable unset, model requests are disabled. Other static hosts must configure their own CSP; the provider must support browser CORS.

In Assistant, refresh loaded sources, select a channel, expand **Ask for a plan**, and enter the full endpoint, model and optional key. Sending a message requests a proposal only. Follow-up messages include bounded prior user messages and validated model proposals; switching source identity resets conversation context. Review the proposed plan below, validate, and explicitly run it. Numerical results are never sent back to the provider by this version. Download the conversation audit separately from the tool journal; matching `proposal_plan_sha256` and run `plan_sha256` link an unchanged proposal to execution.

The UI retains at most 16 request audits, with the current conversation bounded to 12 messages/16,000 characters. Older complete exchanges may drop from model context; full request audits remain downloadable until reload. **New conversation** clears context without erasing audits; **Clear credential** clears the key field. Nothing is saved to localStorage.

`tests/browser-model.mjs` exercises clarification history, explicit execution, proposal/run identity, reflected-key rejection, cancellation and mobile layout using intercepted responses. Start a QA server with `PORT=4176 AFM_MODEL_ORIGIN=https://provider.example node scripts/serve.mjs`; use the existing Playwright environment variables documented for browser tests. No real model/provider has been contacted or certified.
