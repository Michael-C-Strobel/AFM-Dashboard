# Selected sources and evidence for model planning

G02c extends the optional proposal adapter. Numerical work and explicit plan approval stay local. This contract is implemented by `model-planner.js`, `model-evidence.js` and the Assistant panel; legacy single-source calls remain supported.

## Source selection

Retain the existing `sourceContext` API. Add mutually exclusive `sourceContexts`, an ordered array of 1–8 existing curated source/channel contexts. Validate each using the current strict schema before any await; reject duplicate file/hash/channel tuples, conflicting hashes for the same filename and inconsistent geometry/title/units for repeated identities. Never transmit raster data or unrestricted instrument metadata.

A proposed call must match one selected tuple across all identity fields it supplies; matching each field to a different selected source is invalid. Reference objects must match a complete selected tuple. Quality `reference_channel` must be selected on the call's same file/hash. Inspection may name only a selected file. Existing prior-step-only artifact restrictions remain: evidence included in a request does not authorize raw artifact IDs or tool execution. Tools still enforce source hashes during execution.

In the panel, the current inspected channel remains the default. An explicit **Add current channel** control builds a removable selection list of at most eight channels. Show filenames, channel titles/IDs, source hashes, support warnings and calibration before sending. No automatic selection of every loaded source. If an explicit list exists, it defines the entire transmitted selection. Changing selected identities or evidence clears conversation history; prior request audits remain available.

## Optional compact evidence

Evidence transmission is opt-in for each selected run/step set. The UI offers completed surface analysis/replay steps from its current verified report; choose up to four steps, yielding at most 32 claims. Non-surface reports remain local in this version. Clearing/replacing a run clears evidence selection.

The adapter receives an optional `evidenceBundle` with exactly `{manifest,journal,step_ids}`. These local verification inputs are never placed in the provider request. Snapshot them before asynchronous verification and call the existing `createEvidenceReport` to verify plan/journal/artifact consistency. Require 1–4 unique selected step IDs, each with verified surface claims. For every selected step, bind its recorded recipe's file/hash/channel and any recorded reference tuple to selected sources. Reject unknown steps, unselected sources, tampered bundles and missing claims; never silently substitute or drop evidence.

Project only `{schema_version:1,plan_sha256,journal_head_sha256,run_status,claims,warnings}`. Each claim contains the existing verified claim fields plus `file` and `claim_id`, where `claim_id` is `<plan_sha256>:<step_id>:<metric>`. Preserve finite values, units (including null for unknown), definitions and artifact IDs exactly. Include only warnings from the selected verified artifacts' result, quality and channel warning arrays, their import-support metadata and their unknown-unit warnings. These warnings must already be present in the verified report. Do not transmit unrelated steps' warnings or failure text; incomplete runs receive a generic notice. Do not infer calibration certification. Do not send Markdown reports, profiles, rasters, recipes, full artifacts, journals or unrelated results. Limit projected evidence to 64 KiB UTF-8 and the complete serialized provider request to 256 KiB; reject overflow rather than truncate provenance or warnings. Existing prompt/history/response limits remain.

## Evidence-linked responses

Alongside existing plan/clarification responses, accept exactly `{kind:"evidence",claim_ids:[...]}` with 1–32 unique IDs from the transmitted verified claim set. No arbitrary numeric values, free-form conclusions, raw HTML or invented citations are accepted in this response form. The UI renders the selected recorded values, units, definitions, source/channel, plan identity and links to the exact local artifacts. Label this as model-selected recorded evidence, not a new analysis or scientific interpretation. It does not alter the reviewed draft or execute tools.

System instructions describe all three response forms, selected tuple binding, untrusted titles/warnings/user text, and the limits of evidence: descriptive statistics are not confidence intervals, independent samples, calibrated uncertainty or defect identities. A request with no evidence cannot return an evidence response. Clarifications and plans retain their current behavior.

## Audit and concurrency

Keep single-source wire/audit behavior compatible. Multi-source requests record the exact curated selection and compact evidence sent, complete credential-free request body/hash and response. Proposal/run plan hashes keep their existing byte contracts. Evidence responses have a null proposal-plan hash and retain the referenced evidence in their request audit. API keys, headers and raw provider responses remain excluded.

Freeze the selected contexts, evidence choices and local bundle for the request; changes after dispatch cannot mutate its audit or response rendering. Session-only state, exact configured provider origin, cancellation, no automatic retry and explicit Run reviewed plan remain unchanged. No real provider request is needed for validation.

## Acceptance evidence

Use mock providers and synthetic measured sources. Cover legacy behavior; two-source plans and same-file two-channel comparisons; mixed tuple/unknown source/reference rejection; malformed/oversized contexts and request byte caps; verified evidence projection; tampered journals/artifacts; unknown steps/claims and unsent source rejection; exact values/units/artifact references; evidence response refusal without opt-in; immutable snapshots; secret reflection, abort and history bounds. Browser coverage must prove explicit source/evidence selection, payload inspection, no automatic execution, history reset, audit downloads, evidence links and mobile/keyboard access. Run the full numerical suite and existing model tests after integration.
