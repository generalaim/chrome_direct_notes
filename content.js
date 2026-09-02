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
const GLOBAL_SCAN_LIMIT = 2600;
const HOVER_HIDE_DELAY = 560;
const SCROLL_SETTLE_DELAY = 240;
const MAX_SCROLL_STEPS = 120;
const MAX_IDLE_STEPS = 3;
const TARGETS = [
  {
    type: "campaign",
    selectors: [
      "[data-testid^='Grid.Cell-'][data-testid$='_Campaign_Campaign']",
      "[data-testid='Cell.Campaign_Campaign']",
      "[data-testid='CampaignNameCell.Id']",
      "[data-testid='Captions.InfoCampaign'] [data-testid='ClickToCopyText']",
      "[data-testid='CampaignsNavigationPanelHeader'] [data-testid='ClickToCopyText']"
    ],
    nameFields: ["Campaign_CampName"]
  },
  {
    type: "adgroup",
    selectors: [
      "[data-testid^='Grid.Cell-'][data-testid$='_Adgroup_AdgroupId']",
      "[data-testid='Cell.Adgroup_AdgroupId']",
      "[data-testid='AdgroupNameCell.Id']",
      "[data-testid^='GroupItem.'] [data-testid='ClickToCopyText']"
    ],
    nameFields: ["Adgroup_AdgroupName", "Adgroup_AdGroupName"]
  },
  {
    type: "ad",
    selectors: [
      "[data-testid^='Grid.Cell-'][data-testid$='_Banner_Banner']",
      "[data-testid='Cell.Banner_Banner']",
      "[data-testid='BannerNameCell.Id']"
    ],
    nameFields: ["Banner_BannerTitle", "Banner_Title", "Ad_Title"]
  }
];

let settings = {
  enabled: true,
  activeType: "campaign",
  showPageCounter: true,
  notes: []
};
let refreshTimer = null;
let mutationObserver = null;
let popover = null;
let activeEntity = null;
let hoverButton = null;
let hoverHideTimer = null;
let hoverEntity = null;
let pageCounter = null;
let fixedScanContext = null;
let lastLocationHref = location.href;
let enrichTimer = null;
let pageIntegrationActive = false;

init();

async function init() {
  if (!isDirectPage()) {
    return;
  }

  injectStyle();
  await loadSettings();
  bindEvents();
  syncPageIntegration();
}

