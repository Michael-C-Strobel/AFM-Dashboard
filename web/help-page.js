import { workflowSops, sopPrompt } from "./workflow-sops.js";
import { helpTopics, helpSections } from "./help-knowledge.js";
const el = (tag, text) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};
const photos = {
  "import-support": {
    src: "help-import.png",
    alt: "AFM Workbench with a generated synthetic surface imported and source/channel controls visible.",
    caption:
      "Basic import and channel selection. This is a generated training surface, not an experimental measurement.",
  },
  "profiles-plateaus": {
    src: "help-measurements.png",
    alt: "Measurements controls showing where to define regions and profiles for relative feature-height measurements.",
    caption:
      "Finding the basic measurement controls. The displayed surface is synthetic; this screenshot illustrates navigation, not a validated feature-height result.",
  },
};
for (const group of helpSections) {
  const section = el("section");
  section.id = group.id;
  const topLink = el("a", group.title);
  topLink.href = "#" + group.id;
  document.getElementById("help-topics").append(topLink);
  section.append(el("h2", group.title), el("p", group.description));
  const contents = el("ul");
  contents.setAttribute("aria-label", group.title + " topics");
  section.append(contents);
  for (const id of group.topic_ids) {
    const topic = helpTopics.find((t) => t.id === id),
      li = el("li"),
      jump = el("a", topic.title);
    jump.href = "#" + id;
    li.append(jump);
    contents.append(li);
    const article = el("article");
    article.id = id;
    article.append(el("h3", topic.title));
    if (/^1\. /.test(topic.text)) {
      const list = el("ol");
      for (const step of topic.text.split("\n"))
        list.append(el("li", step.replace(/^\d+\. /, "")));
      article.append(list);
    } else article.append(el("p", topic.text));
    if (photos[id]) {
      const photo = photos[id],
        figure = el("figure"),
        image = el("img");
      image.src = photo.src;
      image.alt = photo.alt;
      image.loading = "eager";
      image.width = 1320;
      image.height = 940;
      const link = el("a");
      link.href = photo.src;
      link.target = "_blank";
      link.rel = "noopener";
      link.append(image);
      figure.append(
        link,
        el("figcaption", photo.caption + " Open the image for full size."),
      );
      article.append(figure);
    }
    if (topic.target) {
      const link = el("a", "Locate this control in the dashboard");
      link.href = "./#" + topic.target;
      article.append(link);
    }
    section.append(article);
  }
  document.getElementById("help-content").append(section);
}
for (const sop of workflowSops) {
  const article = el("article");
  article.id = "sop-" + sop.id;
  article.append(
    el("h3", sop.title + " · pilot " + sop.version),
    el("p", sopPrompt(sop.id)),
  );
  document.getElementById("workflows").append(article);
}
function reveal() {
  let id;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  if (id) document.getElementById(id)?.scrollIntoView();
}
reveal();
window.addEventListener("hashchange", reveal);
