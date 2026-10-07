import { store } from './store.js';
import {
  todayYMD,
  addDays,
  diffDays,
  endOfWeekYMD,
  startOfNextWeekYMD,
  formatDueLabel,
} from './dateutil.js';
import { parseTaskText } from './parser.js';
import { isVoiceSupported, createRecognizer } from './voice.js';
import { gcal, authorizedFetch } from './gcal.js';
import { drive } from './drive.js';
import { createSync } from './sync.js';
import { importLocalInbox, importDriveInbox, LOCAL_INBOX_KEY } from './inbox.js';

const PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };
const PRIORITY_ORDER = { high: 0, mid: 1, low: 2 };
const REPEAT_LABEL = { none: '繰り返しなし', daily: '毎日', weekly: '毎週', monthly: '毎月' };

const GCAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M7 2h2v2h6V2h2v2h3a1 1 0 0 1 1 1v15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1h3V2Zm12 7H5v11h14V9ZM7 11h4v4H7v-4Z"/></svg>';

const el = {
  form: document.getElementById('task-form'),
  input: document.getElementById('task-input'),
  mic: document.getElementById('mic-btn'),
  chips: document.getElementById('chips'),
  voiceStatus: document.getElementById('voice-status'),
  tabs: document.querySelectorAll('.tab'),
  list: document.getElementById('task-list'),
  empty: document.getElementById('empty'),
  popover: document.getElementById('popover'),
  scrim: document.getElementById('scrim'),
  settingsBtn: document.getElementById('settings-btn'),
  settings: document.getElementById('settings-dialog'),
  categoryList: document.getElementById('category-list'),
  addCategoryBtn: document.getElementById('add-category-btn'),
  defaultCategory: document.getElementById('default-category'),
  gcalClientId: document.getElementById('gcal-client-id'),
  gcalCalendarId: document.getElementById('gcal-calendar-id'),
  gcalSyncMode: document.getElementById('gcal-sync-mode'),
  gcalSignIn: document.getElementById('gcal-signin-btn'),
  gcalSyncAll: document.getElementById('gcal-sync-all-btn'),
  gcalStatus: document.getElementById('gcal-status'),
  driveStatus: document.getElementById('drive-status'),
  driveSyncNow: document.getElementById('drive-sync-now'),
  voiceAutoAdd: document.getElementById('voice-auto-add'),
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFile: document.getElementById('import-file'),
  toasts: document.getElementById('toasts'),
};

const ui = {
  filter: 'today',
  overrides: { due: undefined, time: undefined, priority: undefined, categoryId: undefined, repeat: undefined },
  parsed: null,
  editingId: null,
  recognizer: null,
  listening: false,
  micGranted: false,
  lastSyncErrorToast: '',
};

let sync = null;

function today() {
  return todayYMD();
}

function categoryById(id) {
  return store.getCategories().find((c) => c.id === id) || null;
}

function showToast(message, { actionLabel, onAction, duration = 5000, error = false } = {}) {
  const toast = document.createElement('div');
  toast.className = `toast${error ? ' is-error' : ''}`;
  toast.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = message;
  toast.append(msg);
  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    toast.remove();
  };
  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      dismiss();
      onAction();
    });
    toast.append(btn);
  }
  el.toasts.append(toast);
  raiseToasts();
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

