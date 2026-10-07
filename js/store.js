import { addDays, addMonths, todayYMD } from './dateutil.js';
import { DEFAULT_GCAL_CLIENT_ID, DEFAULT_GCAL_CALENDAR_ID } from './config.js';

const STORAGE_KEY = 'taskapp.v1';
const PRIORITIES = ['high', 'mid', 'low'];
const REPEATS = ['none', 'daily', 'weekly', 'monthly'];
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const memoryStorage = (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
})();

function getStorage() {
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    return memoryStorage;
  }
  return memoryStorage;
}

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function defaultCategories() {
  const now = nowISO();
  return [
    { id: 'cat-work', name: '仕事', color: '#2563eb', updatedAt: now },
    { id: 'cat-logiaxis', name: 'LOGIAXIS', color: '#7c3aed', updatedAt: now },
    { id: 'cat-private', name: '私用', color: '#16a34a', updatedAt: now },
  ];
}

function categoryKey(name) {
  return String(name || '').trim().toLowerCase();
}

function dedupeCategories(categories, tasks, deleted) {
  const groups = new Map();
  for (const c of categories) {
    const key = categoryKey(c.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const refCount = new Map();
  for (const t of tasks) {
    if (t.categoryId) refCount.set(t.categoryId, (refCount.get(t.categoryId) || 0) + 1);
  }
  const remap = new Map();
  const kept = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      const ra = refCount.get(a.id) || 0;
      const rb = refCount.get(b.id) || 0;
      if (ra !== rb) return rb - ra;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    const keeper = sorted[0];
    kept.push(keeper);
    for (const dup of sorted.slice(1)) remap.set(dup.id, keeper.id);
  }
  if (remap.size === 0) return { categories, tasks, deleted, changed: false };
  const now = nowISO();
  const nextTasks = tasks.map((t) =>
    t.categoryId && remap.has(t.categoryId) ? { ...t, categoryId: remap.get(t.categoryId), updatedAt: now } : t,
  );
  const nextDeleted = { ...deleted };
  for (const id of remap.keys()) nextDeleted[id] = now;
  return { categories: kept, tasks: nextTasks, deleted: nextDeleted, changed: true, remap };
}

function defaultSettings() {
  return {
    gcalClientId: DEFAULT_GCAL_CLIENT_ID,
    gcalCalendarId: 'primary',
    gcalSyncMode: 'confirm',
    voiceAutoAdd: true,
    defaultCategoryId: null,
  };
}

function defaultState() {
  return { version: 1, tasks: [], categories: defaultCategories(), settings: defaultSettings(), deleted: {} };
}

function isYMD(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isHM(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function isISO(v) {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
}

function normalizeTask(raw, categoryIds) {
  if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string') return null;
  const now = nowISO();
  const createdAt = isISO(raw.createdAt) ? raw.createdAt : now;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uuid(),
    title: raw.title,
    memo: typeof raw.memo === 'string' ? raw.memo.trim() : '',
    due: isYMD(raw.due) ? raw.due : null,
    time: isHM(raw.time) ? raw.time : null,
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'mid',
    categoryId: typeof raw.categoryId === 'string' && categoryIds.has(raw.categoryId) ? raw.categoryId : null,
    repeat: REPEATS.includes(raw.repeat) ? raw.repeat : 'none',
    done: Boolean(raw.done),
    createdAt,
    updatedAt: isISO(raw.updatedAt) ? raw.updatedAt : createdAt,
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
    gcalEventId: typeof raw.gcalEventId === 'string' ? raw.gcalEventId : null,
    gcalSyncedDue: isYMD(raw.gcalSyncedDue) ? raw.gcalSyncedDue : null,
    gcalSyncedTime: isHM(raw.gcalSyncedTime) ? raw.gcalSyncedTime : null,
  };
}

function normalizeCategory(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uuid(),
    name: raw.name,
    color: /^#[0-9a-fA-F]{6}$/.test(raw.color || '') ? raw.color : '#64748b',
    updatedAt: isISO(raw.updatedAt) ? raw.updatedAt : nowISO(),
  };
}

function normalizeDeleted(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, at] of Object.entries(raw)) {
    if (typeof id === 'string' && id && isISO(at)) out[id] = at;
  }
  return out;
}

