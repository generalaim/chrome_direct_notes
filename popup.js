const STORAGE_KEY = "directNotesWidget";
const NOTE_TYPES = {
  campaign: {
    label: "Кампании",
    one: "Кампания",
    empty: "Заметок к кампаниям пока нет."
  },
  adgroup: {
    label: "Группы",
    one: "Группа",
    empty: "Заметок к группам пока нет."
  }
};

const state = {
  enabled: false,
  activeType: "campaign",
  notes: [],
  currentContext: null,
  editingId: ""
};

let toastTimer = null;
let lastCount = null;

const els = {
  notesCount: document.getElementById("notesCount"),
  campaignModeButton: document.getElementById("campaignModeButton"),
  adgroupModeButton: document.getElementById("adgroupModeButton"),
  enabledToggle: document.getElementById("enabledToggle"),
  pageStatus: document.getElementById("pageStatus"),
  currentTitle: document.getElementById("currentTitle"),
  currentBadge: document.getElementById("currentBadge"),
  currentSubtitle: document.getElementById("currentSubtitle"),
  refreshButton: document.getElementById("refreshButton"),
  noteForm: document.getElementById("noteForm"),
  noteText: document.getElementById("noteText"),
  saveButton: document.getElementById("saveButton"),
  notesTitle: document.getElementById("notesTitle"),
  typeCount: document.getElementById("typeCount"),
  copyCurrentButton: document.getElementById("copyCurrentButton"),
  clearTypeButton: document.getElementById("clearTypeButton"),
  notesList: document.getElementById("notesList"),
  toast: document.getElementById("toast")
};

init();

async function init() {
  await loadState();
  bindEvents();
  await refreshContext();
  render();
}

function bindEvents() {
  els.enabledToggle.addEventListener("change", async () => {
    state.enabled = els.enabledToggle.checked;
    await saveState();
    await notifyActiveTab();
    showToast(state.enabled ? "Маркер включен" : "Маркер выключен");
  });

  [els.campaignModeButton, els.adgroupModeButton].forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeType = button.dataset.noteType === "adgroup" ? "adgroup" : "campaign";
      state.editingId = "";
      await saveState();
      render();
    });
  });

  els.refreshButton.addEventListener("click", async () => {
    await refreshContext();
    render();
    showToast("Страница обновлена");
  });

  els.noteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveCurrentNote();
  });

  els.copyCurrentButton.addEventListener("click", copyCurrentNote);

  els.clearTypeButton.addEventListener("click", async () => {
    const count = activeNotes().length;

    if (!count) {
      return;
    }

    state.notes = state.notes.filter((note) => normalizeNote(note).type !== state.activeType);
    state.editingId = "";
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
  state.enabled = saved.enabled === true;
  state.activeType = saved.activeType === "adgroup" ? "adgroup" : "campaign";
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

async function refreshContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  state.currentContext = null;

  if (!isDirectUrl(url)) {
    els.pageStatus.textContent = "Открой страницу Яндекс.Директа.";
    return;
  }

  els.pageStatus.textContent = "Страница Директа найдена.";

  if (!tab?.id) {
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "DIRECT_NOTES_GET_CONTEXT" });
    state.currentContext = normalizeContext(response?.context || fallbackContextFromUrl(url));
  } catch (error) {
    state.currentContext = normalizeContext(fallbackContextFromUrl(url));
  }

  const preferredType = bestTypeForContext(state.currentContext);
  if (preferredType) {
    state.activeType = preferredType;
  }
}

async function saveCurrentNote() {
  const text = els.noteText.value.trim();
  const context = currentTypedContext();

  if (!context) {
    showToast("Не вижу кампанию или группу");
    return;
  }

  if (!text) {
    showToast("Заметка пустая");
    return;
  }

  const now = new Date().toISOString();
  const existing = currentNote();

  if (state.editingId) {
    state.notes = state.notes.map((note) => (
      note.id === state.editingId
        ? normalizeNote({
          ...note,
          ...noteFieldsFromContext(context),
          text,
          updatedAt: now
        })
        : note
    ));
  } else if (existing) {
    state.notes = state.notes.map((note) => (
      note.key === context.key
        ? normalizeNote({
          ...note,
          ...noteFieldsFromContext(context),
          text,
          updatedAt: now
        })
        : note
    ));
  } else {
    state.notes = [
      normalizeNote({
        ...noteFieldsFromContext(context),
        id: crypto.randomUUID(),
        text,
        createdAt: now,
        updatedAt: now
      }),
      ...state.notes
    ];
  }

  state.editingId = "";
  els.noteText.value = "";
  await saveState();
  await notifyActiveTab();
  render();
  showToast(existing ? "Заметка обновлена" : "Заметка сохранена");
}

function render() {
  renderHeader();
  renderTabs();
  renderCurrentContext();
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
  els.notesTitle.textContent = NOTE_TYPES[state.activeType].label;
  els.typeCount.textContent = `${activeNotes().length} шт.`;
}

