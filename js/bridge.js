import { todayYMD, diffDays, endOfWeekYMD, fromYMD } from './dateutil.js';

export const BRIDGE_FOLDER = 'taskapp-bridge';
export const OPEN_JSON = 'tasks_open.json';
export const OPEN_TXT = 'tasks_open.txt';
export const INBOX_FILE = 'inbox.txt';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MULTIPART_BOUNDARY = 'taskapp_bridge_4c1e8b';
const PRIORITY_RANK = { high: 0, mid: 1, low: 2 };

function pad(n) {
  return String(n).padStart(2, '0');
}

function toLocalISO(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function md(ymd) {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function compareTasks(a, b) {
  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }
  if ((a.time || '') !== (b.time || '')) {
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time < b.time ? -1 : 1;
  }
  return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
}

export function openTasks(tasks) {
  return tasks.filter((t) => t && !t.done).sort(compareTasks);
}

export function buildOpenJSON(tasks, categories, now = new Date()) {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  return {
    version: 1,
    exportedAt: toLocalISO(now),
    tasks: openTasks(tasks).map((t) => ({
      id: t.id,
      title: t.title,
      due: t.due ?? null,
      time: t.time ?? null,
      priority: t.priority,
      category: names.get(t.categoryId) || '',
      note: t.memo || '',
    })),
  };
}

function line(t, withDate) {
  const head = [withDate && t.due ? md(t.due) : '', t.time || ''].filter(Boolean).join(' ');
  const mark = t.priority === 'high' ? '（高）' : '';
  return `・${head ? `${head} ` : ''}${t.title}${mark}`;
}

export function buildOpenText(tasks, now = new Date()) {
  const today = todayYMD(now);
  const weekEnd = endOfWeekYMD(today);
  const groups = { overdue: [], today: [], week: [], later: [] };
  for (const t of openTasks(tasks)) {
    if (!t.due) groups.later.push(t);
    else if (diffDays(today, t.due) < 0) groups.overdue.push(t);
    else if (t.due === today) groups.today.push(t);
    else if (diffDays(t.due, weekEnd) >= 0) groups.week.push(t);
    else groups.later.push(t);
  }
  const out = [`taskapp 未完了タスク（${md(today)} ${pad(now.getHours())}:${pad(now.getMinutes())} 時点）`];
  const sections = [
    ['【期限切れ】', groups.overdue, true],
    [`【今日 ${md(today)}】`, groups.today, false],
    ['【今週】', groups.week, true],
    ['【それ以降・期限なし】', groups.later, true],
  ];
  for (const [title, list, withDate] of sections) {
    if (list.length === 0) continue;
    out.push(title, ...list.map((t) => line(t, withDate)));
  }
  if (out.length === 1) out.push('未完了のタスクはありません');
  return `${out.join('\n')}\n`;
}

function quote(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function listFiles(apiFetch, q) {
  const params = new URLSearchParams({
    q,
    spaces: 'drive',
    fields: 'files(id,name,createdTime)',
    orderBy: 'createdTime',
    pageSize: '100',
  });
  const res = await apiFetch('GET', `${FILES_URL}?${params.toString()}`);
  return Array.isArray(res.data?.files) ? res.data.files.filter((f) => f && f.id) : [];
}

async function createFile(apiFetch, metadata, content, contentType) {
  const body = [
    `--${MULTIPART_BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${MULTIPART_BOUNDARY}`,
    `Content-Type: ${contentType}`,
    '',
    content,
    `--${MULTIPART_BOUNDARY}--`,
    '',
  ].join('\r\n');
  const res = await apiFetch('POST', `${UPLOAD_URL}?uploadType=multipart&fields=id`, body, [], {
    contentType: `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
  });
  return res.data?.id || null;
}

async function ensureFolder(apiFetch) {
  const found = await listFiles(
    apiFetch,
    `name='${BRIDGE_FOLDER}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`,
  );
  if (found.length > 0) return found[0].id;
  const res = await apiFetch('POST', `${FILES_URL}?fields=id`, {
    name: BRIDGE_FOLDER,
    mimeType: FOLDER_MIME,
    parents: ['root'],
  });
  return res.data?.id || null;
}

async function writeFile(apiFetch, folderId, existing, name, content, contentType) {
  const file = existing.get(name);
  if (file) {
    const res = await apiFetch(
      'PATCH',
      `${UPLOAD_URL}/${encodeURIComponent(file.id)}?uploadType=media`,
      content,
      [404],
      { contentType },
    );
    if (res.status !== 404) return;
  }
  await createFile(apiFetch, { name, parents: [folderId] }, content, contentType);
}

export function createBridge({ store, apiFetch, now = () => new Date() }) {
  let lastSignature = null;
  let running = null;
  let again = false;

  async function run() {
    const date = now();
    const tasks = store.getTasks();
    const json = buildOpenJSON(tasks, store.getCategories(), date);
    const text = buildOpenText(tasks, date);
    const signature = JSON.stringify([json.tasks, text.split('\n').slice(1)]);
    if (signature === lastSignature) return false;

    const folderId = await ensureFolder(apiFetch);
    if (!folderId) throw new Error('taskapp-bridge フォルダを作成できませんでした');
    const files = await listFiles(apiFetch, `'${quote(folderId)}' in parents and trashed=false`);
    const existing = new Map();
    for (const f of files) if (!existing.has(f.name)) existing.set(f.name, f);

    await writeFile(apiFetch, folderId, existing, OPEN_JSON, `${JSON.stringify(json, null, 2)}\n`, 'application/json; charset=UTF-8');
    await writeFile(apiFetch, folderId, existing, OPEN_TXT, text, 'text/plain; charset=UTF-8');
    if (!existing.has(INBOX_FILE)) {
      await createFile(apiFetch, { name: INBOX_FILE, parents: [folderId] }, '', 'text/plain; charset=UTF-8');
    }
    lastSignature = signature;
    return true;
  }

  // 同期完了のたびに呼ばれるため、実行中の再要求は1回にまとめて後追いで実行する
  function exportNow() {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
      if (again) {
        again = false;
        exportNow().catch((e) => console.error(e));
      }
    });
    return running;
  }

  return { exportNow };
}