function raiseToasts() {
  if (typeof el.toasts.showPopover !== 'function') return;
  try {
    if (el.toasts.matches(':popover-open')) el.toasts.hidePopover();
    el.toasts.showPopover();
  } catch {
    el.toasts.removeAttribute('popover');
  }
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function syncMode() {
  return store.getSettings().gcalSyncMode || 'confirm';
}

function gcalReady() {
  return gcal.isConfigured() && gcal.isSignedIn();
}

function canAutoSync(task) {
  if (!gcalReady()) return false;
  if (syncMode() === 'auto') return true;
  return Boolean(task.gcalEventId);
}

function offerCalendarAdd(task) {
  if (!task || !task.due || task.done) return;
  if (syncMode() === 'auto') {
    syncTask(task);
    return;
  }
  if (syncMode() !== 'confirm' || !gcal.isConfigured()) return;
  showToast(`「${task.title}」をカレンダーに追加しますか？`, {
    actionLabel: '追加',
    duration: 8000,
    onAction: () => onGcalButton(task.id),
  });
}

function setGcalFields(id, fields) {
  if (store.getTasks().some((t) => t.id === id)) store.updateTask(id, fields);
}

async function removeEventFor(task) {
  if (!task.gcalEventId) return;
  await gcal.deleteEvent(task.gcalEventId);
  setGcalFields(task.id, { gcalEventId: null, gcalSyncedDue: null, gcalSyncedTime: null });
}

async function upsertEventFor(task) {
  const eventId = await gcal.upsertEvent(task, categoryById(task.categoryId));
  setGcalFields(task.id, { gcalEventId: eventId, gcalSyncedDue: task.due, gcalSyncedTime: task.time || null });
}

async function syncTask(task, { force = false } = {}) {
  if (!task) return;
  if (!force && !canAutoSync(task)) return;
  if (force && !gcal.isSignedIn()) return;
  try {
    if (task.done || !task.due) {
      await removeEventFor(task);
    } else {
      await upsertEventFor(task);
    }
  } catch (err) {
    console.error(err);
    showToast(`カレンダー同期に失敗しました: ${errorMessage(err)}`, { error: true });
  }
}

async function deleteEventQuietly(task) {
  if (!task.gcalEventId || !gcal.isSignedIn()) return;
  try {
    await gcal.deleteEvent(task.gcalEventId);
  } catch (err) {
    console.error(err);
    showToast(`カレンダーの予定削除に失敗しました: ${errorMessage(err)}`, { error: true });
  }
}

function isSynced(task) {
  return Boolean(task.gcalEventId) && task.gcalSyncedDue === task.due && (task.gcalSyncedTime || null) === (task.time || null);
}

function unsyncedTasks() {
  return store.getTasks().filter((t) => !t.done && t.due && !isSynced(t));
}

async function syncAllUnsynced() {
  if (!gcal.isConfigured()) {
    showToast('クライアントIDを設定してください', { error: true });
    return;
  }
  try {
    if (!gcal.isSignedIn()) await gcal.signIn();
  } catch (err) {
    showToast(`サインインに失敗しました: ${errorMessage(err)}`, { error: true });
    return;
  }
  const targets = unsyncedTasks();
  if (targets.length === 0) {
    showToast('未同期のタスクはありません');
    return;
  }
  let ok = 0;
  let ng = 0;
  for (const task of targets) {
    try {
      await upsertEventFor(task);
      ok += 1;
    } catch (err) {
      console.error(err);
      ng += 1;
    }
  }
  showToast(ng === 0 ? `${ok}件を同期しました` : `${ok}件を同期、${ng}件が失敗しました`, { error: ng > 0 });
}

function parseInput() {
  const text = el.input.value.trim();
  if (!text) {
    ui.parsed = null;
    return;
  }
  try {
    ui.parsed = parseTaskText(text, { categories: store.getCategories(), today: today() });
  } catch (err) {
    console.error(err);
    ui.parsed = { title: text, due: null, time: null, priority: null, repeat: null, categoryId: null, matched: {} };
  }
}

function effectiveDraft() {
  const p = ui.parsed;
  const o = ui.overrides;
  const settings = store.getSettings();
  const time = o.time !== undefined ? o.time : (p && p.time ? p.time : null);
  const parsedDue = p ? p.due : null;
  return {
    title: p ? p.title : '',
    due: o.due !== undefined ? o.due : (parsedDue || (time ? today() : null)),
    time,
    priority: o.priority !== undefined ? o.priority : (p && p.priority ? p.priority : 'mid'),
    categoryId: o.categoryId !== undefined ? o.categoryId : (p && p.categoryId ? p.categoryId : settings.defaultCategoryId),
    repeat: o.repeat !== undefined ? o.repeat : (p && p.repeat ? p.repeat : 'none'),
  };
}

function renderChips() {
  const d = effectiveDraft();
  const t = today();
  for (const chip of el.chips.querySelectorAll('.chip')) {
    const kind = chip.dataset.chip;
    chip.replaceChildren();
    if (kind === 'due') {
      chip.textContent = formatDueLabel(d.due, t);
      chip.classList.toggle('is-set', Boolean(d.due));
    } else if (kind === 'time') {
      chip.textContent = d.time ? formatTimeLabel(d.time) : '時刻なし';
      chip.classList.toggle('is-set', Boolean(d.time));
    } else if (kind === 'priority') {
      chip.textContent = `優先度 ${PRIORITY_LABEL[d.priority]}`;
      chip.dataset.value = d.priority;
      chip.classList.toggle('is-set', d.priority !== 'mid');
    } else if (kind === 'category') {
      const cat = categoryById(d.categoryId);
      if (cat) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        chip.append(dot, document.createTextNode(cat.name));
        chip.style.setProperty('--cat-color', cat.color);
        chip.classList.add('is-set');
      } else {
        chip.textContent = 'カテゴリなし';
        chip.style.removeProperty('--cat-color');
        chip.classList.remove('is-set');
      }
    } else if (kind === 'repeat') {
      chip.textContent = d.repeat === 'none' ? REPEAT_LABEL.none : `↻ ${REPEAT_LABEL[d.repeat]}`;
      chip.classList.toggle('is-set', d.repeat !== 'none');
    }
  }
}

function resetDraft() {
  el.input.value = '';
  ui.parsed = null;
  ui.overrides = { due: undefined, time: undefined, priority: undefined, categoryId: undefined, repeat: undefined };
  renderChips();
}

