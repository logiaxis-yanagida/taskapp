export const LOCAL_INBOX_KEY = 'minutes.taskappInbox';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_PREFIX = 'taskapp-inbox-';

function toTask(item, categoryIds, now) {
  return {
    id: item.id,
    title: item.title.trim(),
    due: item.due ?? null,
    time: null,
    priority: 'mid',
    categoryId: typeof item.categoryId === 'string' && categoryIds.has(item.categoryId) ? item.categoryId : null,
    repeat: 'none',
    done: false,
    memo: typeof item.memo === 'string' ? item.memo : '',
    createdAt: item.createdAt,
    updatedAt: now,
  };
}

function isValidItem(item) {
  return Boolean(item) && typeof item === 'object'
    && typeof item.id === 'string' && item.id !== ''
    && typeof item.title === 'string' && item.title.trim() !== '';
}

function importItems(store, items) {
  const existing = new Set(store.getTasks().map((t) => t.id));
  const deleted = store.getState().deleted || {};
  const categories = store.getCategories();
  const categoryIds = new Set(categories.map((c) => c.id));
  const now = new Date().toISOString();
  const tasks = [];
  for (const item of items) {
    if (!isValidItem(item)) continue;
    if (existing.has(item.id) || deleted[item.id]) continue;
    existing.add(item.id);
    tasks.push(toTask(item, categoryIds, now));
  }
  if (tasks.length === 0) return 0;
  return store.importJSON({ version: 1, tasks, categories }, { merge: true }).imported;
}

function readArray(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(LOCAL_INBOX_KEY) || 'null');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function importLocalInbox(store, storage = globalThis.localStorage) {
  if (!storage) return 0;
  const items = readArray(storage);
  if (!items) return 0;
  const count = importItems(store, items);
  const processedIds = new Set(items.filter(isValidItem).map((i) => i.id));
  const rest = (readArray(storage) || []).filter((i) => isValidItem(i) && !processedIds.has(i.id));
  if (rest.length === 0) storage.removeItem(LOCAL_INBOX_KEY);
  else storage.setItem(LOCAL_INBOX_KEY, JSON.stringify(rest));
  return count;
}

export async function importDriveInbox(store, apiFetch) {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name contains '${DRIVE_PREFIX}'`,
    fields: 'files(id,name)',
    pageSize: '100',
  });
  const res = await apiFetch('GET', `${FILES_URL}?${params.toString()}`);
  const files = (Array.isArray(res.data?.files) ? res.data.files : [])
    .filter((f) => f && f.id && String(f.name || '').startsWith(DRIVE_PREFIX));
  let count = 0;
  for (const file of files) {
    const url = `${FILES_URL}/${encodeURIComponent(file.id)}`;
    const got = await apiFetch('GET', `${url}?alt=media`, undefined, [404]);
    if (got.status !== 404) {
      const data = got.data;
      count += importItems(store, Array.isArray(data) ? data : [data]);
    }
    await apiFetch('DELETE', url, undefined, [404]);
  }
  return count;
}