function bindEvents() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "DIRECT_NOTES_GET_CONTEXT") {
      resetFixedScanIfLocationChanged();
      sendResponse({ ok: true, context: settings.enabled ? fixedScanContext || annotatePage() : emptyPageContext() });
      return true;
    }

    if (message?.type === "DIRECT_NOTES_SCAN_REPORT") {
      scanReportNotes().then(sendResponse);
      return true;
    }

    if (message?.type === "DIRECT_NOTES_STATE_UPDATED") {
      loadSettings().then(() => {
        fixedScanContext = null;
        syncPageIntegration();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message?.type === "DIRECT_NOTES_OPEN_NOTE") {
      loadSettings().then(() => {
        syncPageIntegration();
        const note = normalizeNote(message.note);
        const entity = entityFromNote(note);

        if (!settings.enabled || !entity?.key) {
          sendResponse({ ok: false, message: "Маркер на странице выключен" });
          return;
        }

        showEditor(entity, null);
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
    syncPageIntegration();
  });
}

function enablePageIntegration() {
  if (pageIntegrationActive || !isDirectPage()) {
    return;
  }

  document.addEventListener("click", handleOutsideClick, true);
  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("scroll", scheduleRefresh, true);
  window.addEventListener("resize", scheduleRefresh);
  window.addEventListener("popstate", handleLocationChange);
  window.addEventListener("hashchange", handleLocationChange);
  observePage();
  createHoverButton();
  createPageCounter();
  pageIntegrationActive = true;
  scheduleRefresh();
}

function disablePageIntegration() {
  document.removeEventListener("click", handleOutsideClick, true);
  document.removeEventListener("mousemove", handleMouseMove, true);
  document.removeEventListener("keydown", handleKeydown, true);
  window.removeEventListener("scroll", scheduleRefresh, true);
  window.removeEventListener("resize", scheduleRefresh);
  window.removeEventListener("popstate", handleLocationChange);
  window.removeEventListener("hashchange", handleLocationChange);

  pageIntegrationActive = false;
  mutationObserver?.disconnect();
  mutationObserver = null;
  fixedScanContext = null;
  clearTimeout(refreshTimer);
  clearTimeout(hoverHideTimer);
  clearTimeout(enrichTimer);
  clearPageArtifacts();
}

function syncPageIntegration() {
  if (settings.enabled && isDirectPage()) {
    enablePageIntegration();
    return;
  }

  disablePageIntegration();
}

async function loadSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  applySettings(data[STORAGE_KEY] || {});
}

function applySettings(saved) {
  settings.enabled = saved.enabled !== false;
  settings.activeType = normalizeType(saved.activeType);
  settings.showPageCounter = saved.showPageCounter !== false;
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
  if (!settings.enabled || !pageIntegrationActive || !isDirectPage()) {
    disablePageIntegration();
    return;
  }

  resetFixedScanIfLocationChanged();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(annotatePage, 160);
}

function handleLocationChange() {
  resetFixedScanIfLocationChanged();
  scheduleRefresh();
}

function resetFixedScanIfLocationChanged() {
  if (lastLocationHref === location.href) {
    return;
  }

  lastLocationHref = location.href;
  fixedScanContext = null;
}

function annotatePage() {
  resetFixedScanIfLocationChanged();
  clearStaleButtons();
  clearGlobalHighlights();
  clearGlobalNoteButtons();

  if (!settings.enabled || !isDirectPage()) {
    hidePopover();
    hideHoverButton();
    const context = emptyPageContext();
    clearPageArtifacts();
    return context;
  }

  const entities = pageEntities();
  scheduleNotesEnrichment(entities);
  const notedEntities = entities.filter((entity) => noteForEntity(entity));
  notedEntities.forEach(addPersistentButtonForEntity);
  const globalMatches = refreshGlobalHighlights();
  const context = pageNotesContext(notedEntities.map((entity) => noteForEntity(entity)).filter(Boolean).concat(globalMatches));
  const displayContext = fixedScanContext || context;
  renderPageCounter(displayContext);
  return displayContext;
}

async function scanReportNotes() {
  resetFixedScanIfLocationChanged();

  if (!settings.enabled || !isDirectPage()) {
    return { ok: false, message: "Открой страницу Директа", context: emptyPageContext() };
  }

  fixedScanContext = null;
  const scrollers = findScrollContainers();
  let best = null;

  for (const scroller of scrollers) {
    const result = await scanNotesWithScroller(scroller);

    if (!best || result.context.total > best.context.total || result.seenRows > best.seenRows) {
      best = result;
    }
  }

  fixedScanContext = best?.context || pageNotesContext(visiblePageNotes());
  await enrichNotesWithEntities(best?.entities || pageEntities());
  renderPageCounter(fixedScanContext);
  scheduleRefresh();

  return {
    ok: true,
    context: fixedScanContext,
    steps: best?.steps || 0,
    seenRows: best?.seenRows || 0,
    reachedBottom: best?.reachedBottom === true,
    message: fixedScanContext.total
      ? `Найдено уникальных заметок: ${fixedScanContext.total}`
      : "Заметки в отчете не найдены"
  };
}

async function scanNotesWithScroller(scroller) {
  const originalTop = scrollTopOf(scroller);
  const byKey = new Map();
  const entitiesByKey = new Map();
  const seenRows = new Set();
  let steps = 0;
  let idleSteps = 0;
  let previousTop = -1;
  let reachedBottom = false;

  scrollToPosition(scroller, 0);
  await delay(SCROLL_SETTLE_DELAY);

  while (steps < MAX_SCROLL_STEPS) {
    steps += 1;
    const beforeNotes = byKey.size;
    const beforeRows = seenRows.size;

    visiblePageNotes().forEach((note) => byKey.set(note.key, note));
    pageEntities().forEach((entity) => {
      if (entity?.key) {
        seenRows.add(entity.key);
        entitiesByKey.set(entity.key, entity);
      }
    });

    const currentTop = scrollTopOf(scroller);
    const maxTop = maxScrollTopOf(scroller);
    reachedBottom = currentTop >= maxTop - 8;

    if (byKey.size === beforeNotes && seenRows.size === beforeRows && Math.abs(currentTop - previousTop) < 2) {
      idleSteps += 1;
    } else {
      idleSteps = 0;
    }

    if ((reachedBottom && idleSteps >= 1) || idleSteps >= MAX_IDLE_STEPS) {
      break;
    }

    previousTop = currentTop;
    scrollDown(scroller);
    await delay(SCROLL_SETTLE_DELAY);
  }

  scrollToPosition(scroller, originalTop);
  await delay(SCROLL_SETTLE_DELAY);

  return {
    context: pageNotesContext([...byKey.values()]),
    entities: [...entitiesByKey.values()],
    seenRows: seenRows.size,
    steps,
    reachedBottom
  };
}

function visiblePageNotes() {
  return pageEntities()
    .map((entity) => noteForEntity(entity))
    .filter(Boolean)
    .concat(visibleTextNoteMatches());
}

function visibleTextNoteMatches() {
  const matched = new Map();
  const notesById = notesWithIds();

  if (!notesById.length) {
    return [];
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;

      if (!node.textContent?.trim() || !parent || !isVisible(parent) || shouldIgnoreHighlightNode(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode();
  let scanned = 0;

  while (node && scanned < GLOBAL_SCAN_LIMIT) {
    scanned += 1;
    const text = node.textContent || "";

    notesById.forEach((note) => {
      if (text.includes(note.entityId)) {
        matched.set(note.key, note);
      }
    });

    node = walker.nextNode();
  }

  return [...matched.values()];
}

function emptyPageContext() {
  return {
    keys: [],
    total: 0,
    login: currentLogin(),
    byType: {
      campaign: 0,
      adgroup: 0,
      ad: 0
    }
  };
}

function pageNotesContext(notes) {
  const byKey = new Map();

  notes.forEach((note) => {
    if (note?.key) {
      byKey.set(note.key, note);
    }
  });

  const context = emptyPageContext();
  context.keys = [...byKey.keys()];
  context.total = context.keys.length;
  [...byKey.values()].forEach((note) => {
    context.byType[note.type] = (context.byType[note.type] || 0) + 1;
  });
  return context;
}

function pageEntities() {
  const entities = [];

  TARGETS.forEach((target) => {
    document.querySelectorAll(target.selectors.join(",")).forEach((cell) => {
      const entity = entityFromCell(cell, target.type);

      if (entity?.key) {
        entities.push(entity);
      }
    });
  });

  return entities;
}

function entityFromCell(cell, type) {
  const rootCell = cell.closest("[data-testid^='Grid.Cell-'], .dc-Cell") || cell;

  if (!isVisible(rootCell) || isTotalCell(rootCell) || shouldIgnoreCell(rootCell)) {
    return null;
  }

  const source = cell.matches?.(targetCellSelector()) ? cell : rootCell;
  const sourceTestId = source.getAttribute?.("data-testid") || "";
  const isExplicitIdElement = /NameCell\.Id$/i.test(sourceTestId);
  const link = source.querySelector?.("a[href]") || rootCell.querySelector("a[href]");
  const roleLink = source.closest?.("[role='link']") || source.querySelector?.("[role='link']");
  const textNode =
    source.querySelector?.("[data-testid='Text.Content']") ||
    source.querySelector?.("[data-testid='Text']") ||
    source ||
    link ||
    rootCell;
  const ownText = cleanText(link?.textContent || textNode?.textContent || "");
  const href = link?.href || "";
  const entityId = cleanId(ownText) || cleanId(href);
  const relatedName = relatedEntityName(rootCell, type);
  const name = relatedName || (cleanId(ownText) === entityId ? "" : ownText);

  if (!entityId && !ownText && !name) {
    return null;
  }

  return normalizeEntity({
    type,
    entityId,
    name: name || entityId,
    url: href || location.href,
    login: currentLogin(),
    cell: rootCell,
    textElement: isExplicitIdElement ? source : link || roleLink || textNode || rootCell
  });
}

function addPersistentButtonForEntity(entity) {
  const existingButton = entity.cell.querySelector(`.gr-direct-note-button[data-note-key="${cssAttributeEscape(entity.key)}"]`);

  if (existingButton) {
    updateButtonState(existingButton, entity);
    return;
  }

  const button = document.createElement("button");
  button.className = "gr-direct-note-button has-note";
  button.type = "button";
  button.textContent = "З";
  button.title = "Заметка GR";
  button.directNotesEntity = entity;
  button.setAttribute("aria-label", `Заметка: ${NOTE_TYPES[entity.type]}`);
  ["pointerdown", "mousedown", "mouseup", "dblclick"].forEach((eventName) => {
    button.addEventListener(eventName, stopDirectEvent, true);
  });
  button.addEventListener("mouseenter", () => showHoverButton(entity));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    showEditor(entity, button);
  }, true);

  updateButtonState(button, entity);
  entity.cell.classList.add("gr-direct-note-cell");
  insertButtonAfterAnchor(inlineAnchorForEntity(entity), button);
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

  const noteButton = event.target?.closest?.(".gr-direct-note-button, .gr-direct-note-id-button");

  if (noteButton?.directNotesEntity) {
    showHoverButton(noteButton.directNotesEntity);
    return;
  }

  if (event.target?.closest?.(".gr-direct-note-hover, .gr-direct-note-popover")) {
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

  showHoverButton(entity);
}

function createHoverButton() {
  if (hoverButton) {
    return;
  }

  hoverButton = document.createElement("button");
  hoverButton.className = "gr-direct-note-hover";
  hoverButton.type = "button";
  hoverButton.textContent = "Заметка";
  hoverButton.hidden = true;
  hoverButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (hoverEntity) {
      showEditor(hoverEntity, hoverButton);
    }
  });
  hoverButton.addEventListener("mouseenter", () => clearTimeout(hoverHideTimer));
  hoverButton.addEventListener("mouseleave", hideHoverButtonSoon);
  document.documentElement.append(hoverButton);
}

function createPageCounter() {
  if (pageCounter) {
    return;
  }

  pageCounter = document.createElement("div");
  pageCounter.className = "gr-direct-note-page-count";
  pageCounter.hidden = true;
  document.documentElement.append(pageCounter);
}

function renderPageCounter(context) {
  if (!pageCounter) {
    createPageCounter();
  }

  const total = Number(context?.total || 0);
  pageCounter.hidden = !settings.showPageCounter || !total;

  if (!settings.showPageCounter || !total) {
    pageCounter.replaceChildren();
    return;
  }

  const byType = context?.byType || {};
  pageCounter.replaceChildren(
    pageCounterTitle(total),
    pageCounterRow("Кампании", byType.campaign || 0),
    pageCounterRow("Группы", byType.adgroup || 0),
    pageCounterRow("Объявления", byType.ad || 0)
  );
}

function pageCounterTitle(total) {
  const title = document.createElement("div");
  title.className = "gr-direct-note-page-count-title";

  const label = document.createElement("span");
  label.textContent = "Заметок";

  const icon = document.createElement("span");
  icon.className = "gr-direct-note-page-count-icon";
  icon.setAttribute("aria-hidden", "true");

  const value = document.createElement("strong");
  value.textContent = String(total);

  title.append(label, icon, value);
  return title;
}

function pageCounterRow(label, count) {
  const row = document.createElement("div");
  row.className = "gr-direct-note-page-count-row";

  const name = document.createElement("span");
  name.textContent = label;

  const value = document.createElement("strong");
  value.textContent = String(count);

  row.append(name, value);
  return row;
}

function showHoverButton(entity) {
  const note = noteForEntity(entity);

  if (!hoverButton) {
    createHoverButton();
  }

  hoverEntity = entity;
  hoverButton.classList.toggle("has-note", Boolean(note));
  hoverButton.textContent = note ? "Есть заметка" : "Добавить заметку";
  hoverButton.title = note
    ? `${NOTE_TYPES[entity.type]}: редактировать заметку`
    : `${NOTE_TYPES[entity.type]}: добавить заметку`;
  hoverButton.hidden = false;
  placeHoverButton(entity);
  clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(hideHoverButton, 1400);
}

function placeHoverButton(entity) {
  if (!hoverButton || !entity?.cell) {
    return;
  }

  const anchor = entity.cell.querySelector(`.gr-direct-note-button[data-note-key="${cssAttributeEscape(entity.key)}"]`)
    || document.querySelector(`.gr-direct-note-id-button[data-note-key="${cssAttributeEscape(entity.key)}"]`)
    || inlineAnchorForEntity(entity);
  const rect = anchor.getBoundingClientRect();
  const gap = 5;
  const width = hoverButton.offsetWidth || 132;
  const height = hoverButton.offsetHeight || 24;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right + gap));
  const top = Math.max(8, Math.min(window.innerHeight - height - 8, rect.top + (rect.height / 2) - (height / 2)));

  hoverButton.style.left = `${left}px`;
  hoverButton.style.top = `${top}px`;
}

