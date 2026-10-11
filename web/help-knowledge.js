/** Curated interface knowledge only. No DOM, measurement, network or model access. */
export const helpTopics = Object.freeze(
  [
    {
      id: "three-point-leveling",
      title: "Level a surface using three chosen points",
      target: "three-point-start",
      text: "1. Import a supported image channel, choose the intended processing and selection, and recalculate. In Data & processing, open Three-point leveling and Start three-point draft.\n2. Click three noncollinear points on a map. Drag a numbered marker to move it, or select a point to replace it. Coordinates use the stored lateral unit; enter exact X/Y values and choose a sampling radius, then Update coordinates. Footprints show the sampled disk, including excluded pixels; only usable selected samples contribute.\n3. Preview plane to inspect a temporary leveled map. Measurements still describe the committed recipe; saving/capturing the analysis is disabled while the draft preview is shown. Invalid points or unusable samples must be corrected before applying.\n4. Apply previewed plane records only three-point leveling. Set minimum to zero remains a separate operation. Cancel draft discards the preview and leaves the committed analysis unchanged.\n5. Save and strictly replay the recipe. Recorded points reappear read-only; starting a new draft or changing source cannot silently reuse old points. Choosing representative points is a scientific decision, not an automatic leveling rule.",
    },
    {
      id: "roughness-workflow",
      title: "How do I measure surface roughness?",
      target: "tab-measurements",
      text: "1. Import a height channel and check units, calibration/support warnings and masks.\n2. Measure the original full surface or an explicitly chosen ROI as a baseline. Record valid/excluded counts and area.\n3. Choose and justify leveling for the sample and question; there is no universal correct preset. Apply the recorded operations and recalculate on the same selection.\n4. Compare Sa/Sq, range, counts and processing against the baseline. Sa is mean absolute deviation and Sq is RMS deviation from the selected mean. Processing and selection can change both.\n5. Review acquisition diagnostics without treating candidate boundaries as proven defects. Save the recipe, export analysis and strictly replay it on the same source bytes. For a structured starting point, read the height-roughness pilot SOP below.",
    },
    {
      id: "help-agent",
      title: "Ask the help agent",
      target: "tab-assistant",
      text: "In Assistant, configure the shared provider settings, then open Help agent and ask an interface or workflow question. No measurement needs to be loaded. The model receives curated guide topics, pilot SOPs, your question and bounded conversation history. It has no tools and cannot inspect or alter measurements. Follow its documentation citations or Show control buttons; citations do not guarantee every model statement is correct. Cancel help aborts a request; Download help audit retains the conversation without credentials.",
    },
    {
      id: "autonomous",
      title: "Run a bounded autonomous analysis",
      target: "tab-assistant",
      text: "In Assistant, configure the provider above, inspect/select source channels, open Autonomous analysis, enter a goal and set round/tool limits. Start goal authorizes automatic plans and local execution. Subsequent rounds receive separate verified surface claims and compact quality, segmentation, texture and sensitivity observations from the latest eligible run context; quality-only feedback can guide another plan. Up to 16 observation steps fit a 64 KiB projection; the whole provider request is capped at 256 KiB. Recorded units, relevant warnings and failed sensitivity alternatives remain visible; bulk rasters, profiles, region tables and recipes stay local. Source/reference and earlier-recipe binding still apply. Pause/Stop wait for a running local tool; Resume continues a paused run. A clarification requires a new goal with the missing choices. Evidence returned selects recorded surface claims; observations_returned selects known observation IDs. Neither independently certifies scientific goal achievement, calibration or defect identity. Download goal audit retains rounds, manifests and journal. Reviewed planning remains separate and sends surface evidence only after explicit selection.",
    },
    {
      id: "providers",
      title: "Connect a model provider",
      target: "tab-assistant",
      text: "Open Ask for a plan to access shared connection settings. Choose OpenAI, Google Gemini compatibility, Groq compatibility, or Custom Chat Completions endpoint, then supply the exact model ID and your session-only API key. Custom accepts a full HTTPS or loopback HTTP completion URL. Native Anthropic Messages is not this protocol. The host must allow the provider origin with AFM_MODEL_ORIGIN; browser CORS and JSON-object support are required. No real provider has been certified. Clear credential erases the key field; credentials are not saved in persistent browser storage. Help and analysis share these settings but maintain separate conversations and audits.",
    },
    {
      id: "workflow-sops",
      title: "Use a versioned pilot SOP",
      target: "tab-assistant",
      text: "In Autonomous analysis, optionally select height-roughness or chemist-reference SOP version 0.1.0. Read prerequisites, procedure, quality checks, outputs and limitations before starting. Supply required scientific choices and explicit deviations. Optionally record Expected SOP settings as JSON before starting, including exact processing, selection and a justification. The exact SOP guidance, ID/version and your choices enter the recorded goal; additional deviations belong in step rationales. After the run, Check SOP records verifies baseline, processing, diagnostic and replay evidence without executing tools. Missing settings or artifacts remain incomplete. Download goal audit includes the checks; records_complete still requires scientific and approval review. These are pilot workflows, not universal scientific validation. Reference reconstruction requires supplied fit points and both source identities; a model must ask when required choices are missing.",
    },
    {
      id: "import-support",
      title: "Import files and check support",
      target: "import-trigger",
      text: "Choose Import local files, then select a source file and channel. Supported image subsets are native GWYP, NanoScope binary images, Igor IBW v5 and JPK TIFF images. Read Import support and channel warnings: readable unverified configurations are warned, while unsupported encodings are rejected. File extension alone does not establish compatibility.",
    },
    {
      id: "units-calibration",
      title: "Read units and calibration",
      target: "metadata",
      text: "Open channel metadata to inspect dimensions, physical spans, offsets and stored XY/Z units. Values retain their stored units; unknown units remain unknown. Non-height signals must not be interpreted as height. Matching unit strings or successful import does not certify instrument calibration. Exact selection coordinates use the source channel base units.",
    },
    {
      id: "processing",
      title: "Process a copy and preserve raw data",
      target: "operation",
      text: "Select an Operation and Add operation & apply. Review the ordered History; Undo removes the last operation and Reset pipeline starts again from original data. Robust plane + zero minimum is a starting point requiring review. Processing preserves original measurements. Replay chemist points is restricted to its identified source/channel, not a general leveling preset.",
    },
    {
      id: "selection",
      title: "Select a measurement region",
      target: "coordinate-roi",
      text: "Choose Rectangle ROI or Exclude polygon in Selection tool, or open Enter exact selection coordinates in Measurements for a keyboard alternative. Finish polygon closes a drawn exclusion. Recalculate after selection edits. Clear selections removes the global selection and profile. Imported masks and nonfinite samples remain excluded; changing selection changes the measured population.",
    },
    {
      id: "profiles-plateaus",
      title: "How do I measure the height of a feature?",
      target: "coordinate-profile",
      text: "1. Import the measurement and select a height channel. Check XY/Z units and support warnings; height is relative to a chosen reference surface, not necessarily the image minimum.\n2. Review and record appropriate leveling before measuring. Preserve the original and do not smooth merely to improve the result.\n3. In Measurements, choose Line profile to cross the feature and surrounding surface, or enter exact profile coordinates and Set profile. Recalculate to inspect the shape and choose representative plateau regions.\n4. Draw a rectangle on the reference surface and Use current ROI as plateau A. Draw another on the feature and assign plateau B. Avoid boundary pixels unless they are intentionally part of the question.\n5. Recalculate. Step height is mean(B) minus mean(A), in the stored Z unit. A negative result means B is lower than A. Plateau regions are independent of the global ROI; masks and exclusions still apply. Check each plateau's valid count and spread.\n6. Save the recipe and analysis export with the selections and processing. Pixel spreads are descriptive, not confidence intervals. A curved feature may require a different explicitly justified height definition; this tool measures a difference between two regional means.",
    },
    {
      id: "quality",
      title: "Check acquisition quality",
      target: "tab-acquisition",
      text: "Open Acquisition quality and run Check acquisition on the original channel with the current selection. Review row/column boundary candidates and warnings; these are diagnostic flags, not proven defects or automatic repairs. A reference channel is explicit and unaligned. Download the separate quality report to retain parameters and provenance.",
    },
    {
      id: "batch",
      title: "Apply a reviewed recipe to multiple files",
      target: "tab-batch",
      text: "In Batch, capture a completed current recipe, Refresh file list after importing files, select inputs and Check selected inputs before Start batch. Reference-bearing templates are rejected. Each compatible input receives a new recipe; this is not replay of the template source. Failures remain visible and later files continue. Cancel finishes the current file. Download the manifest and verified per-file exports before reloading.",
    },
    {
      id: "segmentation",
      title: "Measure threshold regions",
      target: "tab-features",
      text: "In Features, Capture processed analysis, set a threshold in the stored Z unit and review direction, connectivity, minimum pixels and boundary rules before running. Inspect accepted and excluded regions, calibrated areas and the independent label preview. Captures remain detached from later viewer edits. Regions are descriptive components, not material identities or independent samples.",
    },
    {
      id: "texture",
      title: "How do I run texture analysis?",
      target: "tab-texture",
      text: "1. Select a calibrated height channel, review import warnings and record any leveling. Define the physical question before removing long-wavelength structure.\n2. Choose a complete rectangular analysis region. Texture currently requires no internal missing or excluded pixels; do not fill missing values just to pass this check. Recalculate the processed surface.\n3. Open Texture and capture the completed processed analysis. The capture remains fixed when the main viewer later changes.\n4. Choose explicit detrending (none, mean or plane) and window (boxcar or Hann), then measure. These choices affect the spectrum and must accompany any comparison.\n5. Inspect calibrated spatial-frequency axes, PSD cuts and linear autocorrelation. A spectral peak describes a spatial scale; it does not identify a material or prove a mechanism. Zero-energy normalized ACF is unavailable. Zero padding adds frequency samples, not physical resolution.\n6. Export the verified report and TAR for full numerical arrays and replay provenance. Plot log colors and display normalization do not change the evidence. Keep source bytes and recorded settings with the results.",
    },
    {
      id: "registration",
      title: "Register two captured surfaces",
      target: "tab-registration",
      text: "In Registration, capture fixed and moving completed analyses separately, changing the main viewer between captures as needed. Manual translation maps moving coordinates into fixed coordinates; inspect units and interpolation. Automatic integer search requires compatible pitches and explicit search limits. Review overlap, ties and boundary warnings. Missing overlap is not filled. Neither capture nor the main viewer is changed; translation does not establish physical deformation.",
    },
    {
      id: "sensitivity",
      title: "Review processing and selection alternatives",
      target: "tab-sensitivity",
      text: "In Sensitivity, capture a baseline, add current processing/selection or a baseline-plus-mean/plane alternative, and review the full JSON definitions and assumptions before Run reviewed alternatives. Source/channel must match; baseline profile, plateaus and reference stay fixed. Inspect every outcome, valid counts and range membership. Alternative spread is not independent-replicate uncertainty; calibration uncertainty remains not evaluated.",
    },
    {
      id: "recipes-export",
      title: "Save, load and verify recipes",
      target: "download-portable",
      text: "Save recipe downloads the legacy recipe; Save portable recipe strictly verifies the captured analysis and adds canonical checksums that survive object-key reordering. Load recipe accepts either format up to 1 MiB and strictly checks source/calibration/output identities. Dirty or pending analyses cannot be saved as portable recipes. Export analysis TAR retains processed results and provenance, not original source bytes. Keep exact input files and matching application code for replay; hashes are not signatures.",
    },
    {
      id: "assistant",
      title: "Review Assistant plans before execution",
      target: "tab-assistant",
      text: "In Assistant, Refresh loaded sources, choose a local starter, inspect the exact plan, Validate plan and explicitly Run reviewed plan. Starter plans operate on selected source channels independently of the viewer pipeline. Verify evidence report to inspect attributed recorded claims. Optional model planning sends only selected context and explicitly opted-in verified evidence; proposals never run automatically. Model-selected evidence is recorded output, not a new analysis or scientific interpretation. Download session audits before reloading.",
    },
    {
      id: "navigation",
      title: "Navigate inspection panels",
      target: "expand-inspection",
      text: "Move or drag across Height distribution for bin bounds/counts or Line profile for nearest recorded distance/height and source X/Y. Focus plots and use Left/Right, Home/End for keyboard inspection; readouts describe the last completed analysis and do not change it. Recalculate sits in the inspection toolbar beside the measurement panels and stays available when expanded. Use the inspection tabs; Left/Right arrows move between tabs and Home/End select the first/last. Expand inspection opens the current controls in a native modal; Escape or Return to viewer closes it. On a narrow screen, Data & processing reveals source and pipeline controls. Navigation and display colors do not change measurements.",
    },
    {
      id: "limitations",
      title: "Understand interpretation and session limits",
      target: null,
      text: "This image viewer does not support force spectroscopy or every vendor encoding. Review support warnings and unknown units before interpretation. Sa/Sq, plateau spread, threshold regions, quality candidates, texture, registration and processing sensitivity are descriptive under their recorded assumptions, not calibration certificates or automatic scientific conclusions. Browser session imports, plans and results are memory-only; save evidence before reload. Full screen-reader usability and live-provider behavior are not certified by automated checks.",
    },
  ].map((topic) => Object.freeze(topic)),
);