function pruneDeleted(deleted, now = Date.now()) {
  const out = {};
  for (const [id, at] of Object.entries(deleted)) {
    if (now - Date.parse(at) < TOMBSTONE_TTL_MS) out[id] = at;
  }
  return out;
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const categories = Array.isArray(raw.categories)
    ? raw.categories.map(normalizeCategory).filter(Boolean)
    : base.categories;
  const categoryIds = new Set(categories.map((c) => c.id));
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((t) => normalizeTask(t, categoryIds)).filter(Boolean)
    : [];
  const settings = { ...base.settings, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) };
  if (!categoryIds.has(settings.defaultCategoryId)) settings.defaultCategoryId = null;
  if (typeof settings.gcalClientId !== 'string' || !settings.gcalClientId.trim()) {
    settings.gcalClientId = DEFAULT_GCAL_CLIENT_ID;
  }
  if (typeof settings.gcalCalendarId !== 'string' || !settings.gcalCalendarId.trim()) {
    settings.gcalCalendarId = DEFAULT_GCAL_CALENDAR_ID;
  }
  if (!['auto', 'confirm', 'manual'].includes(settings.gcalSyncMode)) {
    settings.gcalSyncMode = settings.gcalAutoSync === false ? 'manual' : 'confirm';
  }
  delete settings.gcalAutoSync;
  const dd = dedupeCategories(categories, tasks, pruneDeleted(normalizeDeleted(raw.deleted)));
  if (dd.remap && dd.remap.has(settings.defaultCategoryId)) settings.defaultCategoryId = dd.remap.get(settings.defaultCategoryId);
  return { version: 1, tasks: dd.tasks, categories: dd.categories, settings, deleted: dd.deleted };
}

function load() {
  try {
    const json = getStorage().getItem(STORAGE_KEY);
    if (!json) return defaultState();
    return normalizeState(JSON.parse(json));
  } catch {
    return defaultState();
  }
}

let state = load();
const listeners = new Set();

function persist() {
  try {
    getStorage().setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('保存に失敗しました', err);
  }
}

function commit() {
  persist();
  for (const fn of listeners) fn(state);
}

function findTask(id) {
  return state.tasks.find((t) => t.id === id) || null;
}

function mergeDeletedMaps(a, b) {
  const out = { ...a };
  for (const [id, at] of Object.entries(b)) {
    if (!out[id] || out[id] < at) out[id] = at;
  }
  return out;
}

function isTombstoned(deleted, item) {
  const at = deleted[item.id];
  return Boolean(at) && at >= item.updatedAt;
}

function mergeCollection(localItems, remoteItems, deleted) {
  const result = [];
  const remoteById = new Map(remoteItems.map((r) => [r.id, r]));
  const seen = new Set();
  for (const local of localItems) {
    seen.add(local.id);
    const remote = remoteById.get(local.id);
    const candidate = remote && remote.updatedAt > local.updatedAt ? remote : local;
    if (isTombstoned(deleted, candidate)) continue;
    result.push(candidate);
  }
  for (const remote of remoteItems) {
    if (seen.has(remote.id)) continue;
    if (isTombstoned(deleted, remote)) continue;
    result.push(remote);
  }
  return result;
}

function reviveImported(items, deleted) {
  const now = nowISO();
  return items.map((item) => {
    if (!deleted[item.id]) return item;
    delete deleted[item.id];
    return { ...item, updatedAt: now };
  });
}