function addFromDraft() {
  const raw = el.input.value.trim();
  if (!raw) {
    el.input.focus();
    return null;
  }
  parseInput();
  const d = effectiveDraft();
  const task = store.addTask({
    title: d.title || raw,
    due: d.due,
    time: d.time,
    priority: d.priority,
    categoryId: d.categoryId,
    repeat: d.repeat,
  });
  resetDraft();
  offerCalendarAdd(task);
  return task;
}

function closePopover() {
  el.popover.hidden = true;
  el.scrim.hidden = true;
  el.popover.replaceChildren();
}

function positionPopover(anchor) {
  const rect = anchor.getBoundingClientRect();
  const pop = el.popover;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = Math.min(rect.left, vw - pw - 16);
  left = Math.max(16, left);
  let top = rect.bottom + 6;
  if (top + ph > vh - 16) top = Math.max(16, rect.top - ph - 6);
  pop.style.setProperty('--pop-top', `${Math.round(top)}px`);
  pop.style.setProperty('--pop-left', `${Math.round(left)}px`);
}

function openPopover(anchor, title, build) {
  el.popover.replaceChildren();
  const h = document.createElement('p');
  h.className = 'popover-title';
  h.textContent = title;
  el.popover.append(h);
  build(el.popover);
  el.popover.hidden = false;
  el.scrim.hidden = false;
  positionPopover(anchor);
  const first = el.popover.querySelector('button, input');
  if (first) first.focus({ preventScroll: true });
}

function makeOption(label, { selected = false, color = null, sub = null, onSelect }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `option${selected ? ' is-selected' : ''}`;
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    btn.style.setProperty('--cat-color', color);
    btn.append(dot);
  }
  btn.append(document.createTextNode(label));
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    btn.append(s);
  }
  btn.addEventListener('click', () => {
    closePopover();
    onSelect();
  });
  return btn;
}

function dueOptions(current) {
  const t = today();
  const items = [
    { label: '今日', value: t },
    { label: '明日', value: addDays(t, 1) },
    { label: '明後日', value: addDays(t, 2) },
    { label: '今週', value: endOfWeekYMD(t) },
    { label: '来週', value: startOfNextWeekYMD(t) },
  ];
  return items.map((it) => ({ ...it, sub: shortMD(it.value), selected: current === it.value }));
}

