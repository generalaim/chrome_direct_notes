const STORAGE_KEY = "directNotesWidget";
const NOTE_TYPES = {
  campaign: { label: "Кампании", one: "Кампания", empty: "Заметок к кампаниям пока нет." },
  adgroup: { label: "Группы", one: "Группа", empty: "Заметок к группам пока нет." },
  ad: { label: "Объявления", one: "Объявление", empty: "Заметок к объявлениям пока нет." }
};

const state = {
  enabled: true,
  activeType: "campaign",
  loginScope: "current",
  selectedLogin: "",
  showPageCounter: true,
  notes: [],
  pageContext: emptyPageContext(),
  isDirectPage: false,
  scanRunning: false,
  scanMessage: "Скан отчета еще не запускался."
};

let toastTimer = null;
let lastCount = null;
let pageStatusTimer = null;

const els = {
  notesCount: document.getElementById("notesCount"),
  currentLoginScopeButton: document.getElementById("currentLoginScopeButton"),
  allLoginScopeButton: document.getElementById("allLoginScopeButton"),
  selectedLoginScopeButton: document.getElementById("selectedLoginScopeButton"),
  loginSelect: document.getElementById("loginSelect"),
  campaignModeButton: document.getElementById("campaignModeButton"),
  adgroupModeButton: document.getElementById("adgroupModeButton"),
  adModeButton: document.getElementById("adModeButton"),
  enabledToggle: document.getElementById("enabledToggle"),
  pageCounterToggle: document.getElementById("pageCounterToggle"),
  pageStatus: document.getElementById("pageStatus"),
  currentBadge: document.getElementById("currentBadge"),
  currentSubtitle: document.getElementById("currentSubtitle"),
  loginStatus: document.getElementById("loginStatus"),
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

  [els.currentLoginScopeButton, els.allLoginScopeButton, els.selectedLoginScopeButton].forEach((button) => {
    button.addEventListener("click", async () => {
      state.loginScope = normalizeLoginScope(button.dataset.loginScope);
      ensureSelectedLogin();
      await saveState();
      render();
    });
  });

  els.loginSelect.addEventListener("change", async () => {
    state.selectedLogin = cleanLogin(els.loginSelect.value);

    if (state.selectedLogin) {
      state.loginScope = "selected";
    }

    await saveState();
    render();
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

    state.notes = state.notes.filter((note) => {
      const normalized = normalizeNote(note);
      return normalized.type !== state.activeType || !noteMatchesCurrentLogin(normalized);
    });
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
  state.loginScope = normalizeLoginScope(saved.loginScope);
  state.selectedLogin = cleanLogin(saved.selectedLogin);
  state.showPageCounter = saved.showPageCounter !== false;
  state.notes = Array.isArray(saved.notes) ? normalizeNotes(saved.notes) : [];
}

async function saveState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      enabled: state.enabled,
      activeType: state.activeType,
      loginScope: state.loginScope,
      selectedLogin: state.selectedLogin,
      showPageCounter: state.showPageCounter,
      notes: normalizeNotes(state.notes)
    }
  });
}

async function updatePageStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isDirect = isDirectUrl(tab?.url || "");
  state.isDirectPage = isDirect;
  state.pageContext = isDirect && tab?.id
    ? await getPageContext(tab.id)
    : emptyPageContext();
  renderPageStatus();
}

function renderPageStatus() {
  const pageTotal = pageKeySet().size;

  els.pageStatus.textContent = state.isDirectPage
    ? "Страница Директа найдена. Плашка появляется при наведении."
    : "Открой страницу Яндекс.Директа.";
  els.currentBadge.textContent = state.isDirectPage ? `${pageTotal} на стр.` : "нет";
  els.currentBadge.classList.toggle("is-found", state.isDirectPage);
  els.currentSubtitle.textContent = state.isDirectPage
    ? pageContextText()
    : "Виджет не добавляет элементы и не слушает клики вне direct.yandex.ru.";
  els.loginStatus.textContent = state.isDirectPage
    ? state.pageContext.login || "логин ?"
    : "логин ?";
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
  renderPageStatus();
  renderTabs();
  renderScanState();
  renderList();
}

