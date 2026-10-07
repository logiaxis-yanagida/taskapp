import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../js/store.js';

const CAT_A = 'cat-a';
const CAT_B = 'cat-b';

const BASE_AT = '2026-01-01T00:00:00.000Z';

function iso(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function task(id, overrides = {}) {
  return {
    id,
    title: `タスク${id}`,
    due: null,
    time: null,
    priority: 'mid',
    categoryId: null,
    repeat: 'none',
    done: false,
    createdAt: BASE_AT,
    updatedAt: BASE_AT,
    completedAt: null,
    gcalEventId: null,
    gcalSyncedDue: null,
    gcalSyncedTime: null,
    ...overrides,
  };
}

function category(id, overrides = {}) {
  return { id, name: `カテゴリ${id}`, color: '#2563eb', updatedAt: BASE_AT, ...overrides };
}

function reset({ tasks = [], categories = [category(CAT_A), category(CAT_B)], deleted = {} } = {}) {
  store.importJSON({ version: 1, tasks, categories, deleted, settings: {} });
  const state = store.getState();
  state.deleted = { ...deleted };
}

function findTask(id) {
  return store.getTasks().find((t) => t.id === id) || null;
}

describe('updatedAt とトゥームストーン', () => {
  beforeEach(() => reset());

  test('addTask / updateTask / toggleDone で updatedAt が更新される', async () => {
    const t = store.addTask({ title: 'A' });
    assert.ok(t.updatedAt);
    assert.equal(t.updatedAt, t.createdAt);
    await new Promise((r) => setTimeout(r, 5));
    const u = store.updateTask(t.id, { title: 'B' });
    assert.ok(u.updatedAt > t.updatedAt);
    await new Promise((r) => setTimeout(r, 5));
    const { task: d } = store.toggleDone(t.id);
    assert.ok(d.updatedAt > u.updatedAt);
  });

  test('deleteTask / deleteCategory で deleted に記録される', () => {
    const t = store.addTask({ title: 'A', categoryId: CAT_A });
    store.deleteTask(t.id);
    assert.ok(store.getState().deleted[t.id]);
    store.deleteCategory(CAT_A);
    assert.ok(store.getState().deleted[CAT_A]);
    assert.equal(store.getCategories().some((c) => c.id === CAT_A), false);
  });

  test('normalizeTask は updatedAt が無ければ createdAt で補う', () => {
    reset({ tasks: [{ ...task('x'), updatedAt: undefined, createdAt: '2026-01-01T00:00:00.000Z' }] });
    assert.equal(findTask('x').updatedAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('getSyncPayload', () => {
  beforeEach(() => reset());

  test('settings を含まず tasks/categories/deleted/savedAt を含む', () => {
    store.addTask({ title: 'A' });
    const payload = store.getSyncPayload();
    assert.equal(payload.version, 1);
    assert.equal('settings' in payload, false);
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.categories.length, 2);
    assert.deepEqual(payload.deleted, {});
    assert.ok(!Number.isNaN(Date.parse(payload.savedAt)));
  });
});

describe('mergeRemote: タスク', () => {
  beforeEach(() => reset());

  test('updatedAt が新しい remote が勝つ', () => {
    reset({ tasks: [task('t1', { title: 'ローカル', updatedAt: iso(-10_000) })] });
    const { changed } = store.mergeRemote({
      version: 1,
      tasks: [task('t1', { title: 'リモート', updatedAt: iso(-5_000) })],
      categories: [category(CAT_A), category(CAT_B)],
      deleted: {},
    });
    assert.equal(changed, true);
    assert.equal(findTask('t1').title, 'リモート');
  });

  test('updatedAt が新しいローカルが勝つ（変更なし）', () => {
    reset({ tasks: [task('t1', { title: 'ローカル', updatedAt: iso(-5_000) })] });
    const { changed } = store.mergeRemote({
      version: 1,
      tasks: [task('t1', { title: 'リモート', updatedAt: iso(-10_000) })],
      categories: [category(CAT_A), category(CAT_B)],
      deleted: {},
    });
    assert.equal(changed, false);
    assert.equal(findTask('t1').title, 'ローカル');
  });

  test('remote に無いタスクはローカルに追加される', () => {
    reset({ tasks: [task('t1')] });
    store.mergeRemote({ version: 1, tasks: [task('t1'), task('t2')], categories: [category(CAT_A), category(CAT_B)], deleted: {} });
    assert.equal(store.getTasks().length, 2);
    assert.ok(findTask('t2'));
  });

  test('remote のトゥームストーンがローカル更新より新しければローカルを削除', () => {
    reset({ tasks: [task('t1', { updatedAt: iso(-10_000) })] });
    const { changed } = store.mergeRemote({
      version: 1,
      tasks: [],
      categories: [category(CAT_A), category(CAT_B)],
      deleted: { t1: iso(-5_000) },
    });
    assert.equal(changed, true);
    assert.equal(findTask('t1'), null);
    assert.ok(store.getState().deleted.t1);
  });

  test('ローカル更新がトゥームストーンより新しければ削除されない', () => {
    reset({ tasks: [task('t1', { updatedAt: iso(-5_000) })] });
    store.mergeRemote({
      version: 1,
      tasks: [],
      categories: [category(CAT_A), category(CAT_B)],
      deleted: { t1: iso(-10_000) },
    });
    assert.ok(findTask('t1'));
    assert.equal(store.getState().deleted.t1, undefined);
  });

  test('ローカルのトゥームストーンが remote の復活を防ぐ', () => {
    reset({ tasks: [], deleted: { t1: iso(-5_000) } });
    const { changed } = store.mergeRemote({
      version: 1,
      tasks: [task('t1', { updatedAt: iso(-10_000) })],
      categories: [category(CAT_A), category(CAT_B)],
      deleted: {},
    });
    assert.equal(changed, false);
    assert.equal(findTask('t1'), null);
  });

  test('remote の更新がローカルのトゥームストーンより新しければ復活する', () => {
    reset({ tasks: [], deleted: { t1: iso(-10_000) } });
    store.mergeRemote({
      version: 1,
      tasks: [task('t1', { updatedAt: iso(-5_000) })],
      categories: [category(CAT_A), category(CAT_B)],
      deleted: {},
    });
    assert.ok(findTask('t1'));
  });

  test('deleteTask 後の mergeRemote で remote の古い版が戻らない', () => {
    reset({ tasks: [task('t1', { updatedAt: iso(-10_000) })] });
    const remotePayload = store.getSyncPayload();
    store.deleteTask('t1');
    store.mergeRemote(remotePayload);
    assert.equal(findTask('t1'), null);
  });

  test('双方の deleted は新しい方で統合される', () => {
    const older = iso(-20_000);
    const newer = iso(-10_000);
    reset({ tasks: [], deleted: { a: older, b: newer } });
    store.mergeRemote({ version: 1, tasks: [], categories: [category(CAT_A), category(CAT_B)], deleted: { a: newer, b: older, c: older } });
    const { deleted } = store.getState();
    assert.equal(deleted.a, newer);
    assert.equal(deleted.b, newer);
    assert.equal(deleted.c, older);
  });

  test('gcalEventId などの同期メタも新しい側のものが採用される', () => {
    reset({ tasks: [task('t1', { updatedAt: iso(-10_000), gcalEventId: null })] });
    store.mergeRemote({
      version: 1,
      tasks: [task('t1', { updatedAt: iso(-5_000), gcalEventId: 'ev1', due: '2026-10-10', gcalSyncedDue: '2026-10-10' })],
      categories: [category(CAT_A), category(CAT_B)],
      deleted: {},
    });
    assert.equal(findTask('t1').gcalEventId, 'ev1');
    assert.equal(findTask('t1').gcalSyncedDue, '2026-10-10');
  });
});

describe('mergeRemote: カテゴリ', () => {
  beforeEach(() => reset());

  test('カテゴリも updatedAt の新しい方が勝つ', () => {
    reset({ categories: [category(CAT_A, { name: '旧', updatedAt: iso(-10_000) }), category(CAT_B)] });
    store.mergeRemote({
      version: 1,
      tasks: [],
      categories: [category(CAT_A, { name: '新', updatedAt: iso(-5_000) }), category(CAT_B)],
      deleted: {},
    });
    assert.equal(store.getCategories().find((c) => c.id === CAT_A).name, '新');
  });

  test('remote で削除されたカテゴリを参照するタスクは categoryId が null になる', () => {
    reset({
      tasks: [task('t1', { categoryId: CAT_A, updatedAt: iso(-10_000) })],
      categories: [category(CAT_A, { updatedAt: iso(-10_000) }), category(CAT_B)],
    });
    const { changed } = store.mergeRemote({
      version: 1,
      tasks: [task('t1', { categoryId: CAT_A, updatedAt: iso(-10_000) })],
      categories: [category(CAT_B)],
      deleted: { [CAT_A]: iso(-5_000) },
    });
    assert.equal(changed, true);
    assert.equal(store.getCategories().some((c) => c.id === CAT_A), false);
    assert.equal(findTask('t1').categoryId, null);
  });

  test('remote にだけあるカテゴリは追加され、それを参照するタスクも保持される', () => {
    reset({ tasks: [], categories: [category(CAT_A)] });
    store.mergeRemote({
      version: 1,
      tasks: [task('t1', { categoryId: 'cat-c' })],
      categories: [category(CAT_A), category('cat-c')],
      deleted: {},
    });
    assert.ok(store.getCategories().some((c) => c.id === 'cat-c'));
    assert.equal(findTask('t1').categoryId, 'cat-c');
  });
});

describe('deleted の維持と掃除', () => {
  beforeEach(() => reset());

  test('importJSON（置換）でも deleted が維持される', () => {
    const t = store.addTask({ title: 'A' });
    store.deleteTask(t.id);
    store.importJSON({ version: 1, tasks: [task('t9')], categories: [category(CAT_A)], settings: {} });
    assert.ok(store.getState().deleted[t.id]);
    assert.equal(store.getTasks().length, 1);
  });

  test('importJSON（統合）でトゥームストーン付きのタスクを戻すと復活し updatedAt が更新される', () => {
    const t = store.addTask({ title: 'A' });
    store.deleteTask(t.id);
    store.importJSON({ version: 1, tasks: [t], categories: store.getCategories() }, { merge: true });
    const restored = findTask(t.id);
    assert.ok(restored);
    assert.ok(restored.updatedAt >= t.updatedAt);
    assert.equal(store.getState().deleted[t.id], undefined);
  });

  test('90日より古いトゥームストーンは掃除され、新しいものは残る', () => {
    const oldAt = iso(-91 * 24 * 60 * 60 * 1000);
    const recentAt = iso(-1 * 24 * 60 * 60 * 1000);
    store.importJSON({ version: 1, tasks: [], categories: [category(CAT_A)], deleted: { old: oldAt, recent: recentAt } });
    const { deleted } = store.getState();
    assert.equal(deleted.recent, recentAt);
    assert.equal(deleted.old, undefined);
    store.mergeRemote({ version: 1, tasks: [], categories: [category(CAT_A)], deleted: { old2: oldAt } });
    assert.equal(store.getState().deleted.old2, undefined);
    assert.equal(store.getState().deleted.recent, recentAt);
  });
});

describe('同名カテゴリの統合', () => {
  test('importJSON で同名カテゴリが1つにまとまり、タスクの参照も付け替わる', () => {
    store.importJSON(
      {
        version: 1,
        categories: [
          { id: 'x1', name: '仕事', color: '#2563eb', updatedAt: BASE_AT },
          { id: 'x2', name: '仕事', color: '#2563eb', updatedAt: '2026-02-01T00:00:00.000Z' },
          { id: 'x3', name: '私用', color: '#16a34a', updatedAt: BASE_AT },
        ],
        tasks: [task('t1', { categoryId: 'x2' })],
      },
      { merge: false },
    );
    const cats = store.getCategories();
    assert.equal(cats.filter((c) => c.name === '仕事').length, 1);
    assert.equal(cats.find((c) => c.name === '仕事').id, 'x2');
    assert.equal(store.getTasks()[0].categoryId, 'x2');
    assert.ok(store.getSyncPayload().deleted.x1);
  });

  test('mergeRemote で別IDの同名カテゴリが来ても重複しない', () => {
    store.importJSON(
      {
        version: 1,
        categories: [{ id: 'l1', name: 'LOGIAXIS', color: '#7c3aed', updatedAt: BASE_AT }],
        tasks: [task('t1', { categoryId: 'l1' })],
      },
      { merge: false },
    );
    store.mergeRemote({
      version: 1,
      categories: [{ id: 'r1', name: 'LOGIAXIS', color: '#7c3aed', updatedAt: BASE_AT }],
      tasks: [],
      deleted: {},
    });
    const cats = store.getCategories().filter((c) => c.name === 'LOGIAXIS');
    assert.equal(cats.length, 1);
    assert.equal(cats[0].id, 'l1');
    assert.equal(store.getTasks()[0].categoryId, 'l1');
  });
});

describe('memo', () => {
  beforeEach(() => reset());

  test('addTask は memo を既定で空文字にし、指定時は前後の空白を除いて改行を残す', () => {
    assert.equal(store.addTask({ title: 'A' }).memo, '');
    assert.equal(store.addTask({ title: 'B', memo: '  元会議：定例\n担当：田中  ' }).memo, '元会議：定例\n担当：田中');
  });

  test('updateTask で memo を変更できる', () => {
    const t = store.addTask({ title: 'A' });
    assert.equal(store.updateTask(t.id, { memo: ' メモ ' }).memo, 'メモ');
    assert.equal(store.updateTask(t.id, { memo: '' }).memo, '');
  });

  test('文字列以外の memo は空文字になる', () => {
    reset({ tasks: [task('m1', { memo: 123 }), task('m2')] });
    assert.equal(findTask('m1').memo, '');
    assert.equal(findTask('m2').memo, '');
  });

  test('mergeRemote と importJSON（統合）で memo が保持される', () => {
    reset({ tasks: [task('m1')] });
    store.mergeRemote({ tasks: [task('m1', { memo: 'リモート', updatedAt: iso(1000) })], categories: [], deleted: {} });
    assert.equal(findTask('m1').memo, 'リモート');
    store.importJSON({ version: 1, tasks: [task('m2', { memo: '取込' })], categories: [] }, { merge: true });
    assert.equal(findTask('m2').memo, '取込');
  });
});