function hideHoverButtonSoon() {
  clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(hideHoverButton, HOVER_HIDE_DELAY);
}

function hideHoverButton() {
  clearTimeout(hoverHideTimer);
  hoverEntity = null;

  if (hoverButton) {
    hoverButton.hidden = true;
  }
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

function stopDirectEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

async function saveNote(entity, rawText) {
  const text = cleanNoteText(rawText);

  if (!text) {
    showInlineNotice("Пустую заметку не сохраняю");
    return;
  }

  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY] || {};
  const notes = Array.isArray(saved.notes) ? normalizeNotes(saved.notes) : [];
  const now = new Date().toISOString();
  const existing = noteForEntityFromNotes(entity, notes);
  const nextNote = normalizeNote({
    id: existing?.id || crypto.randomUUID(),
    type: entity.type,
    key: entity.key,
    entityId: entity.entityId,
    name: entity.name,
    url: entity.url,
    login: entity.login || currentLogin(),
    text,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  });
  const nextNotes = [nextNote, ...notes.filter((note) => note.key !== entity.key && note.id !== existing?.id)];

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
  const existing = noteForEntityFromNotes(entity, notes);
  const nextNotes = notes.filter((note) => note.key !== entity.key && note.id !== existing?.id);

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
  return noteForEntityFromNotes(entity, settings.notes);
}

