const STORAGE_KEY = "directNotesWidget";
const NOTE_TYPES = {
  campaign: { label: "Кампании", one: "Кампания", empty: "Заметок к кампаниям пока нет." },
  adgroup: { label: "Группы", one: "Группа", empty: "Заметок к группам пока нет." },
  ad: { label: "Объявления", one: "Объявление", empty: "Заметок к объявлениям пока нет." }
};

const state = {
  enabled: true,
  activeType: "campaign",
  notes: []
};

let toastTimer = null;
let lastCount = null;

const els = {
  notesCount: document.getElementById("notesCount"),
  campaignModeButton: document.getElementById("campaignModeButton"),
  adgroupModeButton: document.getElementById("adgroupModeButton"),
  adModeButton: document.getElementById("adModeButton"),
  enabledToggle: document.getElementById("enabledToggle"),
  pageStatus: document.getElementById("pageStatus"),
  currentBadge: document.getElementById("currentBadge"),
  currentSubtitle: document.getElementById("currentSubtitle"),
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

  [els.campaignModeButton, els.adgroupModeButton, els.adModeButton].forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeType = normalizeType(button.dataset.noteType);
      await saveState();
      render();
    });
  });

  els.refreshButton.addEventListener("click", async () => {
    await updatePageStatus();
    await notifyActiveTab();
    render();
    showToast("Страница обновлена");
  });

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
    render();
  });
}

async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  applySavedState(data[STORAGE_KEY] || {});
}

function applySavedState(saved) {
  state.enabled = saved.enabled !== false;
  state.activeType = normalizeType(saved.activeType);
  state.notes = Array.isArray(saved.notes) ? normalizeNotes(saved.notes) : [];
}

async function saveState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      enabled: state.enabled,
      activeType: state.activeType,
      notes: normalizeNotes(state.notes)
    }
  });
}

async function updatePageStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isDirect = isDirectUrl(tab?.url || "");

  els.pageStatus.textContent = isDirect
    ? "Страница Директа найдена. Плашка появляется при наведении."
    : "Открой страницу Яндекс.Директа.";
  els.currentBadge.textContent = isDirect ? "direct" : "нет";
  els.currentBadge.classList.toggle("is-found", isDirect);
  els.currentSubtitle.textContent = isDirect
    ? "Наведи на кампанию, группу или объявление: поле заметки откроется по клику на плашку."
    : "Виджет не добавляет элементы и не слушает клики вне direct.yandex.ru.";
}

function render() {
  renderHeader();
  renderTabs();
  renderList();
}

function renderHeader() {
  const count = state.notes.length;
  els.enabledToggle.checked = state.enabled;
  els.notesCount.textContent = String(count);

  if (lastCount !== null && count > lastCount) {
    bump(els.notesCount, count - lastCount);
  }

  lastCount = count;
}

function renderTabs() {
  els.campaignModeButton.classList.toggle("is-active", state.activeType === "campaign");
  els.adgroupModeButton.classList.toggle("is-active", state.activeType === "adgroup");
  els.adModeButton.classList.toggle("is-active", state.activeType === "ad");
  els.notesTitle.textContent = NOTE_TYPES[state.activeType].label;
  els.typeCount.textContent = `${activeNotes().length} шт.`;
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
    card.className = "note-card";

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
    type.textContent = NOTE_TYPES[note.type].one;

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

function activeNotes() {
  return state.notes.filter((note) => note.type === state.activeType);
}

function sortedActiveNotes() {
  return [...activeNotes()].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
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