export const store = {
  getState() {
    return state;
  },
  getTasks() {
    return state.tasks;
  },
  getCategories() {
    return state.categories;
  },
  getSettings() {
    return state.settings;
  },

  addTask(partial) {
    const title = (partial && partial.title ? String(partial.title) : '').trim();
    if (!title) throw new Error('タイトルは必須です');
    const categoryIds = new Set(state.categories.map((c) => c.id));
    const now = nowISO();
    const task = normalizeTask(
      {
        id: uuid(),
        title,
        memo: partial.memo ?? '',
        due: partial.due ?? null,
        time: partial.time ?? null,
        priority: partial.priority ?? 'mid',
        categoryId: partial.categoryId ?? state.settings.defaultCategoryId ?? null,
        repeat: partial.repeat ?? 'none',
        done: false,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        gcalEventId: null,
        gcalSyncedDue: null,
        gcalSyncedTime: null,
      },
      categoryIds,
    );
    state.tasks = [...state.tasks, task];
    commit();
    return task;
  },

  updateTask(id, patch) {
    const current = findTask(id);
    if (!current) return null;
    const categoryIds = new Set(state.categories.map((c) => c.id));
    const merged = normalizeTask({ ...current, ...patch, id: current.id, updatedAt: nowISO() }, categoryIds);
    if (typeof patch.title === 'string') {
      const t = patch.title.trim();
      merged.title = t || current.title;
    }
    state.tasks = state.tasks.map((t) => (t.id === id ? merged : t));
    commit();
    return merged;
  },

  deleteTask(id) {
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((t) => t.id !== id);
    if (state.tasks.length === before) return;
    state.deleted = { ...state.deleted, [id]: nowISO() };
    commit();
  },

  toggleDone(id) {
    const current = findTask(id);
    if (!current) return { task: null, next: null };
    const now = nowISO();
    let next = null;
    if (!current.done) {
      const task = { ...current, done: true, completedAt: now, updatedAt: now };
      if (current.repeat !== 'none') {
        const baseDue = current.due || todayYMD();
        const nextDue =
          current.repeat === 'daily' ? addDays(baseDue, 1)
            : current.repeat === 'weekly' ? addDays(baseDue, 7)
              : addMonths(baseDue, 1);
        next = {
          ...current,
          id: uuid(),
          due: nextDue,
          done: false,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          gcalEventId: null,
          gcalSyncedDue: null,
          gcalSyncedTime: null,
        };
      }
      state.tasks = state.tasks.map((t) => (t.id === id ? task : t));
      if (next) state.tasks = [...state.tasks, next];
      commit();
      return { task, next };
    }
    const task = { ...current, done: false, completedAt: null, updatedAt: now };
    state.tasks = state.tasks.map((t) => (t.id === id ? task : t));
    commit();
    return { task, next: null };
  },

  addCategory(name, color) {
    const category = normalizeCategory({
      id: uuid(),
      name: String(name || '').trim() || '新しいカテゴリ',
      color,
      updatedAt: nowISO(),
    });
    state.categories = [...state.categories, category];
    commit();
    return category;
  },

  updateCategory(id, patch) {
    const current = state.categories.find((c) => c.id === id);
    if (!current) return null;
    const merged = normalizeCategory({ ...current, ...patch, id: current.id, updatedAt: nowISO() });
    if (typeof patch.name === 'string' && !patch.name.trim()) merged.name = current.name;
    state.categories = state.categories.map((c) => (c.id === id ? merged : c));
    commit();
    return merged;
  },

  deleteCategory(id) {
    const before = state.categories.length;
    state.categories = state.categories.filter((c) => c.id !== id);
    if (state.categories.length === before) return;
    state.tasks = state.tasks.map((t) => (t.categoryId === id ? { ...t, categoryId: null } : t));
    if (state.settings.defaultCategoryId === id) {
      state.settings = { ...state.settings, defaultCategoryId: null };
    }
    state.deleted = { ...state.deleted, [id]: nowISO() };
    commit();
  },

  updateSettings(patch) {
    state.settings = { ...state.settings, ...patch };
    commit();
    return state.settings;
  },

  exportJSON() {
    return JSON.stringify(state, null, 2);
  },

  importJSON(json, { merge = false } = {}) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    const incoming = normalizeState(parsed);
    if (!merge) {
      const deleted = pruneDeleted(mergeDeletedMaps(state.deleted, incoming.deleted));
      const categories = reviveImported(incoming.categories, deleted);
      const tasks = reviveImported(incoming.tasks, deleted);
      const imported = tasks.length;
      state = { ...incoming, categories, tasks, deleted };
      commit();
      return { imported };
    }
    const deleted = { ...state.deleted };
    const catIds = new Set(state.categories.map((c) => c.id));
    const newCategories = reviveImported(incoming.categories.filter((c) => !catIds.has(c.id)), deleted);
    state.categories = [...state.categories, ...newCategories];
    const allCatIds = new Set(state.categories.map((c) => c.id));
    const taskIds = new Set(state.tasks.map((t) => t.id));
    const newTasks = reviveImported(
      incoming.tasks
        .filter((t) => !taskIds.has(t.id))
        .map((t) => (allCatIds.has(t.categoryId) ? t : { ...t, categoryId: null })),
      deleted,
    );
    state.tasks = [...state.tasks, ...newTasks];
    state.deleted = deleted;
    commit();
    return { imported: newTasks.length };
  },

  getSyncPayload() {
    return {
      version: 1,
      tasks: state.tasks,
      categories: state.categories,
      deleted: state.deleted,
      savedAt: nowISO(),
    };
  },

  mergeRemote(remote) {
    if (!remote || typeof remote !== 'object') return { changed: false };
    const remoteCategories = Array.isArray(remote.categories)
      ? remote.categories.map(normalizeCategory).filter(Boolean)
      : [];
    const knownCategoryIds = new Set([...state.categories, ...remoteCategories].map((c) => c.id));
    const remoteTasks = Array.isArray(remote.tasks)
      ? remote.tasks.map((t) => normalizeTask(t, knownCategoryIds)).filter(Boolean)
      : [];
    const deleted = pruneDeleted(mergeDeletedMaps(state.deleted, normalizeDeleted(remote.deleted)));

    const mergedCategories = mergeCollection(state.categories, remoteCategories, deleted);
    const mergedCategoryIds = new Set(mergedCategories.map((c) => c.id));
    const mergedTasks = mergeCollection(state.tasks, remoteTasks, deleted)
      .map((t) => (t.categoryId && !mergedCategoryIds.has(t.categoryId) ? { ...t, categoryId: null } : t));
    for (const item of [...mergedCategories, ...mergedTasks]) {
      if (deleted[item.id]) delete deleted[item.id];
    }
    const dd = dedupeCategories(mergedCategories, mergedTasks, deleted);
    const categories = dd.categories;
    const tasks = dd.tasks;
    Object.assign(deleted, dd.deleted);
    const categoryIds = new Set(categories.map((c) => c.id));

    const changed =
      JSON.stringify(categories) !== JSON.stringify(state.categories)
      || JSON.stringify(tasks) !== JSON.stringify(state.tasks)
      || JSON.stringify(deleted) !== JSON.stringify(state.deleted);
    if (!changed) return { changed: false };

    const settings = categoryIds.has(state.settings.defaultCategoryId)
      ? state.settings
      : { ...state.settings, defaultCategoryId: null };
    state = { ...state, tasks, categories, settings, deleted };
    commit();
    return { changed: true };
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