function noteForEntityFromNotes(entity, notes) {
  return notes.find((note) => note.key === entity.key)
    || notes.find((note) => !note.login && note.legacyKey === entity.legacyKey)
    || null;
}

function refreshGlobalHighlights() {
  const ranges = [];
  const matchedByKey = new Map();
  const notesById = notesWithIds();

  if (!notesById.length) {
    return [];
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim() || shouldIgnoreHighlightNode(node.parentElement)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode();
  let scanned = 0;

  while (node && scanned < GLOBAL_SCAN_LIMIT) {
    scanned += 1;
    const text = node.textContent || "";

    notesById.forEach((note) => {
      const index = text.indexOf(note.entityId);

      if (index < 0) {
        return;
      }

      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + note.entityId.length);
      ranges.push(range);

      matchedByKey.set(note.key, note);
    });

    node = walker.nextNode();
  }

  if (ranges.length && "Highlight" in window && typeof CSS !== "undefined" && CSS.highlights) {
    CSS.highlights.set("gr-direct-note-id", new Highlight(...ranges));
  }

  const matches = [...matchedByKey.values()];
  return matches;
}

function addGlobalNoteButtons(matches) {
  matches.forEach(({ note, range }) => {
    if (document.querySelector(`.gr-direct-note-button[data-note-key="${cssAttributeEscape(note.key)}"]`)) {
      return;
    }

    const rect = range.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      return;
    }

    if (document.querySelector(`.gr-direct-note-id-button[data-note-key="${cssAttributeEscape(note.key)}"]`)) {
      return;
    }

    const button = document.createElement("button");
    button.className = "gr-direct-note-id-button";
    button.type = "button";
    button.textContent = "З";
    button.dataset.noteKey = note.key;
    button.directNotesEntity = entityFromNote(note);
    button.title = `${NOTE_TYPES[note.type]}: заметка есть. Редактирование: ${formatDate(note.updatedAt || note.createdAt)}`;
    ["pointerdown", "mousedown", "mouseup", "dblclick"].forEach((eventName) => {
      button.addEventListener(eventName, stopDirectEvent, true);
    });
    button.addEventListener("mouseenter", () => showHoverButton(button.directNotesEntity));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      showEditor(button.directNotesEntity, button);
    }, true);

    button.style.left = `${Math.max(8, Math.min(window.innerWidth - 28, rect.right + 10))}px`;
    button.style.top = `${Math.max(8, Math.min(window.innerHeight - 22, rect.top + (rect.height - 18) / 2))}px`;
    document.documentElement.append(button);
  });
}

