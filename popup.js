const STORAGE_KEY = "directNotesWidget";
const NOTE_TYPES = {
  campaign: { label: "Кампании", one: "Кампания", empty: "Заметок к кампаниям пока нет." },
  adgroup: { label: "Группы", one: "Группа", empty: "Заметок к группам пока нет." },
  ad: { label: "Объявления", one: "Объявление", empty: "Заметок к объявлениям пока нет." }
};

const state = {
  enabled: true,
  activeType: "campaign",
  showPageCounter: true,
  notes: [],
  pageContext: emptyPageContext(),
  scanRunning: false,
  scanMessage: "Скан отчета еще не запускался."
};

let toastTimer = null;
let lastCount = null;
let pageStatusTimer = null;

const els = {
  notesCount: document.getElementById("notesCount"),
  campaignModeButton: document.getElementById("campaignModeButton"),
  adgroupModeButton: document.getElementById("adgroupModeButton"),
  adModeButton: document.getElementById("adModeButton"),
  enabledToggle: document.getElementById("enabledToggle"),
  pageCounterToggle: document.getElementById("pageCounterToggle"),
  pageStatus: document.getElementById("pageStatus"),
  currentBadge: document.getElementById("currentBadge"),
  currentSubtitle: document.getElementById("currentSubtitle"),
  scanPageButton: document.getElementById("scanPageButton"),
  scanStatus: document.getElementById("scanStatus"),
  refreshButton: document.getElementById("refreshButton"),
  notesTitle: document.getElementById("notesTitle"),
  typeCount: document.getElementById("typeCount"),
  clearTypeButton: document.getElementById("clearTypeButton"),
  notesList: document.getElementById("notesList"),
  toast: document.getElementById("toast")
};

init();

async function init() {
  await loadState();
  bindEvents();
  await updatePageStatus();
  render();
}

function bindEvents() {
  els.enabledToggle.addEventListener("change", async () => {
    state.enabled = els.enabledToggle.checked;
    await saveState();
    await notifyActiveTab();
    showToast(state.enabled ? "Плашки заметок включены" : "Плашки заметок выключены");
  });

  els.pageCounterToggle.addEventListener("change", async () => {
    state.showPageCounter = els.pageCounterToggle.checked;
    await saveState();
    await notifyActiveTab();
    showToast(state.showPageCounter ? "Сводка на странице включена" : "Сводка на странице скрыта");
  });

  [els.campaignModeButton, els.adgroupModeButton, els.adModeButton].forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeType = normalizeType(button.dataset.noteType);
      await saveState();
      render();
    });
  });

  els.refreshButton.addEventListener("click", async () => {
    await notifyActiveTab();
    await updatePageStatus();
    render();
    showToast("Страница обновлена");
  });

  els.scanPageButton.addEventListener("click", scanCurrentReport);

  els.clearTypeButton.addEventListener("click", async () => {
    const count = activeNotes().length;

    if (!count) {
      return;
    }

    state.notes = state.notes.filter((note) => normalizeNote(note).type !== state.activeType);
    await saveState();
    await notifyActiveTab();
    render();
    showToast(`Очищено: ${count}`);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
      return;
    }

    applySavedState(changes[STORAGE_KEY].newValue || {});
    updatePageStatus().then(render);
  });

  chrome.tabs.onActivated?.addListener(schedulePageStatusRefresh);
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      schedulePageStatusRefresh();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      schedulePageStatusRefresh();
    }
  });
}

function schedulePageStatusRefresh() {
  clearTimeout(pageStatusTimer);
  pageStatusTimer = setTimeout(async () => {
    await updatePageStatus();
    render();
  }, 180);
}

async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  applySavedState(data[STORAGE_KEY] || {});
}

function applySavedState(saved) {
  state.enabled = saved.enabled !== false;
  state.activeType = normalizeType(saved.activeType);
  state.showPageCounter = saved.showPageCounter !== false;
  state.notes = Array.isArray(saved.notes) ? normalizeNotes(saved.notes) : [];
}

async function saveState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      enabled: state.enabled,
      activeType: state.activeType,
      showPageCounter: state.showPageCounter,
      notes: normalizeNotes(state.notes)
    }
  });
}