function shortMD(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}`;
}

const TIME_PRESETS = ['09:00', '10:00', '12:00', '13:00', '15:00', '17:00', '18:00'];

function formatTimeLabel(hm) {
  const [h, m] = hm.split(':');
  return `${Number(h)}:${m}`;
}

function openTimePopover(anchor, current, onPick) {
  openPopover(anchor, '時刻（カレンダーには30分の予定として登録）', (root) => {
    for (const hm of TIME_PRESETS) {
      root.append(makeOption(formatTimeLabel(hm), { selected: current === hm, onSelect: () => onPick(hm) }));
    }
    const row = document.createElement('div');
    row.className = 'option-date';
    const input = document.createElement('input');
    input.type = 'time';
    input.step = 300;
    input.setAttribute('aria-label', '時刻指定');
    input.value = current || '';
    input.addEventListener('change', () => {
      if (!input.value) return;
      closePopover();
      onPick(input.value.slice(0, 5));
    });
    row.append(input);
    root.append(row);
    root.append(makeOption('時刻なし（終日）', { selected: !current, onSelect: () => onPick(null) }));
  });
}

function openDuePopover(anchor, current, onPick) {
  openPopover(anchor, '期限', (root) => {
    for (const it of dueOptions(current)) {
      root.append(makeOption(it.label, { selected: it.selected, sub: it.sub, onSelect: () => onPick(it.value) }));
    }
    const dateRow = document.createElement('div');
    dateRow.className = 'option-date';
    const input = document.createElement('input');
    input.type = 'date';
    input.setAttribute('aria-label', '日付指定');
    input.value = current || '';
    input.addEventListener('change', () => {
      if (!input.value) return;
      closePopover();
      onPick(input.value);
    });
    dateRow.append(input);
    root.append(dateRow);
    root.append(makeOption('期限なし', { selected: !current, onSelect: () => onPick(null) }));
  });
}

function openPriorityPopover(anchor, current, onPick) {
  openPopover(anchor, '優先度', (root) => {
    for (const p of ['high', 'mid', 'low']) {
      root.append(makeOption(PRIORITY_LABEL[p], { selected: current === p, onSelect: () => onPick(p) }));
    }
  });
}

function openCategoryPopover(anchor, current, onPick) {
  openPopover(anchor, 'カテゴリ', (root) => {
    for (const c of store.getCategories()) {
      root.append(makeOption(c.name, { selected: current === c.id, color: c.color, onSelect: () => onPick(c.id) }));
    }
    root.append(makeOption('カテゴリなし', { selected: !current, onSelect: () => onPick(null) }));
  });
}

function openRepeatPopover(anchor, current, onPick) {
  openPopover(anchor, '繰り返し', (root) => {
    for (const r of ['none', 'daily', 'weekly', 'monthly']) {
      root.append(makeOption(r === 'none' ? 'なし' : REPEAT_LABEL[r], { selected: current === r, onSelect: () => onPick(r) }));
    }
  });
}

function openMemoPopover(anchor, task) {
  let textarea = null;
  openPopover(anchor, 'メモ', (root) => {
    textarea = document.createElement('textarea');
    textarea.className = 'memo-edit';
    textarea.rows = 4;
    textarea.value = task.memo || '';
    textarea.setAttribute('aria-label', 'メモを編集');
    const save = () => {
      closePopover();
      if (textarea.value.trim() !== (task.memo || '')) store.updateTask(task.id, { memo: textarea.value });
    };
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
    const row = document.createElement('div');
    row.className = 'btn-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.textContent = '保存';
    btn.addEventListener('click', save);
    row.append(btn);
    root.append(textarea, row);
  });
  textarea.focus({ preventScroll: true });
}

function onChipClick(e) {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  parseInput();
  const d = effectiveDraft();
  const kind = chip.dataset.chip;
  const set = (key) => (value) => {
    ui.overrides[key] = value;
    renderChips();
    el.input.focus({ preventScroll: true });
  };
  if (kind === 'due') openDuePopover(chip, d.due, set('due'));
  else if (kind === 'time') openTimePopover(chip, d.time, set('time'));
  else if (kind === 'priority') openPriorityPopover(chip, d.priority, set('priority'));
  else if (kind === 'category') openCategoryPopover(chip, d.categoryId, set('categoryId'));
  else if (kind === 'repeat') openRepeatPopover(chip, d.repeat, set('repeat'));
}

function updateTaskAndSync(id, patch) {
  const task = store.updateTask(id, patch);
  if (task) syncTask(task);
  return task;
}

function filterTasks(tasks) {
  const t = today();
  switch (ui.filter) {
    case 'today':
      return tasks.filter((x) => !x.done && x.due && x.due <= t);
    case 'upcoming':
      return tasks.filter((x) => !x.done && (!x.due || x.due > t));
    case 'done':
      return tasks.filter((x) => x.done);
    default:
      return tasks.filter((x) => !x.done);
  }
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.due !== b.due) {
      if (a.due === null) return 1;
      if (b.due === null) return -1;
      if (a.due < b.due) return -1;
      if (a.due > b.due) return 1;
    }
    const pa = PRIORITY_ORDER[a.priority];
    const pb = PRIORITY_ORDER[b.priority];
    if (pa !== pb) return pa - pb;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

function groupKey(task, t) {
  if (!task.due) return 'none';
  const diff = diffDays(t, task.due);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (task.due <= endOfWeekYMD(t)) return 'week';
  return 'later';
}

const GROUP_LABEL = {
  overdue: '期限切れ',
  today: '今日',
  tomorrow: '明日',
  week: '今週',
  later: '以降',
  none: '期限なし',
};
const GROUP_ORDER = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'];

function dueButtonClass(task, t) {
  if (!task.due) return '';
  const diff = diffDays(t, task.due);
  if (diff < 0) return ' is-overdue';
  if (diff === 0) return ' is-today';
  return '';
}

function iconButton(className, label, inner) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${className}`;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  if (inner.startsWith('<svg')) btn.innerHTML = inner;
  else btn.textContent = inner;
  return btn;
}