function notesWithIds() {
  return settings.notes
    .filter((note) => note.entityId && note.entityId.length >= 6)
    .sort((a, b) => b.entityId.length - a.entityId.length);
}

function clearGlobalHighlights() {
  if (typeof CSS !== "undefined" && CSS.highlights) {
    CSS.highlights.delete("gr-direct-note-id");
  }
}

function clearGlobalNoteButtons() {
  document.querySelectorAll(".gr-direct-note-id-button").forEach((button) => button.remove());
}

function clearPageArtifacts() {
  hidePopover();
  hideHoverButton();
  clearGlobalHighlights();
  clearGlobalNoteButtons();
  document.querySelectorAll(".gr-direct-note-button").forEach((button) => button.remove());
  document.querySelectorAll(".gr-direct-note-cell").forEach((cell) => cell.classList.remove("gr-direct-note-cell"));
  hoverButton?.remove();
  pageCounter?.remove();
  hoverButton = null;
  pageCounter = null;
  hoverEntity = null;
  activeEntity = null;
}

function entityMetaText(entity, note) {
  const parts = [];
  const name = cleanText(entity.name);

  parts.push(`Логин ${entity.login || note?.login || "без логина"}`);

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
  if (!popover) {
    return;
  }

  const width = Math.min(360, window.innerWidth - 24);

  popover.style.left = "50%";
  popover.style.top = "50%";
  popover.style.width = `${width}px`;
  popover.style.transform = "translate(-50%, -50%)";
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

function inlineAnchorForEntity(entity) {
  return entity.textElement && document.documentElement.contains(entity.textElement)
    ? entity.textElement
    : entity.cell;
}

function insertButtonAfterAnchor(anchor, button) {
  if (!anchor) {
    return;
  }

  if (anchor.parentElement?.classList.contains("gr-direct-note-inline-wrap")) {
    anchor.parentElement.append(button);
    return;
  }

  const wrap = document.createElement("span");
  wrap.className = "gr-direct-note-inline-wrap";
  anchor.insertAdjacentElement("beforebegin", wrap);
  wrap.append(anchor, button);
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

function targetForType(type) {
  return TARGETS.find((target) => target.type === type) || null;
}

function relatedEntityName(rootCell, type) {
  const target = targetForType(type);
  const row = rootCell.closest("[data-testid^='Grid.Row-']");

  if (!target?.nameFields?.length || !row) {
    return nonGridEntityName(rootCell, type);
  }

  for (const field of target.nameFields) {
    const nameCell = row.querySelector(`[data-testid$='_${cssAttributeEscape(field)}'], [data-testid='Cell.${cssAttributeEscape(field)}']`);

    if (!nameCell || nameCell === rootCell || !isVisible(nameCell)) {
      continue;
    }

    const name = cleanEntityName(nameCell);

    if (name) {
      return name;
    }
  }

  return "";
}

function nonGridEntityName(rootCell, type) {
  if (type === "campaign") {
    return cleanEntityName(document.querySelector("[data-testid='CampaignHeader.TitleName']"))
      || cleanEntityName(document.querySelector("[data-testid='CampaignsNavigationPanelHeader'] .PanelHeader_title__F3Sv7"));
  }

  if (type === "adgroup") {
    const navigationItem = rootCell.closest("[data-testid^='GroupItem.'], [data-testid='NavigationItem']");
    return cleanEntityName(navigationItem?.querySelector(".NavigationItem_title__TUIS2"));
  }

  return "";
}

function cleanEntityName(cell) {
  if (!cell) {
    return "";
  }

  const textElement =
    cell.querySelector?.("a[href]") ||
    cell.querySelector?.("[data-testid='Text.Content']") ||
    cell.querySelector?.("[data-testid='Text']") ||
    cell;
  const text = cleanText(textElement?.textContent || "");

  if (!text || /^\d+$/.test(text) || /^итого$/i.test(text)) {
    return "";
  }

  return text;
}

function scheduleNotesEnrichment(entities) {
  const candidates = entities.filter((entity) => entity?.key && entity.name && entity.name !== entity.entityId);

  if (!candidates.length) {
    return;
  }

  clearTimeout(enrichTimer);
  enrichTimer = setTimeout(() => enrichNotesWithEntities(candidates), 400);
}

async function enrichNotesWithEntities(entities) {
  const byKey = new Map();
  entities.forEach((entity) => {
    byKey.set(entity.key, entity);

    if (entity.legacyKey) {
      byKey.set(entity.legacyKey, entity);
    }
  });

  if (!byKey.size) {
    return;
  }

  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY] || {};
  const notes = Array.isArray(saved.notes) ? normalizeNotes(saved.notes) : [];
  let changed = false;

  const nextNotes = notes.map((note) => {
    const entity = byKey.get(note.key) || byKey.get(note.legacyKey);

    if (!entity || !entity.name || !shouldUpdateNoteName(note)) {
      return note;
    }

    changed = true;
    return {
      ...note,
      name: entity.name
    };
  });

  if (!changed) {
    return;
  }

  settings.notes = nextNotes;
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...saved,
      notes: nextNotes
    }
  });
}