async function updatePageStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isDirect = isDirectUrl(tab?.url || "");
  state.pageContext = isDirect && tab?.id
    ? await getPageContext(tab.id)
    : emptyPageContext();

  els.pageStatus.textContent = isDirect
    ? "Страница Директа найдена. Плашка появляется при наведении."
    : "Открой страницу Яндекс.Директа.";
  els.currentBadge.textContent = isDirect ? `${state.pageContext.total} на стр.` : "нет";
  els.currentBadge.classList.toggle("is-found", isDirect);
  els.currentSubtitle.textContent = isDirect
    ? pageContextText()
    : "Виджет не добавляет элементы и не слушает клики вне direct.yandex.ru.";
}

async function getPageContext(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "DIRECT_NOTES_GET_CONTEXT" });
    return normalizePageContext(response?.context);
  } catch (error) {
    return emptyPageContext();
  }
}

function render() {
  renderHeader();
  renderTabs();
  renderScanState();
  renderList();
}

function renderHeader() {
  const count = state.notes.length;
  els.enabledToggle.checked = state.enabled;
  els.pageCounterToggle.checked = state.showPageCounter;
  els.notesCount.textContent = String(count);

  if (lastCount !== null && count > lastCount) {
    bump(els.notesCount, count - lastCount);
  }

  lastCount = count;
}

function renderScanState() {
  els.scanPageButton.textContent = state.scanRunning ? "Сканирую заметки..." : "Скан заметок";
  els.scanPageButton.disabled = state.scanRunning;
  els.scanPageButton.classList.toggle("is-running", state.scanRunning);
  els.scanStatus.textContent = state.scanMessage;
}

function renderTabs() {
  els.campaignModeButton.classList.toggle("is-active", state.activeType === "campaign");
  els.adgroupModeButton.classList.toggle("is-active", state.activeType === "adgroup");
  els.adModeButton.classList.toggle("is-active", state.activeType === "ad");
  els.notesTitle.textContent = NOTE_TYPES[state.activeType].label;
  const activeCount = activeNotes().length;
  const pageCount = pageKeysForType(state.activeType).size;
  els.typeCount.textContent = pageCount ? `${pageCount} на странице / ${activeCount} всего` : `${activeCount} всего`;
}

function renderList() {
  els.notesList.textContent = "";

  const notes = sortedActiveNotes();

  if (!notes.length) {
    els.notesList.append(emptyNode(NOTE_TYPES[state.activeType].empty));
    return;
  }

  notes.forEach((note) => {
    const card = document.createElement("article");
    const isOnPage = isNoteOnPage(note);
    card.className = `note-card${isOnPage ? " is-current" : ""}`;

    const head = document.createElement("div");
    head.className = "note-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "note-title-wrap";

    const title = document.createElement("div");
    title.className = "note-title";
    title.textContent = note.name || `${NOTE_TYPES[note.type].one} без названия`;

    const meta = document.createElement("div");
    meta.className = "note-meta";
    meta.textContent = noteMetaText(note);

    titleWrap.append(title, meta);

    const type = document.createElement("span");
    type.className = "note-type";
    type.textContent = isOnPage ? "На странице" : NOTE_TYPES[note.type].one;

    head.append(titleWrap, type);

    const text = document.createElement("p");
    text.className = "note-text";
    text.textContent = note.text;

    const actions = document.createElement("div");
    actions.className = "card-actions compact-actions";
    actions.append(
      actionButton("Копировать", "primary", () => copyNote(note)),
      actionButton("Удалить", "ghost danger", () => removeNote(note.id))
    );

    card.append(head, text, actions);
    els.notesList.append(card);
  });
}

function actionButton(label, className, handler) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function removeNote(id) {
  state.notes = state.notes.filter((note) => note.id !== id);
  await saveState();
  await notifyActiveTab();
  render();
  showToast("Заметка удалена");
}

async function copyNote(note) {
  await navigator.clipboard.writeText(note.text);
  showToast("Текст скопирован");
}

async function notifyActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !isDirectUrl(tab.url || "")) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "DIRECT_NOTES_STATE_UPDATED" }).catch(() => {});
}

async function scanCurrentReport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !isDirectUrl(tab.url || "")) {
    showToast("Открой страницу Директа");
    return;
  }

  state.scanRunning = true;
  state.scanMessage = "Сканирую заметки в отчете сверху вниз...";
  render();

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "DIRECT_NOTES_SCAN_REPORT" });

    if (response?.ok === false) {
      state.scanMessage = response.message || "Не удалось просканировать отчет";
      showToast(state.scanMessage);
      return;
    }

    state.pageContext = normalizePageContext(response?.context);
    state.scanMessage = scanResultText(response || {});
    showToast("Скан завершен");
  } catch (error) {
    state.scanMessage = "Обнови страницу Директа и попробуй снова";
    showToast("Скан не запустился");
  } finally {
    state.scanRunning = false;
    render();
  }
}

