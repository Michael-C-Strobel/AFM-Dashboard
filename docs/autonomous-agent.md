# Autonomous analysis

In **Assistant**, configure the shared connection under **Ask for a plan**, refresh/inspect sources and select the permitted channels. Open **Autonomous analysis**, describe the goal and scientific constraints, choose maximum provider rounds (1–8) and local tool calls (1–64), then **Start goal**. This authorizes automatic execution within those bounds. Reviewed plans remain available separately.

Each round obtains a typed, source-bound plan, checks its hash and scope, executes it sequentially and verifies the resulting artifacts against the tool journal. The next request includes up to four verified surface-result steps (32 compact claims), enabling another plan or an evidence selection. Raw rasters, full recipes, artifacts and journals are not transmitted. Local exports retain the full records. `list_sources` is disallowed; references must be selected sources and artifact references must point to earlier steps in the same plan. A later round can recreate a recipe but cannot directly reuse an earlier round's artifact ID.

**Pause** waits after a running local tool; **Resume** continues. **Stop** aborts an active provider request and prevents subsequent local calls. A running local numerical operation finishes and remains recorded. Provider request provenance is retained when stopped; a response that arrives while paused is audited before waiting. Download goal audit before starting another goal or reloading: it contains the selected goal, bounds, request audits, per-round manifests, verified reports and session tool journal. No credentials are exported. Each new goal has its own bounds; the underlying session also has its existing 256-call/32 MiB artifact limits.

Terminal states distinguish `evidence_returned`, `needs_input`, `budget_exhausted`, `failed` and `stopped`. Evidence returned means the model selected verified claims; it does not independently establish scientific goal achievement. A clarification ends the current goal; start a new goal with the missing choices. Failures stop automatically rather than retrying indefinitely. Budget exhaustion retains partial artifacts and never means success.

## Pilot SOPs

Select a [versioned pilot SOP](workflow-sops.md), read its instructions and supply required choices and deviations. Its exact instructions, ID/version, user choices and goal are captured together in the audit. Additional deviations must appear in plan rationales. SOPs guide the model; they are not a separate formal conformance checker. Reference reconstruction requires explicit reviewed fit points. No universal leveling rule or scientific acceptance threshold is inferred.

## Current boundaries and checks

Adaptive numerical feedback currently contains verified surface statistics only. Quality, segmentation, texture and sensitivity artifacts are retained locally, but their detailed results are not yet model observations. The controller permits those tools within plans; it cannot yet autonomously interpret their complete outputs. Claims retain warnings and units; they are descriptive measurements, not confidence intervals or calibration certificates.

Tests use real synthetic local tool sessions and mocked providers: adaptive plans, scope/hash gates, budgets, pause/stop races, retained cancellation audits and secret reflection. Browser regression exercises the shared settings, two automatic plans then evidence, budget exhaustion, stop, SOP capture, audit download and mobile layout. No live provider or scientific autonomous-result quality has been certified.