function shouldUpdateNoteName(note) {
  if (!note.name) {
    return true;
  }

  if (note.entityId && note.name === note.entityId) {
    return true;
  }

  return false;
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
  const login = cleanLogin(note?.login);
  const keySource = entityId || normalizeName(name) || normalizeName(fallback);
  const legacyKey = keySource ? `${type}:${keySource}` : "";

  return {
    id: note?.id || crypto.randomUUID(),
    type,
    key: login && legacyKey ? `${login}|${legacyKey}` : legacyKey,
    legacyKey,
    login,
    entityId,
    name,
    url: String(note?.url || ""),
    text: cleanNoteText(note?.text),
    createdAt: note?.createdAt || note?.updatedAt || new Date().toISOString(),
    updatedAt: note?.updatedAt || note?.createdAt || new Date().toISOString()
  };
}

function normalizeEntity(entity) {
  const type = normalizeType(entity?.type);
  const entityId = cleanId(entity?.entityId);
  const name = cleanText(entity?.name);
  const url = String(entity?.url || location.href);
  const login = cleanLogin(entity?.login || currentLogin());
  const keySource = entityId || normalizeName(name) || normalizeName(url);
  const legacyKey = keySource ? `${type}:${keySource}` : "";

  return {
    type,
    key: login && legacyKey ? `${login}|${legacyKey}` : legacyKey,
    legacyKey,
    login,
    entityId,
    name,
    url,
    cell: entity.cell,
    textElement: entity.textElement || entity.cell
  };
}

