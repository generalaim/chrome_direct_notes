(() => {
if (globalThis.__DIRECT_NOTES_CONTENT_SCRIPT_LOADED) {
  return;
}

globalThis.__DIRECT_NOTES_CONTENT_SCRIPT_LOADED = true;

const STORAGE_KEY = "directNotesWidget";
const MARKER_CLASS = "gr-direct-note-marker";
const HIGHLIGHT_CLASS = "gr-direct-note-highlight";

let settings = {
  enabled: false,
  notes: []
};
let refreshTimer = null;
let mutationObserver = null;

init();

async function init() {
  injectStyle();
  await loadSettings();
  bindEvents();
  scheduleRefresh();
}

function bindEvents() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "DIRECT_NOTES_GET_CONTEXT") {
      sendResponse({ context: getPageContext(), matches: matchedNotes() });
      return true;
    }

    if (message?.type === "DIRECT_NOTES_STATE_UPDATED") {
      loadSettings().then(() => {
        scheduleRefresh();
        sendResponse({ ok: true, context: getPageContext(), matches: matchedNotes() });
      });
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
      return;
    }

    applySettings(changes[STORAGE_KEY].newValue || {});
    scheduleRefresh();
  });

  window.addEventListener("popstate", scheduleRefresh);
  window.addEventListener("hashchange", scheduleRefresh);
  document.addEventListener("visibilitychange", scheduleRefresh);
  observePage();
}

async function loadSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  applySettings(data[STORAGE_KEY] || {});
}

function applySettings(saved) {
  settings.enabled = saved.enabled === true;
  settings.notes = Array.isArray(saved.notes) ? saved.notes.map(normalizeNote).filter((note) => note.key && note.text) : [];
}

function observePage() {
  mutationObserver?.disconnect();
  mutationObserver = new MutationObserver(scheduleRefresh);
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshMarker, 180);
}

function refreshMarker() {
  clearPageMarker();

  if (!settings.enabled || !isDirectPage()) {
    return;
  }

  const matches = matchedNotes();

  if (!matches.length) {
    return;
  }

  markPrimaryHeading(matches[0]);
  showFloatingMarker(matches);
}

function matchedNotes() {
  const keys = contextKeys(getPageContext());
  return settings.notes.filter((note) => keys.has(note.key));
}

function contextKeys(context) {
  const keys = new Set();

  ["campaign", "adgroup"].forEach((type) => {
    const item = context?.[type];

    if (item?.key) {
      keys.add(item.key);
    }
  });

  return keys;
}

function getPageContext() {
  const url = location.href;
  const title = pageTitle();
  const campaignId = idFromUrl(url, ["campaignId", "cid", "campaign_id"]) || pathId(/campaigns?\/(\d+)/i);
  const adgroupId = idFromUrl(url, ["adGroupId", "adgroupId", "groupId", "adgroup_id"]) || pathId(/(?:adgroups?|groups?)\/(\d+)/i);
  const names = entityNames(title);

  return {
    url,
    title,
    campaign: normalizeContextItem({
      id: campaignId,
      name: names.campaign || (campaignId ? `Кампания ${campaignId}` : title)
    }, "campaign", url),
    adgroup: normalizeContextItem({
      id: adgroupId,
      name: names.adgroup || (adgroupId ? `Группа ${adgroupId}` : "")
    }, "adgroup", url)
  };
}

function entityNames(title) {
  const crumbs = [...document.querySelectorAll("nav a, nav span, [aria-label*='readcrumb'] a, [aria-label*='readcrumb'] span")]
    .map(textFromNode)
    .filter(Boolean);
  const visibleTitle = title || crumbs.at(-1) || "";
  const campaignLabel = textNearLabels(["кампания", "campaign"]) || visibleTitle;
  const adgroupLabel = textNearLabels(["группа", "ad group", "adgroup"]);

  return {
    campaign: cleanEntityTitle(campaignLabel || crumbs.at(-2) || visibleTitle),
    adgroup: cleanEntityTitle(adgroupLabel || "")
  };
}

