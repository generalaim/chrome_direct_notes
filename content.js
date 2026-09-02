(() => {
if (globalThis.__DIRECT_NOTES_CONTENT_SCRIPT_LOADED) {
  return;
}

globalThis.__DIRECT_NOTES_CONTENT_SCRIPT_LOADED = true;

const STORAGE_KEY = "directNotesWidget";
const NOTE_TYPES = {
  campaign: "Кампания",
  adgroup: "Группа",
  ad: "Объявление"
};
const TARGETS = [
  {
    type: "campaign",
    selectors: [
      "[data-testid^='Grid.Cell-'][data-testid$='_Campaign_Campaign']",
      "[data-testid='Cell.Campaign_Campaign']"
    ]
  },
  {
    type: "adgroup",
    selectors: [
      "[data-testid^='Grid.Cell-'][data-testid$='_Adgroup_AdgroupId']",
      "[data-testid='Cell.Adgroup_AdgroupId']"
    ]
  },
  {
    type: "ad",
    selectors: [
      "[data-testid^='Grid.Cell-'][data-testid$='_Banner_Banner']",
      "[data-testid='Cell.Banner_Banner']"
    ]
  }
];

let settings = {
  enabled: true,
  activeType: "campaign",
  notes: []
};
let refreshTimer = null;
let mutationObserver = null;
let popover = null;
let activeEntity = null;
let hoverButton = null;
let hoverHideTimer = null;

init();

async function init() {
  if (!isDirectPage()) {
    return;
  }

  injectStyle();
  await loadSettings();
  bindEvents();
  scheduleRefresh();
}

function bindEvents() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "DIRECT_NOTES_GET_CONTEXT") {
      sendResponse({ ok: true, annotated: annotatePage() });
      return true;
    }

    if (message?.type === "DIRECT_NOTES_STATE_UPDATED") {
      loadSettings().then(() => {
        scheduleRefresh();
        sendResponse({ ok: true });
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

  document.addEventListener("click", handleOutsideClick, true);
  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("scroll", scheduleRefresh, true);
  window.addEventListener("resize", scheduleRefresh);
  observePage();
}

async function loadSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  applySettings(data[STORAGE_KEY] || {});
}

function applySettings(saved) {
  settings.enabled = saved.enabled !== false;
  settings.activeType = normalizeType(saved.activeType);
  settings.notes = Array.isArray(saved.notes) ? normalizeNotes(saved.notes) : [];
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
  refreshTimer = setTimeout(annotatePage, 160);
}

function annotatePage() {
  clearStaleButtons();

  if (!settings.enabled || !isDirectPage()) {
    hidePopover();
    hideHoverButton();
    return 0;
  }

  const entities = pageEntities();
  const notedEntities = entities.filter((entity) => noteForEntity(entity));
  notedEntities.forEach(addPersistentButtonForEntity);
  return notedEntities.length;
}

function pageEntities() {
  const byKey = new Map();

  TARGETS.forEach((target) => {
    document.querySelectorAll(target.selectors.join(",")).forEach((cell) => {
      const entity = entityFromCell(cell, target.type);

      if (entity?.key && !byKey.has(entity.key)) {
        byKey.set(entity.key, entity);
      }
    });
  });

  return [...byKey.values()];
}

function entityFromCell(cell, type) {
  const rootCell = cell.closest("[data-testid^='Grid.Cell-']") || cell;

  if (!isVisible(rootCell) || isTotalCell(rootCell) || shouldIgnoreCell(rootCell)) {
    return null;
  }

  const link = rootCell.querySelector("a[href]");
  const textNode = rootCell.querySelector("[data-testid='Text.Content']") || rootCell.querySelector("[data-testid='Text']") || link || rootCell;
  const name = cleanText(link?.textContent || textNode?.textContent || "");
  const href = link?.href || "";
  const entityId = cleanId(name) || cleanId(href);

  if (!entityId && !name) {
    return null;
  }

  return normalizeEntity({
    type,
    entityId,
    name: name || entityId,
    url: href || location.href,
    cell: rootCell
  });
}

function addPersistentButtonForEntity(entity) {
  if (entity.cell.querySelector(":scope > .gr-direct-note-button")) {
    updateButtonState(entity.cell.querySelector(":scope > .gr-direct-note-button"), entity);
    return;
  }

  const button = document.createElement("button");
  button.className = "gr-direct-note-button has-note";
  button.type = "button";
  button.textContent = "З";
  button.title = "Заметка GR";
  button.setAttribute("aria-label", `Заметка: ${NOTE_TYPES[entity.type]}`);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showEditor(entity, button);
  });

  updateButtonState(button, entity);
  entity.cell.classList.add("gr-direct-note-cell");
  entity.cell.append(button);
}

