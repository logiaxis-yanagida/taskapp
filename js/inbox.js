export const LOCAL_INBOX_KEY = 'minutes.taskappInbox';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_PREFIX = 'taskapp-inbox-';

const PRIORITY_ALIASES = {
  high: 'high', 高: 'high', 至急: 'high',
  mid: 'mid', medium: 'mid', normal: 'mid', 中: 'mid',
  low: 'low', 低: 'low',
};

function resolveCategoryId(item, categories) {
  if (typeof item.categoryId === 'string' && categories.some((c) => c.id === item.categoryId)) return item.categoryId;
  if (typeof item.category === 'string' && item.category.trim() !== '') {
    const name = item.category.trim();
    const found = categories.find((c) => c.name === name);
    if (found) return found.id;
  }
  return null;
}

// due・time・repeat の形式チェックは store.importJSON の正規化に任せる
function toTask(item, categories, now) {
  const memo = typeof item.memo === 'string' ? item.memo : typeof item.note === 'string' ? item.note : '';
  return {
    id: item.id,
    title: item.title.trim(),
    due: item.due ?? null,
    time: item.time ?? null,
    priority: PRIORITY_ALIASES[String(item.priority ?? '').trim().toLowerCase()] || 'mid',
    categoryId: resolveCategoryId(item, categories),
    repeat: item.repeat ?? 'none',
    done: false,
    memo,
    createdAt: item.createdAt,
    updatedAt: now,
  };
}

function isValidItem(item) {
  return Boolean(item) && typeof item === 'object'
    && typeof item.id === 'string' && item.id !== ''
    && typeof item.title === 'string' && item.title.trim() !== '';
}

function importItemsDetailed(store, items) {
  const existing = new Set(store.getTasks().map((t) => t.id));
  const deleted = store.getState().deleted || {};
  const categories = store.getCategories();
  const now = new Date().toISOString();
  const tasks = [];
  let duplicates = 0;
  for (const item of items) {
    if (!isValidItem(item)) continue;
    if (existing.has(item.id) || deleted[item.id]) {
      duplicates += 1;
      continue;
    }
    existing.add(item.id);
    tasks.push(toTask(item, categories, now));
  }
  if (tasks.length === 0) return { imported: 0, duplicates };
  const { imported } = store.importJSON({ version: 1, tasks, categories }, { merge: true });
  return { imported, duplicates };
}

function importItems(store, items) {
  return importItemsDetailed(store, items).imported;
}

function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// id が無い項目は「日付＋内容」から決まる id にする（同じ日に同じ内容を2回貼っても二重登録しない）
function withId(item, today) {
  if (typeof item.id === 'string' && item.id !== '') return item;
  return { ...item, id: `paste-${today}-${hashText(`${item.title}|${item.due ?? ''}`)}` };
}

function stripFence(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

function itemsFromValue(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.tasks)) return value.tasks;
    return [value];
  }
  return [value];
}

function cleanLine(line) {
  return line.replace(/^\s*(?:[・\-*•]|\d+[.)．、])\s*/, '').trim();
}

/**
 * クリップボード等から貼り付けられた文字列を解釈する。
 * - JSON（inbox 形式 { version, items }・配列・1件のオブジェクト・1行1件の JSON Lines。```json で囲まれていても可）→ kind 'json'
 * - それ以外 → kind 'text'（1行1タスクのタイトル）
 * 戻り値の items は title が空でないもののみ。invalid は形式不正でスキップした件数。
 */
export function parsePasted(text, today) {
  const body = stripFence(typeof text === 'string' ? text : '');
  if (!body) return { kind: 'empty', items: [], invalid: 0 };

  if (/^[[{]/.test(body)) {
    let values = null;
    let invalid = 0;
    try {
      values = itemsFromValue(JSON.parse(body));
    } catch {
      values = [];
      for (const line of body.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          values.push(...itemsFromValue(JSON.parse(line)));
        } catch {
          invalid += 1;
        }
      }
    }
    const items = [];
    for (const v of values) {
      if (v && typeof v === 'object' && typeof v.title === 'string' && v.title.trim() !== '') items.push(withId(v, today));
      else invalid += 1;
    }
    return { kind: 'json', items, invalid };
  }

  const titles = body.split(/\r?\n/).map(cleanLine).filter(Boolean);
  return { kind: 'text', items: titles.map((title) => ({ title })), invalid: 0 };
}

export function importPastedItems(store, items, today) {
  return importItemsDetailed(store, items.map((item) => withId(item, today)));
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