function renderTask(task, t, editingValue = null) {
  const li = document.createElement('li');
  li.className = `task${task.done ? ' is-done' : ''}`;
  li.dataset.id = task.id;

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.setAttribute('aria-label', task.done ? '未完了に戻す' : '完了にする');
  check.textContent = task.done ? '✓' : '◯';
  check.addEventListener('click', () => onToggleDone(task.id));

  const main = document.createElement('div');
  main.className = 'task-main';

  if (ui.editingId === task.id) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-edit';
    input.value = editingValue !== null ? editingValue : task.title;
    input.setAttribute('aria-label', 'タイトルを編集');
    let committed = false;
    const commit = () => {
      if (committed || !input.isConnected) return;
      committed = true;
      ui.editingId = null;
      const v = input.value.trim();
      if (v && v !== task.title) updateTaskAndSync(task.id, { title: v });
      else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        committed = true;
        ui.editingId = null;
        render();
      }
    });
    input.addEventListener('blur', commit);
    main.append(input);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  } else {
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'title';
    title.textContent = task.title;
    title.title = 'タップして編集';
    title.addEventListener('click', () => {
      ui.editingId = task.id;
      render();
    });
    main.append(title);
  }

  if (task.memo) {
    const memo = document.createElement('button');
    memo.type = 'button';
    memo.className = 'memo';
    memo.textContent = task.memo;
    memo.setAttribute('aria-label', `メモ: ${task.memo}`);
    memo.addEventListener('click', () => openMemoPopover(memo, task));
    main.append(memo);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';

  const due = document.createElement('button');
  due.type = 'button';
  due.className = `meta-btn due${dueButtonClass(task, t)}`;
  due.textContent = formatDueLabel(task.due, t);
  due.setAttribute('aria-label', `期限: ${formatDueLabel(task.due, t)}`);
  due.addEventListener('click', () => openDuePopover(due, task.due, (v) => updateTaskAndSync(task.id, { due: v })));
  meta.append(due);

  const time = document.createElement('button');
  time.type = 'button';
  time.className = `meta-btn time${task.time ? ' is-set' : ''}`;
  time.textContent = task.time ? formatTimeLabel(task.time) : '時刻';
  time.setAttribute('aria-label', `時刻: ${task.time ? formatTimeLabel(task.time) : 'なし'}`);
  time.addEventListener('click', () =>
    openTimePopover(time, task.time, (v) => updateTaskAndSync(task.id, { time: v, due: task.due || (v ? today() : null) })),
  );
  meta.append(time);

  const pri = document.createElement('button');
  pri.type = 'button';
  pri.className = 'meta-btn priority';
  pri.dataset.value = task.priority;
  pri.textContent = PRIORITY_LABEL[task.priority];
  pri.setAttribute('aria-label', `優先度: ${PRIORITY_LABEL[task.priority]}`);
  pri.addEventListener('click', () => openPriorityPopover(pri, task.priority, (v) => updateTaskAndSync(task.id, { priority: v })));
  meta.append(pri);

  const cat = document.createElement('button');
  cat.type = 'button';
  const category = categoryById(task.categoryId);
  cat.className = `meta-btn category${category ? ' is-set' : ''}`;
  const dot = document.createElement('span');
  dot.className = 'dot';
  cat.append(dot, document.createTextNode(category ? category.name : 'カテゴリなし'));
  if (category) cat.style.setProperty('--cat-color', category.color);
  cat.setAttribute('aria-label', `カテゴリ: ${category ? category.name : 'なし'}`);
  cat.addEventListener('click', () => openCategoryPopover(cat, task.categoryId, (v) => updateTaskAndSync(task.id, { categoryId: v })));
  meta.append(cat);

  const rep = document.createElement('button');
  rep.type = 'button';
  rep.className = 'meta-btn repeat';
  rep.textContent = task.repeat === 'none' ? '↻' : `↻ ${REPEAT_LABEL[task.repeat]}`;
  rep.setAttribute('aria-label', `繰り返し: ${task.repeat === 'none' ? 'なし' : REPEAT_LABEL[task.repeat]}`);
  rep.addEventListener('click', () => openRepeatPopover(rep, task.repeat, (v) => updateTaskAndSync(task.id, { repeat: v })));
  meta.append(rep);

  if (!task.memo) {
    const memoBtn = document.createElement('button');
    memoBtn.type = 'button';
    memoBtn.className = 'meta-btn memo-add';
    memoBtn.textContent = 'メモ';
    memoBtn.setAttribute('aria-label', 'メモを追加');
    memoBtn.addEventListener('click', () => openMemoPopover(memoBtn, task));
    meta.append(memoBtn);
  }

  main.append(meta);

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  if (task.due && !task.done) {
    const synced = isSynced(task);
    const g = iconButton(`gcal${synced ? ' is-synced' : ''}`, synced ? 'カレンダー同期済み' : 'カレンダーに登録', GCAL_ICON);
    g.addEventListener('click', () => onGcalButton(task.id));
    actions.append(g);
  }

  const del = iconButton('delete', '削除', '×');
  del.addEventListener('click', () => onDelete(task.id));
  actions.append(del);

  li.append(check, main, actions);
  return li;
}