function updateButtonState(button, entity) {
  const note = noteForEntity(entity);
  button.classList.toggle("has-note", Boolean(note));
  button.dataset.noteKey = entity.key;
  button.title = note
    ? `${NOTE_TYPES[entity.type]}: заметка есть. Редактирование: ${formatDate(note.updatedAt || note.createdAt)}`
    : `${NOTE_TYPES[entity.type]}: добавить заметку`;
}

function handleMouseMove(event) {
  if (!settings.enabled || !isDirectPage() || popover) {
    hideHoverButtonSoon();
    return;
  }

  if (event.target?.closest?.(".gr-direct-note-hover, .gr-direct-note-button, .gr-direct-note-popover")) {
    clearTimeout(hoverHideTimer);
    return;
  }

  const cell = event.target?.closest?.(targetCellSelector());
  const target = targetForCell(cell);
  const entity = target ? entityFromCell(cell, target.type) : null;

  if (!entity?.key) {
    hideHoverButtonSoon();
    return;
  }

  showHoverButton(entity, event.clientX, event.clientY);
}

function showHoverButton(entity, x, y) {
  const note = noteForEntity(entity);

  if (!hoverButton) {
    hoverButton = document.createElement("button");
    hoverButton.className = "gr-direct-note-hover";
    hoverButton.type = "button";
    hoverButton.textContent = "Заметка";
    hoverButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (hoverButton.entity) {
        showEditor(hoverButton.entity, hoverButton);
        hideHoverButton();
      }
    });
    hoverButton.addEventListener("mouseenter", () => clearTimeout(hoverHideTimer));
    hoverButton.addEventListener("mouseleave", hideHoverButtonSoon);
    document.documentElement.append(hoverButton);
  }

  hoverButton.entity = entity;
  hoverButton.classList.toggle("has-note", Boolean(note));
  hoverButton.textContent = note ? "Заметка есть" : "Добавить заметку";
  hoverButton.title = note
    ? `${NOTE_TYPES[entity.type]}: редактировать заметку`
    : `${NOTE_TYPES[entity.type]}: добавить заметку`;
  hoverButton.style.left = `${Math.max(8, Math.min(window.innerWidth - 190, x + 14))}px`;
  hoverButton.style.top = `${Math.max(8, Math.min(window.innerHeight - 44, y + 12))}px`;
  hoverButton.hidden = false;
  clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(hideHoverButton, 1150);
}

function hideHoverButtonSoon() {
  clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(hideHoverButton, 220);
}

function hideHoverButton() {
  clearTimeout(hoverHideTimer);
  hoverButton?.remove();
  hoverButton = null;
}

function showEditor(entity, anchor) {
  activeEntity = entity;
  hideHoverButton();
  hidePopover();

  const note = noteForEntity(entity);
  popover = document.createElement("section");
  popover.className = "gr-direct-note-popover";
  popover.addEventListener("click", (event) => event.stopPropagation());

  const title = document.createElement("div");
  title.className = "gr-direct-note-popover-title";
  title.textContent = NOTE_TYPES[entity.type];

  const meta = document.createElement("div");
  meta.className = "gr-direct-note-popover-meta";
  meta.textContent = entityMetaText(entity, note);

  const textarea = document.createElement("textarea");
  textarea.className = "gr-direct-note-popover-text";
  textarea.rows = 5;
  textarea.placeholder = "Комментарий по работе, проверке, гипотезе или изменению";
  textarea.value = note?.text || "";

  const actions = document.createElement("div");
  actions.className = "gr-direct-note-popover-actions";

  const save = popoverButton(note ? "Сохранить" : "Добавить", "primary", async () => {
    await saveNote(entity, textarea.value);
  });
  const remove = popoverButton("Удалить", "danger", async () => {
    await removeNote(entity);
  });
  const close = popoverButton("Закрыть", "ghost", hidePopover);

  remove.disabled = !note;
  actions.append(save, remove, close);
  popover.append(title, meta, textarea, actions);
  document.documentElement.append(popover);
  placePopover(anchor);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function popoverButton(label, kind, handler) {
  const button = document.createElement("button");
  button.className = `gr-direct-note-popover-button ${kind}`;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handler();
  });
  return button;
}