function renderHeader() {
  renderLoginControls();
  const count = scopedNotes().length;
  els.enabledToggle.checked = state.enabled;
  els.pageCounterToggle.checked = state.showPageCounter;
  els.notesCount.textContent = String(count);

  if (lastCount !== null && count > lastCount) {
    bump(els.notesCount, count - lastCount);
  }

  lastCount = count;
}

function renderLoginControls() {
  const logins = knownLogins();
  ensureSelectedLogin(logins);

  els.currentLoginScopeButton.classList.toggle("is-active", state.loginScope === "current");
  els.allLoginScopeButton.classList.toggle("is-active", state.loginScope === "all");
  els.selectedLoginScopeButton.classList.toggle("is-active", state.loginScope === "selected");
  els.currentLoginScopeButton.disabled = !state.pageContext.login;
  els.selectedLoginScopeButton.disabled = !logins.length;
  els.loginSelect.disabled = !logins.length;
  els.loginSelect.classList.toggle("is-active", state.loginScope === "selected");
  els.loginSelect.textContent = "";

  if (!logins.length) {
    els.loginSelect.append(selectOption("", "Логинов пока нет"));
    return;
  }

  logins.forEach((login) => {
    els.loginSelect.append(selectOption(login, login));
  });

  els.loginSelect.value = logins.includes(state.selectedLogin) ? state.selectedLogin : logins[0];
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
    card.addEventListener("click", (event) => {
      if (!event.target.closest("button")) {
        openNoteOnPage(note);
      }
    });

    const head = document.createElement("div");
    head.className = "note-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "note-title-wrap";

    const title = document.createElement("div");
    title.className = "note-title";
    title.textContent = noteTitleText(note);

    const meta = document.createElement("div");
    meta.className = "note-meta";
    noteMetaRows(note).forEach((row) => {
      const metaRow = document.createElement("div");
      metaRow.className = "note-meta-row";

      const label = document.createElement("span");
      label.className = "note-meta-label";
      label.textContent = row.label;

      const value = document.createElement("span");
      value.className = "note-meta-value";
      value.textContent = row.value;

      metaRow.append(label, value);
      meta.append(metaRow);
    });

    titleWrap.append(title, meta);

    const type = document.createElement("span");
    type.className = "note-type";
    type.textContent = isOnPage ? "На странице" : NOTE_TYPES[note.type].one;

    const age = document.createElement("span");
    age.className = `note-age ${noteAgeClass(note)}`;
    age.title = `Создана: ${formatDate(note.createdAt || note.updatedAt)}`;
    age.textContent = noteAgeText(note);

    const badges = document.createElement("div");
    badges.className = "note-badges";
    badges.append(age, type);

    head.append(titleWrap, badges);

    const actions = document.createElement("div");
    actions.className = "card-actions compact-actions";

    const text = document.createElement("p");
    text.className = "note-text";
    text.textContent = note.text;

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

async function openNoteOnPage(note) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !isDirectUrl(tab.url || "")) {
    showToast("Открой страницу Директа");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "DIRECT_NOTES_OPEN_NOTE",
      note
    });

    if (response?.ok === false) {
      showToast(response.message || "Не удалось открыть заметку");
      return;
    }

    showToast("Открыл заметку на странице");
  } catch (error) {
    showToast("Обнови страницу Директа");
  }
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

    state.isDirectPage = true;
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
  return scopedNotes().filter((note) => note.type === state.activeType);
}

function scopedNotes() {
  return state.notes.filter(noteMatchesCurrentLogin);
}

function noteMatchesCurrentLogin(note) {
  if (state.loginScope === "all") {
    return true;
  }

  const login = activeLoginFilter();

  if (!login) {
    return true;
  }

  return note.login === login;
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
  const keys = pageKeySet();
  return keys.has(note.key) || Boolean(note.legacyKey && keys.has(note.legacyKey));
}