function render() {
  const t = today();
  const tasks = sortTasks(filterTasks(store.getTasks()));
  const editInput = el.list.querySelector('.title-edit');
  const editingValue = editInput ? editInput.value : null;
  const row = (task) => renderTask(task, t, ui.editingId === task.id ? editingValue : null);
  el.list.replaceChildren();
  el.empty.hidden = tasks.length > 0;
  if (tasks.length === 0) {
    el.empty.textContent = ui.filter === 'done'
      ? '完了したタスクはありません'
      : store.getTasks().length === 0
        ? 'マイクを押して話すか、入力してください'
        : 'このタブに表示するタスクはありません';
    return;
  }
  if (ui.filter === 'done') {
    const ul = document.createElement('ul');
    ul.className = 'task-list';
    for (const task of [...tasks].sort((a, b) => ((a.completedAt || '') < (b.completedAt || '') ? 1 : -1))) {
      ul.append(row(task));
    }
    el.list.append(ul);
    return;
  }
  const groups = new Map();
  for (const task of tasks) {
    const key = groupKey(task, t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  for (const key of GROUP_ORDER) {
    const items = groups.get(key);
    if (!items) continue;
    const section = document.createElement('section');
    section.className = 'group';
    const h = document.createElement('h2');
    h.className = `group-title${key === 'overdue' ? ' is-overdue' : ''}`;
    h.textContent = `${GROUP_LABEL[key]}（${items.length}）`;
    const ul = document.createElement('ul');
    ul.className = 'task-list';
    for (const task of items) ul.append(row(task));
    section.append(h, ul);
    el.list.append(section);
  }
}

function onToggleDone(id) {
  const { task, next } = store.toggleDone(id);
  if (!task) return;
  syncTask(task);
  if (next) offerCalendarAdd(next);
}

function onDelete(id) {
  const task = store.getTasks().find((t) => t.id === id);
  if (!task) return;
  store.deleteTask(id);
  deleteEventQuietly(task);
  showToast('削除しました', {
    actionLabel: '元に戻す',
    onAction: () => {
      store.importJSON(
        { version: 1, tasks: [{ ...task, gcalEventId: null, gcalSyncedDue: null, gcalSyncedTime: null }], categories: store.getCategories() },
        { merge: true },
      );
      const restored = store.getTasks().find((t) => t.id === id);
      if (restored) syncTask(restored);
    },
  });
}

async function onGcalButton(id) {
  const task = store.getTasks().find((t) => t.id === id);
  if (!task || !task.due) return;
  if (!gcal.isConfigured()) {
    window.open(gcal.buildTemplateUrl(task), '_blank', 'noopener');
    return;
  }
  if (!gcal.isSignedIn()) {
    try {
      await gcal.signIn();
    } catch (err) {
      showToast(`サインインに失敗しました: ${errorMessage(err)}`, { error: true });
      return;
    }
    renderGcalStatus();
  }
  try {
    await upsertEventFor(task);
    showToast('カレンダーに登録しました');
  } catch (err) {
    console.error(err);
    showToast(`カレンダー同期に失敗しました: ${errorMessage(err)}`, { error: true });
  }
}

function setFilter(filter) {
  ui.filter = filter;
  for (const tab of el.tabs) {
    const active = tab.dataset.filter === filter;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', String(active));
  }
  render();
}

function setListening(on) {
  ui.listening = on;
  el.mic.classList.toggle('is-listening', on);
  el.mic.setAttribute('aria-pressed', String(on));
  el.mic.setAttribute('aria-label', on ? '音声入力を停止' : '音声入力');
  el.voiceStatus.hidden = !on;
  el.voiceStatus.textContent = on ? '聞き取り中です。話し終わると自動で止まります' : '';
}

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function ensureMicPermission() {
  if (ui.micGranted || !navigator.mediaDevices?.getUserMedia) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  ui.micGranted = true;
}

function showKeyboardDictationHint() {
  el.input.focus();
  showToast('このブラウザでは音声認識を開始できませんでした。入力欄をタップし、キーボードのマイクボタンで話すと同じように登録できます', {
    error: true,
    duration: 12000,
  });
}

function startVoice() {
  if (ui.listening && ui.recognizer) {
    ui.recognizer.stop();
    return;
  }
  if (IS_IOS && !ui.micGranted) {
    ensureMicPermission()
      .then(beginRecognition)
      .catch((err) => {
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
          showToast(
            'Safariのマイクが拒否されています。アドレスバー左の「ぁあ」→「Webサイトの設定」→「マイク」を「許可」にし、iPhoneの「設定 → アプリ → Safari → マイク」も「確認」か「許可」にして再読み込みしてください。代わりにキーボードのマイクボタンでも入力できます',
            { error: true, duration: 15000 },
          );
          el.input.focus();
          return;
        }
        showKeyboardDictationHint();
      });
    return;
  }
  beginRecognition();
}

function beginRecognition() {
  ui.recognizer = createRecognizer({
    lang: 'ja-JP',
    onResult: (text, isFinal) => {
      el.input.value = text;
      parseInput();
      renderChips();
      if (isFinal && text.trim()) {
        if (store.getSettings().voiceAutoAdd) {
          const task = addFromDraft();
          if (task) showToast('追加しました');
        }
      }
    },
    onEnd: () => {
      setListening(false);
    },
    onError: (code, message) => {
      setListening(false);
      if (IS_IOS && (code === 'not-allowed' || code === 'service-not-allowed' || code === 'not-supported')) {
        showKeyboardDictationHint();
        return;
      }
      showToast(message || `音声入力エラー（${code}）`, { error: true });
    },
  });
  try {
    ui.recognizer.start();
    setListening(true);
  } catch (err) {
    setListening(false);
    showToast(`音声入力を開始できません: ${errorMessage(err)}`, { error: true });
  }
}

function renderCategorySettings() {
  const categories = store.getCategories();
  el.categoryList.replaceChildren();
  for (const c of categories) {
    const li = document.createElement('li');
    li.className = 'category-row';
    const color = document.createElement('input');
    color.type = 'color';
    color.value = c.color;
    color.setAttribute('aria-label', `${c.name}の色`);
    color.addEventListener('change', () => store.updateCategory(c.id, { color: color.value }));
    const name = document.createElement('input');
    name.type = 'text';
    name.value = c.name;
    name.setAttribute('aria-label', 'カテゴリ名');
    name.addEventListener('change', () => {
      if (name.value.trim()) store.updateCategory(c.id, { name: name.value.trim() });
      else name.value = c.name;
    });
    const del = iconButton('delete', `${c.name}を削除`, '×');
    del.addEventListener('click', () => {
      const count = store.getTasks().filter((t) => t.categoryId === c.id).length;
      const msg = count > 0
        ? `「${c.name}」を削除しますか？ ${count}件のタスクはカテゴリなしになります`
        : `「${c.name}」を削除しますか？`;
      if (window.confirm(msg)) store.deleteCategory(c.id);
    });
    li.append(color, name, del);
    el.categoryList.append(li);
  }
  const settings = store.getSettings();
  el.defaultCategory.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'なし';
  el.defaultCategory.append(none);
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    el.defaultCategory.append(opt);
  }
  el.defaultCategory.value = settings.defaultCategoryId || '';
}