async function saveNote(entity, rawText) {
  const text = cleanText(rawText);

  if (!text) {
    showInlineNotice("Пустую заметку не сохраняю");
    return;
  }

  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY] || {};
  const notes = Array.isArray(saved.notes) ? normalizeNotes(saved.notes) : [];
  const now = new Date().toISOString();
  const existing = notes.find((note) => note.key === entity.key);
  const nextNote = normalizeNote({
    id: existing?.id || crypto.randomUUID(),
    type: entity.type,
    key: entity.key,
    entityId: entity.entityId,
    name: entity.name,
    url: entity.url,
    text,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  });
  const nextNotes = [nextNote, ...notes.filter((note) => note.key !== entity.key)];

  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...saved,
      enabled: settings.enabled,
      activeType: entity.type,
      notes: nextNotes
    }
  });

  applySettings({ ...saved, enabled: settings.enabled, activeType: entity.type, notes: nextNotes });
  hidePopover();
  scheduleRefresh();
  showInlineNotice(existing ? "Заметка обновлена" : "Заметка добавлена");
}

async function removeNote(entity) {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY] || {};
  const notes = Array.isArray(saved.notes) ? normalizeNotes(saved.notes) : [];
  const nextNotes = notes.filter((note) => note.key !== entity.key);

  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...saved,
      enabled: settings.enabled,
      notes: nextNotes
    }
  });

  applySettings({ ...saved, enabled: settings.enabled, notes: nextNotes });
  hidePopover();
  scheduleRefresh();
  showInlineNotice("Заметка удалена");
}

function noteForEntity(entity) {
  return settings.notes.find((note) => note.key === entity.key) || null;
}

function entityMetaText(entity, note) {
  const parts = [];
  const name = cleanText(entity.name);

  if (entity.entityId) {
    parts.push(`ID ${entity.entityId}`);
  } else {
    parts.push("без ID");
  }

  if (name && name !== entity.entityId) {
    parts.push(name);
  }

  parts.push(note ? `Редактирование: ${formatDate(note.updatedAt || note.createdAt)}` : "Новая заметка");
  return parts.join(" · ");
}

function hidePopover() {
  popover?.remove();
  popover = null;
  activeEntity = null;
}

function placePopover(anchor) {
  if (!popover || !anchor) {
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  const height = 236;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
  const below = rect.bottom + 8;
  const above = rect.top - height - 8;
  const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, above);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.width = `${width}px`;
}

function handleOutsideClick(event) {
  if (!popover || popover.contains(event.target) || event.target.closest?.(".gr-direct-note-button, .gr-direct-note-hover")) {
    return;
  }

  hidePopover();
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    hidePopover();
  }

  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && popover && activeEntity) {
    event.preventDefault();
    const textarea = popover.querySelector("textarea");
    saveNote(activeEntity, textarea?.value || "");
  }
}

function showInlineNotice(message) {
  const notice = document.createElement("div");
  notice.className = "gr-direct-note-notice";
  notice.textContent = message;
  document.documentElement.append(notice);
  setTimeout(() => notice.remove(), 1400);
}

function clearStaleButtons() {
  document.querySelectorAll(".gr-direct-note-button").forEach((button) => {
    const cell = button.closest("[data-testid^='Grid.Cell-'], [data-testid^='Cell.']");
    const hasStoredNote = settings.notes.some((note) => note.key === button.dataset.noteKey);

    if (!cell || !isVisible(cell) || !settings.enabled || !hasStoredNote) {
      button.remove();
    }
  });
}