const tabTopics = Object.freeze({
  "tab-measurements": ["units-calibration", "selection", "profiles-plateaus"],
  "tab-acquisition": ["quality"],
  "tab-batch": ["batch"],
  "tab-assistant": ["assistant"],
  "tab-features": ["segmentation"],
  "tab-texture": ["texture"],
  "tab-registration": ["registration"],
  "tab-sensitivity": ["sensitivity"],
});

/** tab is an exact known DOM tab ID; unrecognized input contributes no context. */
export function helpContext(options = {}) {
  const descriptor =
    options && typeof options === "object"
      ? Object.getOwnPropertyDescriptor(options, "tab")
      : null;
  const candidate =
    descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
  const tab =
    typeof candidate === "string" && Object.hasOwn(tabTopics, candidate)
      ? candidate
      : null;
  const preferred = tab ? tabTopics[tab] : [];
  const topics = [
    ...helpTopics.filter((topic) => preferred.includes(topic.id)),
    ...helpTopics.filter((topic) => !preferred.includes(topic.id)),
  ];
  return { schema_version: 1, tab, topics: structuredClone(topics) };
}

/** Return only named curated topics, in requested order, without shared references. */
export function resolveHelpTopics(ids) {
  if (
    !Array.isArray(ids) ||
    Object.getPrototypeOf(ids) !== Array.prototype ||
    ids.length < 1 ||
    ids.length > 8 ||
    Reflect.ownKeys(ids).length !== ids.length + 1
  )
    throw new Error("Choose 1–8 unique known help topic IDs.");
  const seen = new Set(),
    result = [];
  for (let i = 0; i < ids.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(ids, String(i));
    const id =
      descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable
        ? descriptor.value
        : null;
    const topic =
      typeof id === "string" ? helpTopics.find((item) => item.id === id) : null;
    if (!topic || seen.has(id))
      throw new Error("Choose 1–8 unique known help topic IDs.");
    seen.add(id);
    result.push({ ...topic });
  }
  return result;
}

/** User-facing guide structure shared with the help agent. */
export const helpSections = Object.freeze(
  [
    {
      id: "general",
      title: "General",
      description:
        "Open measurements, understand units and support, navigate the workspace, and save reproducible results.",
      topic_ids: [
        "import-support",
        "units-calibration",
        "processing",
        "selection",
        "recipes-export",
        "navigation",
        "limitations",
      ],
    },
    {
      id: "agents",
      title: "Agents and automation",
      description:
        "Choose between reviewed plans, bounded autonomous execution and tool-free interface help. Configure provider access and retain audits.",
      topic_ids: ["providers", "assistant", "autonomous", "help-agent"],
    },
    {
      id: "workflows",
      title: "Common workflows",
      description:
        "Follow practical procedures for feature height, roughness, texture and other frequent AFM tasks. Versioned pilot SOPs appear at the end.",
      topic_ids: [
        "profiles-plateaus",
        "roughness-workflow",
        "three-point-leveling",
        "texture",
        "quality",
        "segmentation",
        "registration",
        "sensitivity",
        "batch",
        "workflow-sops",
      ],
    },
  ].map((section) =>
    Object.freeze({ ...section, topic_ids: Object.freeze(section.topic_ids) }),
  ),
);
