import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenJSON,
  buildOpenText,
  createBridge,
  BRIDGE_FOLDER,
  OPEN_JSON,
  OPEN_TXT,
  INBOX_FILE,
} from '../js/bridge.js';

// 2026-10-28（水）07:00
const NOW = new Date(2026, 9, 28, 7, 0, 0);

function task(id, overrides = {}) {
  return {
    id,
    title: `タスク${id}`,
    memo: '',
    due: null,
    time: null,
    priority: 'mid',
    categoryId: null,
    repeat: 'none',
    done: false,
    ...overrides,
  };
}

const CATEGORIES = [{ id: 'cat-a', name: 'LOGIAXIS', color: '#2563eb' }];

const TASKS = [
  task('later', { title: '来月の準備', due: '2026-11-10' }),
  task('none', { title: '本を読む', priority: 'low' }),
  task('done', { title: '完了済み', due: '2026-10-28', done: true }),
  task('today', { title: '見積もりを送る', due: '2026-10-28', priority: 'high', categoryId: 'cat-a', memo: '至急' }),
  task('overdue', { title: '請求書の確認', due: '2026-10-26' }),
  task('week', { title: '資料を仕上げる', due: '2026-10-30' }),
  task('today-time', { title: '朝会', due: '2026-10-28', time: '09:00' }),
];

describe('buildOpenJSON', () => {
  test('未完了だけを期限順で、カテゴリ名とメモ付きで出力する', () => {
    const json = buildOpenJSON(TASKS, CATEGORIES, NOW);
    assert.equal(json.version, 1);
    assert.match(json.exportedAt, /^2026-10-28T07:00:00[+-]\d\d:\d\d$/);
    assert.deepEqual(json.tasks.map((t) => t.id), ['overdue', 'today-time', 'today', 'week', 'later', 'none']);
    const today = json.tasks.find((t) => t.id === 'today');
    assert.deepEqual(today, {
      id: 'today',
      title: '見積もりを送る',
      due: '2026-10-28',
      time: null,
      priority: 'high',
      category: 'LOGIAXIS',
      note: '至急',
    });
  });
});

describe('buildOpenText', () => {
  test('期限切れ・今日・今週・それ以降に分けて1行1タスクで出力する', () => {
    assert.equal(buildOpenText(TASKS, NOW), [
      'taskapp 未完了タスク（10/28 07:00 時点）',
      '【期限切れ】',
      '・10/26 請求書の確認',
      '【今日 10/28】',
      '・09:00 朝会',
      '・見積もりを送る（高）',
      '【今週】',
      '・10/30 資料を仕上げる',
      '【それ以降・期限なし】',
      '・11/10 来月の準備',
      '・本を読む',
      '',
    ].join('\n'));
  });

  test('空の区分は出さず、未完了が無ければその旨を書く', () => {
    assert.equal(
      buildOpenText([task('x', { done: true })], NOW),
      'taskapp 未完了タスク（10/28 07:00 時点）\n未完了のタスクはありません\n',
    );
  });
});

function fakeDrive() {
  const files = new Map();
  const calls = [];
  let seq = 0;
  const parseMultipart = (body) => {
    const parts = body.split(/--taskapp_bridge_\w+/);
    return { meta: JSON.parse(parts[1].split('\r\n\r\n')[1]), content: parts[2].split('\r\n\r\n')[1].replace(/\r\n$/, '') };
  };
  async function apiFetch(method, url, body) {
    calls.push(method);
    const u = new URL(url);
    if (method === 'GET') {
      const q = u.searchParams.get('q');
      const list = [...files.values()].filter((f) => {
        if (q.includes('mimeType')) return f.name === BRIDGE_FOLDER;
        const parent = q.match(/'([^']+)' in parents/)[1];
        return f.parents?.includes(parent);
      });
      return { status: 200, data: { files: list.map(({ id, name }) => ({ id, name })) } };
    }
    if (method === 'POST' && u.pathname.startsWith('/upload')) {
      const { meta, content } = parseMultipart(body);
      const id = `f${(seq += 1)}`;
      files.set(id, { id, ...meta, content });
      return { status: 200, data: { id } };
    }
    if (method === 'POST') {
      const id = `d${(seq += 1)}`;
      files.set(id, { id, ...body });
      return { status: 200, data: { id } };
    }
    if (method === 'PATCH') {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      files.get(id).content = body;
      return { status: 200, data: { id } };
    }
    throw new Error(`unexpected ${method} ${url}`);
  }
  const byName = (name) => [...files.values()].filter((f) => f.name === name);
  return { apiFetch, files, calls, byName };
}

describe('createBridge', () => {
  test('初回はフォルダと3ファイルを作成し、2回目以降は上書きして inbox は触らない', async () => {
    const drive = fakeDrive();
    let tasks = [task('a', { title: '見積もり', due: '2026-10-28' })];
    const bridge = createBridge({
      store: { getTasks: () => tasks, getCategories: () => [] },
      apiFetch: drive.apiFetch,
      now: () => NOW,
    });

    assert.equal(await bridge.exportNow(), true);
    assert.equal(drive.byName(BRIDGE_FOLDER).length, 1);
    const folderId = drive.byName(BRIDGE_FOLDER)[0].id;
    for (const name of [OPEN_JSON, OPEN_TXT, INBOX_FILE]) {
      const list = drive.byName(name);
      assert.equal(list.length, 1, name);
      assert.deepEqual(list[0].parents, [folderId]);
    }
    assert.equal(drive.byName(INBOX_FILE)[0].content, '');
    assert.match(drive.byName(OPEN_TXT)[0].content, /・見積もり/);

    assert.equal(await bridge.exportNow(), false, '内容が同じなら書き込まない');

    drive.byName(INBOX_FILE)[0].content = '{"id":"s1","title":"追記"}';
    tasks = [task('a', { title: '見積もり', due: '2026-10-28', done: true })];
    assert.equal(await bridge.exportNow(), true);
    assert.equal(drive.byName(BRIDGE_FOLDER).length, 1);
    assert.equal(drive.byName(OPEN_TXT).length, 1);
    assert.match(drive.byName(OPEN_TXT)[0].content, /未完了のタスクはありません/);
    assert.deepEqual(JSON.parse(drive.byName(OPEN_JSON)[0].content).tasks, []);
    assert.equal(drive.byName(INBOX_FILE)[0].content, '{"id":"s1","title":"追記"}');
  });
});