function targetCellSelector() {
  return TARGETS.flatMap((target) => target.selectors).join(",");
}

function targetForCell(cell) {
  if (!cell) {
    return null;
  }

  return TARGETS.find((target) => target.selectors.some((selector) => cell.matches(selector)));
}

function normalizeNotes(notes) {
  const byKey = new Map();

  notes.forEach((note) => {
    const normalized = normalizeNote(note);

    if (normalized.key && normalized.text) {
      byKey.set(normalized.key, normalized);
    }
  });

  return [...byKey.values()];
}

function normalizeNote(note) {
  const type = normalizeType(note?.type);
  const entityId = cleanId(note?.entityId);
  const name = cleanText(note?.name);
  const fallback = cleanText(note?.url);
  const keySource = entityId || normalizeName(name) || normalizeName(fallback);

  return {
    id: note?.id || crypto.randomUUID(),
    type,
    key: keySource ? `${type}:${keySource}` : "",
    entityId,
    name,
    url: String(note?.url || ""),
    text: String(note?.text || "").trim(),
    createdAt: note?.createdAt || note?.updatedAt || new Date().toISOString(),
    updatedAt: note?.updatedAt || note?.createdAt || new Date().toISOString()
  };
}

function normalizeEntity(entity) {
  const type = normalizeType(entity?.type);
  const entityId = cleanId(entity?.entityId);
  const name = cleanText(entity?.name);
  const url = String(entity?.url || location.href);
  const keySource = entityId || normalizeName(name) || normalizeName(url);

  return {
    type,
    key: keySource ? `${type}:${keySource}` : "",
    entityId,
    name,
    url,
    cell: entity.cell
  };
}

function normalizeType(value) {
  return ["campaign", "adgroup", "ad"].includes(value) ? value : "campaign";
}

function cleanId(value) {
  return String(value || "").match(/\d{3,}/)?.[0] || "";
}

