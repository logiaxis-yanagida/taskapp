import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../js/store.js';
import { importLocalInbox, importDriveInbox, LOCAL_INBOX_KEY } from '../js/inbox.js';
import { createSync } from '../js/sync.js';

const BASE_AT = '2026-01-01T00:00:00.000Z';
const MEMO = '元会議：定例MTG（2026/10/07）／担当：田中';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    has: (k) => map.has(k),
  };
}

function item(id, overrides = {}) {
  return {
    id,
    title: `議事録タスク${id}`,
    due: '2026-10-10',
    memo: MEMO,
    categoryId: 'cat-a',
    source: 'minutes',
    meetingId: 'mtg-1',
    createdAt: BASE_AT,
    ...overrides,
  };
}

function reset({ tasks = [], deleted = {} } = {}) {
  store.importJSON({ version: 1, tasks, categories: [{ id: 'cat-a', name: 'A', color: '#2563eb' }], settings: {} });
  store.getState().deleted = { ...deleted };
}

function findTask(id) {
  return store.getTasks().find((t) => t.id === id) || null;
}

function inboxStorage(items) {
  return fakeStorage({ [LOCAL_INBOX_KEY]: JSON.stringify(items) });
}

describe('importLocalInbox', () => {
  beforeEach(() => reset());

  test('inbox のタスクを取り込み、キーを削除する', () => {
    const storage = inboxStorage([item('i1'), item('i2', { categoryId: 'cat-x', due: null })]);
    assert.equal(importLocalInbox(store, storage), 2);
    const t1 = findTask('i1');
    assert.equal(t1.title, '議事録タスクi1');
    assert.equal(t1.due, '2026-10-10');
    assert.equal(t1.time, null);
    assert.equal(t1.priority, 'mid');
    assert.equal(t1.categoryId, 'cat-a');
    assert.equal(t1.repeat, 'none');
    assert.equal(t1.done, false);
    assert.equal(t1.memo, MEMO);
    assert.equal(t1.createdAt, BASE_AT);
    assert.ok(t1.updatedAt > BASE_AT);
    assert.equal(findTask('i2').categoryId, null);
    assert.equal(findTask('i2').due, null);
    assert.equal(storage.has(LOCAL_INBOX_KEY), false);
  });

  test('既存 id と inbox 内の重複は取り込まない', () => {
    reset({ tasks: [{ id: 'i1', title: '既存', createdAt: BASE_AT, updatedAt: BASE_AT }] });
    assert.equal(importLocalInbox(store, inboxStorage([item('i1'), item('i2'), item('i2')])), 1);
    assert.equal(findTask('i1').title, '既存');
    assert.equal(store.getTasks().filter((t) => t.id === 'i2').length, 1);
    assert.equal(importLocalInbox(store, inboxStorage([item('i2')])), 0);
  });

  test('削除済み（トゥームストーンあり）のタスクは復活させない', () => {
    reset({ deleted: { i1: BASE_AT } });
    const storage = inboxStorage([item('i1')]);
    assert.equal(importLocalInbox(store, storage), 0);
    assert.equal(findTask('i1'), null);
    assert.ok(store.getState().deleted.i1);
    assert.equal(storage.has(LOCAL_INBOX_KEY), false);
  });

  test('キーが無い・壊れている場合は 0 件', () => {
    assert.equal(importLocalInbox(store, fakeStorage()), 0);
    assert.equal(importLocalInbox(store, fakeStorage({ [LOCAL_INBOX_KEY]: '{' })), 0);
  });

  test('取り込み中に追記された未処理分はキーに残す', () => {
    const storage = inboxStorage([item('i1')]);
    const original = storage.getItem;
    let reads = 0;
    storage.getItem = (k) => {
      reads += 1;
      if (reads === 2) storage.setItem(k, JSON.stringify([item('i1'), item('i3')]));
      return original(k);
    };
    assert.equal(importLocalInbox(store, storage), 1);
    storage.getItem = original;
    assert.deepEqual(JSON.parse(storage.getItem(LOCAL_INBOX_KEY)).map((i) => i.id), ['i3']);
  });
});