function renderGcalStatus() {
  const configured = gcal.isConfigured();
  const signedIn = configured && gcal.isSignedIn();
  el.gcalSignIn.textContent = signedIn ? 'サインアウト' : 'サインイン';
  el.gcalSignIn.disabled = !configured;
  el.gcalSyncAll.disabled = !configured;
  const unsynced = unsyncedTasks().length;
  el.gcalStatus.textContent = !configured
    ? '未設定です。クライアントIDを入力するとカレンダーに登録できます。設定前はカレンダーボタンから予定作成画面を開けます。'
    : signedIn
      ? `サインイン済み。未同期の期限付きタスク: ${unsynced}件`
      : `未サインイン。未同期の期限付きタスク: ${unsynced}件`;
}

function formatClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function driveStatusText(status) {
  if (!gcal.isConfigured()) return 'クライアントIDを設定し、サインインすると PC とスマホでタスクが共有されます';
  switch (status?.state) {
    case 'syncing':
      return '同期中…';
    case 'synced':
      return `同期済み（${formatClock(status.lastSyncedAt)}）`;
    case 'error':
      return `エラー: ${status.message || '同期に失敗しました'}`;
    case 'idle':
      return status.message || '同期待ち';
    default:
      return '未サインイン（サインインすると PC とスマホでタスクが共有されます）';
  }
}

function renderDriveStatus(status = sync ? sync.getStatus() : null) {
  if (!el.driveStatus) return;
  el.driveStatus.textContent = driveStatusText(status);
  if (el.driveSyncNow) el.driveSyncNow.disabled = !gcal.isConfigured() || status?.state === 'syncing';
}

function onSyncStatus(status) {
  renderDriveStatus(status);
  if (status.state === 'error' && status.message && status.message !== ui.lastSyncErrorToast) {
    ui.lastSyncErrorToast = status.message;
    showToast(`データ同期に失敗しました: ${status.message}`, { error: true });
  }
  if (status.state === 'synced') ui.lastSyncErrorToast = '';
}

async function syncNow() {
  if (!gcal.isConfigured()) {
    showToast('クライアントIDを設定してください', { error: true });
    return;
  }
  if (!gcal.isSignedIn()) {
    try {
      await gcal.signIn();
    } catch (err) {
      showToast(`サインインに失敗しました: ${errorMessage(err)}`, { error: true });
      return;
    }
    renderGcalStatus();
  }
  if (!sync) return;
  await sync.pullNow();
  const status = sync.getStatus();
  if (status.state === 'synced') showToast('同期しました', { duration: 2000 });
}

function renderSettings() {
  const s = store.getSettings();
  if (document.activeElement !== el.gcalClientId) el.gcalClientId.value = s.gcalClientId || '';
  if (document.activeElement !== el.gcalCalendarId) el.gcalCalendarId.value = s.gcalCalendarId || 'primary';
  el.gcalSyncMode.value = s.gcalSyncMode || 'confirm';
  el.voiceAutoAdd.checked = Boolean(s.voiceAutoAdd);
  renderCategorySettings();
  renderGcalStatus();
  renderDriveStatus();
}

function configureGcal() {
  const s = store.getSettings();
  try {
    gcal.configure({ clientId: (s.gcalClientId || '').trim(), calendarId: (s.gcalCalendarId || 'primary').trim() || 'primary' });
  } catch (err) {
    console.error(err);
    showToast(`カレンダー設定に失敗しました: ${errorMessage(err)}`, { error: true });
  }
  renderGcalStatus();
}

