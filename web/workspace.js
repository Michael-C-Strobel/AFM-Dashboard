// Workspace navigation is display-only; scientific state stays in app.js.
const tabs = [...document.querySelectorAll(".inspection-tabs [role=tab]")];
function activate(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute("aria-controls")).hidden =
      !selected;
  }
  if (focus) tab.focus();
}
for (const tab of tabs) {
  tab.addEventListener("click", () => activate(tab));
  tab.addEventListener("keydown", (event) => {
    let index = tabs.indexOf(tab);
    if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else return;
    event.preventDefault();
    activate(tabs[index], true);
  });
}
const toggle = document.getElementById("toggle-inspector");
toggle.addEventListener("click", () => {
  const expanded = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(expanded));
  document.body.classList.toggle("inspector-open", expanded);
});

// Move the existing controls into a native modal: no copied scientific state.
const inspection = document.querySelector(".inspection-dock");
const expand = document.getElementById("expand-inspection");
const dialog = document.getElementById("inspection-dialog");
const anchor = document.createComment("Inspection dock position");
inspection.before(anchor);
let panelScroll = [];
function rememberScroll() {
  panelScroll = [...inspection.querySelectorAll('[role="tabpanel"]')].map(
    (panel) => [panel, panel.scrollTop, panel.scrollLeft],
  );
}
function restoreScroll() {
  for (const [panel, top, left] of panelScroll) {
    panel.scrollTop = top;
    panel.scrollLeft = left;
  }
}
expand.addEventListener("click", () => {
  if (dialog.open) {
    rememberScroll();
    dialog.close();
    return;
  }
  rememberScroll();
  dialog.append(inspection);
  expand.textContent = "Return to viewer";
  expand.setAttribute("aria-expanded", "true");
  document.body.classList.add("inspection-expanded");
  dialog.showModal();
  inspection
    .querySelector('[role="tab"][aria-selected="true"]')
    .focus({ preventScroll: true });
  restoreScroll();
});
dialog.addEventListener("cancel", rememberScroll);
dialog.addEventListener("close", () => {
  anchor.after(inspection);
  expand.textContent = "Expand inspection";
  expand.setAttribute("aria-expanded", "false");
  document.body.classList.remove("inspection-expanded");
  restoreScroll();
  expand.focus({ preventScroll: true });
});

// Documentation deep links reveal the containing panel without changing analysis.
function revealDocumentationTarget() {
  let id;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  const panel = target.closest('[role="tabpanel"]');
  const tab = panel
    ? document.getElementById(panel.getAttribute("aria-labelledby"))
    : target.matches('[role="tab"]')
      ? target
      : null;
  if (tab && tabs.includes(tab)) activate(tab);
  for (let node = target.parentElement; node; node = node.parentElement)
    if (node.tagName === "DETAILS") node.open = true;
  const inspector = target.closest("#data-inspector");
  if (inspector && getComputedStyle(inspector).display === "none")
    toggle.click();
  target.scrollIntoView({ block: "center" });
  target.focus({ preventScroll: true });
}
window.addEventListener("hashchange", revealDocumentationTarget);
window.addEventListener("DOMContentLoaded", revealDocumentationTarget, {
  once: true,
});
if (document.readyState !== "loading") revealDocumentationTarget();