function fakeDrive(files) {
  const calls = [];
  const map = new Map(files.map((f) => [f.id, f]));
  const apiFetch = async (method, url, body, allowStatuses = []) => {
    calls.push({ method, url });
    const u = new URL(url);
    if (method === 'GET' && u.pathname.endsWith('/files')) {
      assert.equal(u.searchParams.get('spaces'), 'appDataFolder');
      assert.equal(u.searchParams.get('q'), "name contains 'taskapp-inbox-'");
      return { status: 200, data: { files: [...map.values()].map(({ id, name }) => ({ id, name })) } };
    }
    const id = decodeURIComponent(u.pathname.split('/').pop());
    const file = map.get(id);
    if (!file) {
      if (allowStatuses.includes(404)) return { status: 404, data: null };
      throw new Error('404');
    }
    if (method === 'GET') {
      assert.equal(u.searchParams.get('alt'), 'media');
      return { status: 200, data: file.content };
    }
    if (method === 'DELETE') {
      map.delete(id);
      return { status: 204, data: null };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { apiFetch, calls, files: map };
}

describe('importDriveInbox', () => {
  beforeEach(() => reset());

  test('Drive の inbox ファイルを取り込み、ファイルを削除する', async () => {
    const d = fakeDrive([
      { id: 'f1', name: 'taskapp-inbox-d1.json', content: item('d1') },
      { id: 'f2', name: 'taskapp-inbox-d2.json', content: item('d2', { memo: '' }) },
    ]);
    assert.equal(await importDriveInbox(store, d.apiFetch), 2);
    assert.equal(findTask('d1').memo, MEMO);
    assert.equal(findTask('d2').memo, '');
    assert.equal(d.files.size, 0);
    assert.equal(d.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  test('既存・削除済みは取り込まずファイルだけ削除し、消えていたファイルは無視する', async () => {
    reset({ tasks: [{ id: 'd1', title: '既存', createdAt: BASE_AT, updatedAt: BASE_AT }], deleted: { d2: BASE_AT } });
    const d = fakeDrive([
      { id: 'f1', name: 'taskapp-inbox-d1.json', content: item('d1') },
      { id: 'f2', name: 'taskapp-inbox-d2.json', content: item('d2') },
      { id: 'f3', name: 'taskapp-inbox-d3.json', content: item('d3') },
    ]);
    const apiFetch = async (method, url, body, allow) => {
      if (method === 'GET' && url.includes('/f3?')) d.files.delete('f3');
      return d.apiFetch(method, url, body, allow);
    };
    assert.equal(await importDriveInbox(store, apiFetch), 0);
    assert.equal(findTask('d1').title, '既存');
    assert.equal(findTask('d2'), null);
    assert.equal(findTask('d3'), null);
    assert.equal(d.files.size, 0);
  });

  test('ファイルが無ければ 0 件', async () => {
    assert.equal(await importDriveInbox(store, fakeDrive([]).apiFetch), 0);
  });
});

describe('sync の afterPull', () => {
  beforeEach(() => reset());

  test('pull と mergeRemote の後に afterPull を呼び、取り込み結果を push する', async () => {
    const order = [];
    let pushed = null;
    const gcal = { isSignedIn: () => true, onAuthChange: () => () => {} };
    const drive = {
      pull: async () => {
        order.push('pull');
        return { fileId: 'x', state: { tasks: [], categories: store.getCategories(), deleted: { s1: new Date().toISOString() } } };
      },
      push: async (payload) => {
        order.push('push');
        pushed = payload;
      },
    };
    const d = fakeDrive([
      { id: 'f1', name: 'taskapp-inbox-s1.json', content: item('s1') },
      { id: 'f2', name: 'taskapp-inbox-s2.json', content: item('s2') },
    ]);
    const sync = createSync({
      store,
      gcal,
      drive,
      afterPull: async () => {
        order.push('afterPull');
        await importDriveInbox(store, d.apiFetch);
      },
    });
    await sync.pullNow();
    assert.deepEqual(order, ['pull', 'afterPull', 'push']);
    assert.equal(findTask('s1'), null);
    assert.ok(pushed.tasks.some((t) => t.id === 's2'));
    assert.equal(sync.getStatus().state, 'synced');
  });
});