function downloadJSON() {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tasks-${today()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFromFile(file) {
  if (!file) return;
  const mode = (el.settings.querySelector('input[name="import-mode"]:checked') || {}).value || 'replace';
  if (mode === 'replace' && store.getTasks().length > 0) {
    if (!window.confirm('現在のタスクをすべて置き換えます。よろしいですか？')) return;
  }
  try {
    const text = await file.text();
    const { imported } = store.importJSON(text, { merge: mode === 'merge' });
    configureGcal();
    showToast(`${imported}件のタスクをインポートしました`);
  } catch (err) {
    console.error(err);
    showToast(`インポートに失敗しました: ${errorMessage(err)}`, { error: true });
  } finally {
    el.importFile.value = '';
  }
}

function bindEvents() {
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const task = addFromDraft();
    if (task) {
      showToast('追加しました', { duration: 1500 });
      el.input.focus();
    }
  });

  el.input.addEventListener('input', () => {
    parseInput();
    renderChips();
  });

  el.chips.addEventListener('click', onChipClick);

  el.scrim.addEventListener('click', closePopover);

  for (const tab of el.tabs) {
    tab.addEventListener('click', () => setFilter(tab.dataset.filter));
  }

  el.mic.addEventListener('click', startVoice);

  el.settingsBtn.addEventListener('click', () => {
    renderSettings();
    el.settings.showModal();
  });

  el.addCategoryBtn.addEventListener('click', () => {
    store.addCategory('新しいカテゴリ', '#64748b');
    const last = el.categoryList.querySelector('.category-row:last-child input[type="text"]');
    if (last) {
      last.focus();
      last.select();
    }
  });

  el.defaultCategory.addEventListener('change', () => {
    store.updateSettings({ defaultCategoryId: el.defaultCategory.value || null });
  });

  el.gcalClientId.addEventListener('change', () => {
    store.updateSettings({ gcalClientId: el.gcalClientId.value.trim() });
    configureGcal();
  });

  el.gcalCalendarId.addEventListener('change', () => {
    store.updateSettings({ gcalCalendarId: el.gcalCalendarId.value.trim() || 'primary' });
    configureGcal();
  });

  el.gcalSyncMode.addEventListener('change', () => {
    store.updateSettings({ gcalSyncMode: el.gcalSyncMode.value });
  });

  el.voiceAutoAdd.addEventListener('change', () => {
    store.updateSettings({ voiceAutoAdd: el.voiceAutoAdd.checked });
  });

  el.gcalSignIn.addEventListener('click', async () => {
    try {
      if (gcal.isSignedIn()) {
        await gcal.signOut();
        showToast('サインアウトしました');
      } else {
        await gcal.signIn();
        showToast('サインインしました');
      }
    } catch (err) {
      console.error(err);
      showToast(`サインインに失敗しました: ${errorMessage(err)}`, { error: true });
    }
    renderGcalStatus();
  });

  el.gcalSyncAll.addEventListener('click', async () => {
    el.gcalSyncAll.disabled = true;
    await syncAllUnsynced();
    renderGcalStatus();
  });

  if (el.driveSyncNow) {
    el.driveSyncNow.addEventListener('click', async () => {
      el.driveSyncNow.disabled = true;
      try {
        await syncNow();
      } finally {
        renderDriveStatus();
      }
    });
  }

  el.exportBtn.addEventListener('click', downloadJSON);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', () => importFromFile(el.importFile.files[0]));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.popover.hidden) {
      e.preventDefault();
      closePopover();
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.settings.open) return;
      e.preventDefault();
      el.input.focus();
    }
  });

  window.addEventListener('resize', () => {
    if (!el.popover.hidden) closePopover();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    render();
    runLocalInbox();
  });

  window.addEventListener('storage', (e) => {
    if (e.key === LOCAL_INBOX_KEY && e.newValue) runLocalInbox();
  });
}

function notifyImported(count) {
  if (count > 0) showToast(`議事録から ${count} 件のタスクを取り込みました`);
}

function runLocalInbox() {
  try {
    notifyImported(importLocalInbox(store));
  } catch (err) {
    console.error(err);
  }
}

async function runDriveInbox() {
  notifyImported(await importDriveInbox(store, authorizedFetch));
}

function init() {
  if (!isVoiceSupported()) {
    el.mic.disabled = true;
    el.mic.title = 'このブラウザは音声入力に対応していません（Chrome / Edge をご利用ください）';
    el.mic.setAttribute('aria-label', el.mic.title);
  }
  configureGcal();
  try {
    if (gcal.handleRedirectResult()) showToast('サインインしました');
  } catch (err) {
    console.error(err);
    showToast(`サインインに失敗しました: ${errorMessage(err)}`, { error: true });
  }
  try {
    gcal.onAuthChange(() => {
      if (el.settings.open) {
        renderGcalStatus();
        renderDriveStatus();
      }
    });
  } catch (err) {
    console.error(err);
  }
  store.subscribe(() => {
    render();
    renderChips();
    if (el.settings.open) renderSettings();
  });
  bindEvents();
  renderChips();
  setFilter('today');
  runLocalInbox();
  sync = createSync({ store, gcal, drive, onStatus: onSyncStatus, afterPull: runDriveInbox });
  sync.start();
  renderDriveStatus();
}

init();