function renderCurrentContext() {
  const context = currentTypedContext();
  const note = currentNote();

  els.currentTitle.textContent = context?.name || NOTE_TYPES[state.activeType].one;
  els.currentBadge.textContent = context?.id ? `ID ${context.id}` : "нет ID";
  els.currentBadge.classList.toggle("is-found", Boolean(note));
  els.currentSubtitle.textContent = context
    ? `${NOTE_TYPES[state.activeType].one}: ${context.name || "название не найдено"}`
    : `На этой странице ${NOTE_TYPES[state.activeType].one.toLowerCase()} пока не распознана.`;
  els.noteText.value = state.editingId ? els.noteText.value : note?.text || "";
  els.saveButton.textContent = note ? "Обновить заметку" : "Сохранить заметку";
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
    card.classList.toggle("is-current", currentTypedContext()?.key === note.key);

    const head = document.createElement("div");
    head.className = "note-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "note-title-wrap";

    const title = document.createElement("div");
    title.className = "note-title";
    title.textContent = note.name || `${NOTE_TYPES[note.type].one} без названия`;

    const meta = document.createElement("div");
    meta.className = "note-meta";
    meta.textContent = [note.entityId ? `ID ${note.entityId}` : "без ID", formatDate(note.updatedAt || note.createdAt)].filter(Boolean).join(" · ");

    titleWrap.append(title, meta);

    const type = document.createElement("span");
    type.className = "note-type";
    type.textContent = NOTE_TYPES[note.type].one;

    head.append(titleWrap, type);

    const text = document.createElement("p");
    text.className = "note-text";
    text.textContent = note.text;

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const edit = actionButton("Редактировать", "ghost", () => editNote(note));
    const copy = actionButton("Копировать", "primary", () => copyNote(note));
    const remove = actionButton("Удалить", "ghost danger", () => removeNote(note.id));

    actions.append(copy, edit, remove);
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

function editNote(note) {
  state.activeType = note.type;
  state.editingId = note.id;
  els.noteText.value = note.text;
  els.noteText.focus();
  render();
}

async function removeNote(id) {
  state.notes = state.notes.filter((note) => note.id !== id);
  if (state.editingId === id) {
    state.editingId = "";
    els.noteText.value = "";
  }
  await saveState();
  await notifyActiveTab();
  render();
  showToast("Заметка удалена");
}

async function copyNote(note) {
  await navigator.clipboard.writeText(note.text);
  showToast("Текст скопирован");
}

async function copyCurrentNote() {
  const note = currentNote();

  if (!note) {
    showToast("Для текущей страницы заметки нет");
    return;
  }

  await copyNote(note);
}

async function notifyActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !isDirectUrl(tab.url || "")) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "DIRECT_NOTES_STATE_UPDATED" }).catch(() => {});
}

function currentTypedContext() {
  const context = state.currentContext;

  if (!context) {
    return null;
  }

  const typed = state.activeType === "adgroup" ? context.adgroup : context.campaign;
  return typed ? normalizeContextItem(typed, state.activeType, context.url) : null;
}

function currentNote() {
  const context = currentTypedContext();
  return context ? state.notes.find((note) => note.key === context.key) || null : null;
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

function noteFieldsFromContext(context) {
  return {
    type: context.type,
    key: context.key,
    entityId: context.id,
    name: context.name,
    url: context.url
  };
}

function normalizeNote(note) {
  const type = note?.type === "adgroup" ? "adgroup" : "campaign";
  const item = normalizeContextItem({
    id: note?.entityId,
    name: note?.name,
    fallback: note?.url
  }, type, note?.url || "");

  return {
    id: note?.id || crypto.randomUUID(),
    type,
    key: item.key,
    entityId: item.id,
    name: item.name,
    url: String(note?.url || ""),
    text: String(note?.text || "").trim(),
    createdAt: note?.createdAt || note?.updatedAt || new Date().toISOString(),
    updatedAt: note?.updatedAt || note?.createdAt || new Date().toISOString()
  };
}

function normalizeContext(context) {
  if (!context || typeof context !== "object") {
    return null;
  }

  const url = String(context.url || "");
  const campaign = normalizeContextItem(context.campaign || {}, "campaign", url);
  const adgroup = normalizeContextItem(context.adgroup || {}, "adgroup", url);

  return {
    url,
    title: cleanText(context.title),
    campaign: campaign.key ? campaign : null,
    adgroup: adgroup.key ? adgroup : null
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

function fallbackContextFromUrl(url) {
  const campaignId = idFromUrl(url, ["campaignId", "cid", "campaign_id"]) || pathId(url, /campaigns?\/(\d+)/i);
  const adgroupId = idFromUrl(url, ["adGroupId", "adgroupId", "groupId", "adgroup_id"]) || pathId(url, /(?:adgroups?|groups?)\/(\d+)/i);

  return {
    url,
    title: "",
    campaign: {
      id: campaignId,
      name: campaignId ? `Кампания ${campaignId}` : ""
    },
    adgroup: {
      id: adgroupId,
      name: adgroupId ? `Группа ${adgroupId}` : ""
    }
  };
}

function bestTypeForContext(context) {
  if (context?.adgroup?.key) {
    return "adgroup";
  }

  if (context?.campaign?.key) {
    return "campaign";
  }

  return "";
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

function pathId(url, pattern) {
  try {
    return cleanId(pattern.exec(new URL(url).pathname)?.[1]);
  } catch (error) {
    return "";
  }
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

function normalizeUrlKey(value) {
  try {
    const url = new URL(value);
    return normalizeName(`${url.pathname}${url.search}`);
  } catch (error) {
    return normalizeName(value);
  }
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