function entityFromNote(note) {
  return normalizeEntity({
    type: note.type,
    entityId: note.entityId,
    name: note.name || note.entityId,
    url: note.url || location.href,
    login: note.login || currentLogin(),
    cell: null
  });
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

function cleanNoteText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function currentLogin() {
  try {
    return cleanLogin(new URL(location.href).searchParams.get("ulogin"));
  } catch (error) {
    return "";
  }
}

function cleanLogin(value) {
  return cleanText(value).toLowerCase();
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

function shouldIgnoreHighlightNode(element) {
  if (!element || element === document.documentElement || element === document.body) {
    return false;
  }

  return Boolean(
    element.closest(
      "input, textarea, select, button, [contenteditable='true'], [role='textbox'], .gr-direct-note-popover, .gr-direct-note-hover"
    )
  );
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

function cssAttributeEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function findScrollContainers() {
  const nodes = [
    ...document.querySelectorAll("*"),
    document.scrollingElement,
    document.documentElement,
    document.body
  ];

  return uniqueElements(nodes)
    .filter((node) => node && isScrollable(node))
    .sort((a, b) => maxScrollTopOf(b) - maxScrollTopOf(a))
    .slice(0, 4);
}

function isScrollable(element) {
  if (!element) {
    return false;
  }

  const style = getComputedStyle(element);
  const overflowY = `${style.overflowY} ${style.overflow}`;
  return /(auto|scroll|overlay)/i.test(overflowY) && maxScrollTopOf(element) > 24;
}

function scrollTopOf(element) {
  if (isDocumentScroller(element)) {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  return element.scrollTop || 0;
}

function maxScrollTopOf(element) {
  if (isDocumentScroller(element)) {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function scrollToPosition(element, top) {
  if (isDocumentScroller(element)) {
    window.scrollTo({ top, behavior: "auto" });
    return;
  }

  element.scrollTop = top;
}

function scrollDown(element) {
  const step = isDocumentScroller(element)
    ? Math.max(240, Math.floor(window.innerHeight * 0.72))
    : Math.max(240, Math.floor(element.clientHeight * 0.72));
  scrollToPosition(element, Math.min(maxScrollTopOf(element), scrollTopOf(element) + step));
}

function isDocumentScroller(element) {
  return element === document.body || element === document.documentElement || element === document.scrollingElement;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueElements(elements) {
  return [...new Set(elements.filter(Boolean))];
}

function injectStyle() {
  const style = document.createElement("style");
  style.textContent = [
    ".gr-direct-note-cell {",
    "  position: relative !important;",
    "}",
    ".gr-direct-note-inline-wrap {",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  gap: 5px !important;",
    "  max-width: 100% !important;",
    "  vertical-align: baseline !important;",
    "  white-space: nowrap !important;",
    "}",
    ".gr-direct-note-button {",
    "  position: relative !important;",
    "  z-index: 50 !important;",
    "  display: inline-grid !important;",
    "  width: 18px !important;",
    "  height: 18px !important;",
    "  min-width: 18px !important;",
    "  min-height: 18px !important;",
    "  margin-left: 0 !important;",
    "  padding: 0 !important;",
    "  place-items: center !important;",
    "  border: 1px solid rgba(94, 218, 255, .78) !important;",
    "  border-radius: 999px !important;",
    "  background: rgba(72, 208, 255, .16) !important;",
    "  color: #e8fbff !important;",
    "  font: 700 11px/1 Arial, sans-serif !important;",
    "  vertical-align: middle !important;",
    "  box-shadow: 0 5px 12px rgba(0, 0, 0, .18) !important;",
    "  cursor: pointer !important;",
    "}",
    ".gr-direct-note-button.has-note {",
    "  border-color: rgba(94, 218, 255, .78) !important;",
    "  background: rgba(72, 208, 255, .16) !important;",
    "  color: #e8fbff !important;",
    "}",
    ".gr-direct-note-id-button {",
    "  position: fixed !important;",
    "  z-index: 2147483646 !important;",
    "  display: grid !important;",
    "  width: 18px !important;",
    "  height: 18px !important;",
    "  min-width: 18px !important;",
    "  min-height: 18px !important;",
    "  padding: 0 !important;",
    "  place-items: center !important;",
    "  border: 1px solid rgba(94, 218, 255, .78) !important;",
    "  border-radius: 999px !important;",
    "  background: rgba(72, 208, 255, .16) !important;",
    "  color: #e8fbff !important;",
    "  font: 700 11px/1 Arial, sans-serif !important;",
    "  box-shadow: 0 5px 12px rgba(0, 0, 0, .18) !important;",
    "  cursor: pointer !important;",
    "}",
    ".gr-direct-note-hover {",
    "  position: fixed !important;",
    "  z-index: 2147483647 !important;",
    "  display: inline-grid !important;",
    "  width: max-content !important;",
    "  height: 24px !important;",
    "  min-width: 0 !important;",
    "  min-height: 24px !important;",
    "  place-items: center !important;",
    "  padding: 0 8px !important;",
    "  border: 1px solid rgba(94, 218, 255, .78) !important;",
    "  border-radius: 999px !important;",
    "  background: #123042 !important;",
    "  color: #e8fbff !important;",
    "  font: 700 11px/14px Arial, sans-serif !important;",
    "  white-space: nowrap !important;",
    "  box-shadow: 0 8px 18px rgba(0, 0, 0, .30), 0 0 0 1px rgba(94, 218, 255, .12) !important;",
    "  cursor: pointer !important;",
    "}",
    ".gr-direct-note-hover[hidden] {",
    "  display: none !important;",
    "}",
    ".gr-direct-note-hover.has-note {",
    "  border-color: rgba(94, 218, 255, .78) !important;",
    "  background: #123042 !important;",
    "  color: #e8fbff !important;",
    "  box-shadow: 0 8px 18px rgba(0, 0, 0, .30), 0 0 0 1px rgba(94, 218, 255, .12) !important;",
    "}",
    ".gr-direct-note-page-count {",
    "  position: fixed !important;",
    "  top: 12px !important;",
    "  left: 50% !important;",
    "  z-index: 2147483645 !important;",
    "  box-sizing: border-box !important;",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  gap: 6px !important;",
    "  max-width: calc(100vw - 32px) !important;",
    "  padding: 7px !important;",
    "  border: 1px solid rgba(94, 218, 255, .62) !important;",
    "  border-radius: 999px !important;",
    "  background: rgba(8, 10, 14, .92) !important;",
    "  color: #e8fbff !important;",
    "  font: 600 11px/14px Arial, sans-serif !important;",
    "  box-shadow: 0 10px 24px rgba(0, 0, 0, .32), inset 0 1px 0 rgba(255, 255, 255, .05) !important;",
    "  backdrop-filter: blur(8px) !important;",
    "  pointer-events: none !important;",
    "  transform: translateX(-50%) !important;",
    "}",
    ".gr-direct-note-page-count[hidden] {",
    "  display: none !important;",
    "}",
    ".gr-direct-note-page-count-title {",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  gap: 6px !important;",
    "  flex: 0 0 auto !important;",
    "  padding: 0 6px !important;",
    "  color: #ffffff !important;",
    "  font: 700 12px/18px Arial, sans-serif !important;",
    "}",
    ".gr-direct-note-page-count-title strong {",
    "  color: #e8fbff !important;",
    "  font: 700 12px/1 Consolas, monospace !important;",
    "}",
    ".gr-direct-note-page-count-icon {",
    "  display: inline-block !important;",
    "  width: 6px !important;",
    "  height: 6px !important;",
    "  border-radius: 999px !important;",
    "  background: #5edaff !important;",
    "  box-shadow: 0 0 0 3px rgba(94, 218, 255, .14) !important;",
    "}",
    ".gr-direct-note-page-count-row {",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  gap: 5px !important;",
    "  min-height: 20px !important;",
    "  padding: 0 7px !important;",
    "  border: 1px solid rgba(94, 218, 255, .18) !important;",
    "  border-radius: 999px !important;",
    "  background: rgba(72, 208, 255, .08) !important;",
    "  color: #aeb7c4 !important;",
    "  white-space: nowrap !important;",
    "}",
    ".gr-direct-note-page-count-row strong {",
    "  color: #e8fbff !important;",
    "  font: 700 12px/1 Consolas, monospace !important;",
    "}",
    ".gr-direct-note-popover {",
    "  position: fixed !important;",
    "  z-index: 2147483647 !important;",
    "  box-sizing: border-box !important;",
    "  display: grid !important;",
    "  width: min(360px, calc(100vw - 24px)) !important;",
    "  max-width: calc(100vw - 24px) !important;",
    "  max-height: calc(100vh - 24px) !important;",
    "  gap: 9px !important;",
    "  padding: 12px !important;",
    "  border: 1px solid rgba(94, 218, 255, .54) !important;",
    "  border-radius: 8px !important;",
    "  background: #191919 !important;",
    "  color: #fff !important;",
    "  box-shadow: 0 18px 44px rgba(0, 0, 0, .42) !important;",
    "  font-family: Arial, sans-serif !important;",
    "  overflow: auto !important;",
    "  transform: translate(-50%, -50%) !important;",
    "}",
    ".gr-direct-note-popover-title {",
    "  font: 700 14px/18px Arial, sans-serif !important;",
    "}",
    ".gr-direct-note-popover-meta {",
    "  max-width: 100% !important;",
    "  overflow-wrap: anywhere !important;",
    "  color: #8c9199 !important;",
    "  font: 500 13px/18px Consolas, monospace !important;",
    "}",
    ".gr-direct-note-popover-text {",
    "  box-sizing: border-box !important;",
    "  display: block !important;",
    "  width: 100% !important;",
    "  max-width: 100% !important;",
    "  min-width: 0 !important;",
    "  min-height: 360px !important;",
    "  resize: vertical !important;",
    "  border: 1px solid #2a2d33 !important;",
    "  border-radius: 8px !important;",
    "  outline: 0 !important;",
    "  background: #101216 !important;",
    "  color: #fff !important;",
    "  padding: 9px 10px !important;",
    "  font: 500 16px/22px Arial, sans-serif !important;",
    "}",
    ".gr-direct-note-popover-text:focus {",
    "  border-color: rgba(94, 218, 255, .78) !important;",
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
    "  border-color: rgba(94, 218, 255, .78) !important;",
    "  background: rgba(72, 208, 255, .16) !important;",
    "  color: #e8fbff !important;",
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
    "}",
    "::highlight(gr-direct-note-id) {",
    "  background-color: rgba(72, 208, 255, .30);",
    "  color: inherit;",
    "}"
  ].join("\n");
  document.documentElement.append(style);
}
})();