function cleanText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeName(value) {
  return cleanText(value).toLowerCase().replaceAll("ё", "е").replace(/[^а-яa-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
}

function formatDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function isTotalCell(cell) {
  return /итого|всего/i.test(cleanText(cell.textContent));
}

function shouldIgnoreCell(cell) {
  return Boolean(cell.closest("[data-testid^='Grid.HeaderCell'], [data-testid='TotalSubHeader']"));
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
}

function isDirectPage() {
  return /^https:\/\/([^/]+\.)?direct\.yandex\.ru\//.test(location.href);
}

function injectStyle() {
  const style = document.createElement("style");
  style.textContent = [
    ".gr-direct-note-cell {",
    "  position: relative !important;",
    "}",
    ".gr-direct-note-button {",
    "  position: absolute !important;",
    "  right: 24px !important;",
    "  top: 50% !important;",
    "  z-index: 50 !important;",
    "  display: grid !important;",
    "  width: 21px !important;",
    "  height: 21px !important;",
    "  min-width: 21px !important;",
    "  min-height: 21px !important;",
    "  padding: 0 !important;",
    "  place-items: center !important;",
    "  border: 1px solid rgba(47, 212, 125, .72) !important;",
    "  border-radius: 999px !important;",
    "  background: #159457 !important;",
    "  color: #fff !important;",
    "  font: 700 12px/1 Arial, sans-serif !important;",
    "  box-shadow: 0 6px 16px rgba(0, 0, 0, .18) !important;",
    "  transform: translateY(-50%) !important;",
    "  cursor: pointer !important;",
    "}",
    ".gr-direct-note-button.has-note {",
    "  border-color: rgba(47, 212, 125, .72) !important;",
    "  background: #159457 !important;",
    "  color: #fff !important;",
    "}",
    ".gr-direct-note-hover {",
    "  position: fixed !important;",
    "  z-index: 2147483647 !important;",
    "  display: inline-grid !important;",
    "  min-width: 126px !important;",
    "  min-height: 30px !important;",
    "  place-items: center !important;",
    "  padding: 0 11px !important;",
    "  border: 1px solid rgba(94, 218, 255, .62) !important;",
    "  border-radius: 999px !important;",
    "  background: #111318 !important;",
    "  color: #8fe6ff !important;",
    "  font: 700 12px/16px Arial, sans-serif !important;",
    "  box-shadow: 0 8px 20px rgba(0, 0, 0, .26) !important;",
    "  cursor: pointer !important;",
    "}",
    ".gr-direct-note-hover.has-note {",
    "  border-color: rgba(47, 212, 125, .72) !important;",
    "  background: #159457 !important;",
    "  color: #fff !important;",
    "}",
    ".gr-direct-note-popover {",
    "  position: fixed !important;",
    "  z-index: 2147483647 !important;",
    "  box-sizing: border-box !important;",
    "  display: grid !important;",
    "  width: min(360px, calc(100vw - 24px)) !important;",
    "  max-width: calc(100vw - 24px) !important;",
    "  gap: 9px !important;",
    "  padding: 12px !important;",
    "  border: 1px solid rgba(47, 212, 125, .42) !important;",
    "  border-radius: 8px !important;",
    "  background: #191919 !important;",
    "  color: #fff !important;",
    "  box-shadow: 0 18px 44px rgba(0, 0, 0, .42) !important;",
    "  font-family: Arial, sans-serif !important;",
    "  overflow: hidden !important;",
    "}",
    ".gr-direct-note-popover-title {",
    "  font: 700 14px/18px Arial, sans-serif !important;",
    "}",
    ".gr-direct-note-popover-meta {",
    "  max-width: 100% !important;",
    "  overflow-wrap: anywhere !important;",
    "  color: #8c9199 !important;",
    "  font: 500 11px/15px Consolas, monospace !important;",
    "}",
    ".gr-direct-note-popover-text {",
    "  box-sizing: border-box !important;",
    "  display: block !important;",
    "  width: 100% !important;",
    "  max-width: 100% !important;",
    "  min-width: 0 !important;",
    "  min-height: 96px !important;",
    "  resize: vertical !important;",
    "  border: 1px solid #2a2d33 !important;",
    "  border-radius: 8px !important;",
    "  outline: 0 !important;",
    "  background: #101216 !important;",
    "  color: #fff !important;",
    "  padding: 9px 10px !important;",
    "  font: 500 13px/18px Arial, sans-serif !important;",
    "}",
    ".gr-direct-note-popover-text:focus {",
    "  border-color: rgba(47, 212, 125, .58) !important;",
    "}",
    ".gr-direct-note-popover-actions {",
    "  display: grid !important;",
    "  grid-template-columns: minmax(0, 1fr) auto auto !important;",
    "  gap: 7px !important;",
    "  max-width: 100% !important;",
    "}",
    ".gr-direct-note-popover-button {",
    "  box-sizing: border-box !important;",
    "  min-height: 32px !important;",
    "  padding: 0 10px !important;",
    "  border: 1px solid rgba(255, 255, 255, .22) !important;",
    "  border-radius: 999px !important;",
    "  background: transparent !important;",
    "  color: #dadbdf !important;",
    "  font: 500 12px/16px Arial, sans-serif !important;",
    "  white-space: nowrap !important;",
    "  cursor: pointer !important;",
    "}",
    ".gr-direct-note-popover-button.primary {",
    "  background: #fff !important;",
    "  color: #0a0a0a !important;",
    "}",
    ".gr-direct-note-popover-button.danger {",
    "  border-color: rgba(255, 56, 72, .48) !important;",
    "  color: #ff7a86 !important;",
    "}",
    ".gr-direct-note-popover-button:disabled {",
    "  opacity: .42;",
    "  cursor: default;",
    "}",
    ".gr-direct-note-notice {",
    "  position: fixed;",
    "  right: 18px;",
    "  bottom: 18px;",
    "  z-index: 2147483647;",
    "  padding: 10px 13px;",
    "  border-radius: 999px;",
    "  background: #fff;",
    "  color: #0a0a0a;",
    "  font: 700 13px/18px Arial, sans-serif;",
    "  box-shadow: 0 14px 34px rgba(0, 0, 0, .28);",
    "}"
  ].join("\n");
  document.documentElement.append(style);
}
})();