function textNearLabels(labels) {
  const candidates = [...document.querySelectorAll("h1, h2, [data-testid], [aria-label], label, span, div")]
    .slice(0, 900);

  for (const node of candidates) {
    if (isFormElement(node)) {
      continue;
    }

    const ownText = textFromNode(node);
    const marker = [
      ownText,
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-testid") || ""
    ].join(" ").toLowerCase();

    if (!labels.some((label) => marker.includes(label))) {
      continue;
    }

    const value = ownText
      .replace(/^(?:кампания|campaign|группа|ad\s*group|adgroup)\s*[:#-]?\s*/i, "")
      .trim();

    if (value && value.length <= 120) {
      return value;
    }
  }

  return "";
}

function pageTitle() {
  const candidates = [
    document.querySelector("h1"),
    document.querySelector("[data-testid*='Header'] h1"),
    document.querySelector("[data-testid*='Title']"),
    document.querySelector("main h1")
  ];

  return cleanEntityTitle(candidates.map(textFromNode).find(Boolean) || document.title.replace(/\s*[—|-]\s*Яндекс.Директ.*$/i, ""));
}

function markPrimaryHeading(note) {
  const target = document.querySelector("h1") || document.querySelector("main");

  if (!target || isFormElement(target)) {
    return;
  }

  target.classList.add(HIGHLIGHT_CLASS);
  target.setAttribute("data-gr-direct-note", note.text.slice(0, 160));
}

function showFloatingMarker(matches) {
  const marker = document.createElement("button");
  marker.className = MARKER_CLASS;
  marker.type = "button";
  marker.title = matches.map((note) => note.text).join("\n\n");
  marker.textContent = matches.length > 1 ? `GR Notes: ${matches.length}` : "GR Note";
  marker.addEventListener("click", () => {
    marker.classList.toggle("is-open");
  });

  const body = document.createElement("span");
  body.className = "gr-direct-note-marker-body";
  body.textContent = matches[0].text;
  marker.append(body);
  document.documentElement.append(marker);
}

function clearPageMarker() {
  document.querySelectorAll(`.${MARKER_CLASS}`).forEach((node) => node.remove());
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => {
    node.classList.remove(HIGHLIGHT_CLASS);
    node.removeAttribute("data-gr-direct-note");
  });
}

function injectStyle() {
  const style = document.createElement("style");
  style.textContent = [
    ".gr-direct-note-marker {",
    "  position: fixed;",
    "  right: 18px;",
    "  top: 78px;",
    "  z-index: 2147483647;",
    "  display: grid;",
    "  max-width: min(340px, calc(100vw - 32px));",
    "  padding: 8px 11px;",
    "  border: 1px solid rgba(47, 212, 125, .58);",
    "  border-radius: 999px;",
    "  background: #159457;",
    "  color: #fff;",
    "  font: 700 13px/1.25 Arial, sans-serif;",
    "  box-shadow: 0 12px 28px rgba(47, 212, 125, .26);",
    "  cursor: pointer;",
    "}",
    ".gr-direct-note-marker-body {",
    "  display: none;",
    "  max-width: 310px;",
    "  margin-top: 7px;",
    "  color: rgba(255,255,255,.92);",
    "  font: 500 12px/1.4 Arial, sans-serif;",
    "  white-space: pre-wrap;",
    "  text-align: left;",
    "}",
    ".gr-direct-note-marker.is-open {",
    "  border-radius: 8px;",
    "}",
    ".gr-direct-note-marker.is-open .gr-direct-note-marker-body {",
    "  display: block;",
    "}",
    ".gr-direct-note-highlight {",
    "  outline: 2px solid rgba(47, 212, 125, .72) !important;",
    "  outline-offset: 4px !important;",
    "  border-radius: 8px !important;",
    "}"
  ].join("\n");
  document.documentElement.append(style);
}

function normalizeNote(note) {
  const type = note?.type === "adgroup" ? "adgroup" : "campaign";
  const item = normalizeContextItem({
    id: note?.entityId,
    name: note?.name,
    fallback: note?.url
  }, type, note?.url || "");

  return {
    ...note,
    type,
    key: item.key,
    text: String(note?.text || "").trim()
  };
}

function normalizeContextItem(item, type, url) {
  const id = cleanId(item?.id || item?.entityId);
  const name = cleanText(item?.name);
  const fallback = cleanText(item?.fallback || url);
  const keySource = id || normalizeName(name) || normalizeUrlKey(fallback);
  const key = keySource ? `${type}:${keySource}` : "";

  return {
    type,
    id,
    name,
    key,
    url: String(url || "")
  };
}

function idFromUrl(url, names) {
  try {
    const params = new URL(url).searchParams;

    for (const name of names) {
      const value = cleanId(params.get(name));

      if (value) {
        return value;
      }
    }
  } catch (error) {
    return "";
  }

  return "";
}

function pathId(pattern) {
  return cleanId(pattern.exec(location.pathname)?.[1]);
}

function cleanId(value) {
  return String(value || "").match(/\d{3,}/)?.[0] || "";
}

function cleanText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function cleanEntityTitle(value) {
  return cleanText(value)
    .replace(/^(?:кампания|campaign|группа|ad\s*group|adgroup)\s*[:#-]?\s*/i, "")
    .replace(/\s*[—|-]\s*Яндекс.Директ.*$/i, "");
}

function normalizeName(value) {
  return cleanText(value).toLowerCase().replaceAll("ё", "е").replace(/[^а-яa-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
}

function normalizeUrlKey(value) {
  try {
    const url = new URL(value);
    return normalizeName(`${url.pathname}${url.search}`);
  } catch (error) {
    return normalizeName(value);
  }
}

function textFromNode(node) {
  return cleanText(node?.innerText || node?.textContent || "");
}

function isFormElement(node) {
  return Boolean(node?.closest?.("input, textarea, select, button, [contenteditable='true'], [role='textbox']"));
}

function isDirectPage() {
  return /^https:\/\/([^/]+\.)?direct\.yandex\.ru\//.test(location.href);
}
})();