function pageKeySet() {
  if (!pageContextMatchesScope()) {
    return new Set();
  }

  const login = activeLoginFilter();
  const keys = !login
    ? state.pageContext.keys
    : state.pageContext.keys.filter((key) => key.startsWith(`${login}|`) || !key.includes("|"));

  return new Set(keys);
}

function pageKeysForType(type) {
  return new Set([...pageKeySet()].filter((key) => key.startsWith(`${type}:`) || key.includes(`|${type}:`)));
}

function pageContextMatchesScope() {
  if (state.loginScope === "all") {
    return true;
  }

  const login = activeLoginFilter();

  if (!login || !state.pageContext.login) {
    return true;
  }

  return login === state.pageContext.login;
}

function activeLoginFilter() {
  if (state.loginScope === "selected") {
    return state.selectedLogin;
  }

  if (state.loginScope === "current") {
    return state.pageContext.login;
  }

  return "";
}

function knownLogins() {
  return [...new Set(state.notes.map((note) => cleanLogin(note.login)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ru"));
}

function ensureSelectedLogin(logins = knownLogins()) {
  if (logins.includes(state.selectedLogin)) {
    return;
  }

  if (state.pageContext.login && logins.includes(state.pageContext.login)) {
    state.selectedLogin = state.pageContext.login;
    return;
  }

  state.selectedLogin = logins[0] || "";
}

function selectOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function pageContextText() {
  const keys = pageKeySet();
  const total = keys.size;

  if (!total) {
    return "На этой странице сохраненных заметок пока не найдено.";
  }

  const parts = [];
  const byType = pageTypeCounts(keys);

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

function pageTypeCounts(keys = pageKeySet()) {
  const byType = {
    campaign: 0,
    adgroup: 0,
    ad: 0
  };

  keys.forEach((key) => {
    const type = normalizeType(String(key).split("|").pop().split(":")[0]);
    byType[type] += 1;
  });

  return byType;
}

function emptyPageContext() {
  return {
    keys: [],
    total: 0,
    login: "",
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
  normalized.login = cleanLogin(context?.login);
  normalized.byType = {
    campaign: Number(context?.byType?.campaign || 0),
    adgroup: Number(context?.byType?.adgroup || 0),
    ad: Number(context?.byType?.ad || 0)
  };

  if (!normalized.byType.campaign && !normalized.byType.adgroup && !normalized.byType.ad) {
    normalized.keys.forEach((key) => {
      const type = normalizeType(String(key).split("|").pop().split(":")[0]);
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

function noteMetaRows(note) {
  const rows = [
    {
      label: "Логин:",
      value: note.login || "без логина"
    }
  ];

  if (note.name && note.name !== note.entityId) {
    rows.push({
      label: "Название:",
      value: note.name
    });
  }

  rows.push({
    label: "Редактирование:",
    value: formatDate(note.updatedAt || note.createdAt)
  });

  return rows;
}

function noteTitleText(note) {
  if (note.entityId) {
    return note.entityId;
  }

  if (note.name) {
    return note.name;
  }

  return `${NOTE_TYPES[note.type].one} без номера`;
}

function noteAgeText(note) {
  const days = noteAgeDays(note);
  return `${days} ${dayWord(days)}`;
}

function noteAgeClass(note) {
  const days = noteAgeDays(note);

  if (days >= 15) {
    return "is-old";
  }

  if (days >= 8) {
    return "is-watch";
  }

  return "is-fresh";
}

function noteAgeDays(note) {
  const created = new Date(note.createdAt || note.updatedAt || 0);

  if (Number.isNaN(created.getTime())) {
    return 0;
  }

  return Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400000));
}

function dayWord(value) {
  const mod10 = value % 10;
  const mod100 = value % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return "день";
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "дня";
  }

  return "дней";
}

function normalizeType(value) {
  return ["campaign", "adgroup", "ad"].includes(value) ? value : "campaign";
}

function normalizeLoginScope(value) {
  return ["all", "selected"].includes(value) ? value : "current";
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