function scanResultText(response) {
  const context = normalizePageContext(response.context);
  const parts = [];

  if (context.byType.campaign) {
    parts.push(`кампаний: ${context.byType.campaign}`);
  }

  if (context.byType.adgroup) {
    parts.push(`групп: ${context.byType.adgroup}`);
  }

  if (context.byType.ad) {
    parts.push(`объявлений: ${context.byType.ad}`);
  }

  const details = parts.length ? ` (${parts.join(", ")})` : "";
  const steps = response.steps ? ` · шагов: ${response.steps}` : "";
  return `Просчитано: ${context.total} уник.${details}${steps}`;
}

function activeNotes() {
  return state.notes.filter((note) => note.type === state.activeType);
}

function sortedActiveNotes() {
  return [...activeNotes()].sort((a, b) => {
    const aOnPage = isNoteOnPage(a) ? 1 : 0;
    const bOnPage = isNoteOnPage(b) ? 1 : 0;

    if (aOnPage !== bOnPage) {
      return bOnPage - aOnPage;
    }

    return noteTime(b) - noteTime(a);
  });
}

function isNoteOnPage(note) {
  return pageKeySet().has(note.key);
}

function pageKeySet() {
  return new Set(state.pageContext.keys);
}

function pageKeysForType(type) {
  return new Set(state.pageContext.keys.filter((key) => key.startsWith(`${type}:`)));
}

function pageContextText() {
  const total = state.pageContext.total;

  if (!total) {
    return "На этой странице сохраненных заметок пока не найдено.";
  }

  const parts = [];
  const byType = state.pageContext.byType;

  if (byType.campaign) {
    parts.push(`кампаний: ${byType.campaign}`);
  }

  if (byType.adgroup) {
    parts.push(`групп: ${byType.adgroup}`);
  }

  if (byType.ad) {
    parts.push(`объявлений: ${byType.ad}`);
  }

  return `На странице: ${total} уник. (${parts.join(", ")})`;
}

function emptyPageContext() {
  return {
    keys: [],
    total: 0,
    byType: {
      campaign: 0,
      adgroup: 0,
      ad: 0
    }
  };
}

function normalizePageContext(context) {
  const normalized = emptyPageContext();
  const keys = Array.isArray(context?.keys) ? context.keys.filter(Boolean) : [];

  normalized.keys = [...new Set(keys)];
  normalized.total = normalized.keys.length;
  normalized.byType = {
    campaign: Number(context?.byType?.campaign || 0),
    adgroup: Number(context?.byType?.adgroup || 0),
    ad: Number(context?.byType?.ad || 0)
  };

  if (!normalized.byType.campaign && !normalized.byType.adgroup && !normalized.byType.ad) {
    normalized.keys.forEach((key) => {
      const type = normalizeType(String(key).split(":")[0]);
      normalized.byType[type] += 1;
    });
  }

  return normalized;
}

function normalizeNotes(notes) {
  const byKey = new Map();

  notes.forEach((note) => {
    const normalized = normalizeNote(note);

    if (!normalized.key || !normalized.text) {
      return;
    }

    byKey.set(normalized.key, normalized);
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

function noteMetaText(note) {
  const parts = [];

  if (note.entityId) {
    parts.push(`ID ${note.entityId}`);
  } else {
    parts.push("без ID");
  }

  if (note.name && note.name !== note.entityId) {
    parts.push(note.name);
  }

  parts.push(`Редактирование: ${formatDate(note.updatedAt || note.createdAt)}`);
  return parts.join(" · ");
}

function normalizeType(value) {
  return ["campaign", "adgroup", "ad"].includes(value) ? value : "campaign";
}

function isDirectUrl(url) {
  return /^https:\/\/([^/]+\.)?direct\.yandex\.ru\//.test(url || "");
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

function noteTime(note) {
  const time = new Date(note.updatedAt || note.createdAt || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function emptyNode(text) {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = text;
  return node;
}

function bump(element, count) {
  element.dataset.bump = `+${count}`;
  element.classList.remove("score-bump");
  void element.offsetWidth;
  element.classList.add("score-bump");
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove("show");
  }, 1800);
}
