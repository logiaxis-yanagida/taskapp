import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toYMD,
  fromYMD,
  addDays,
  addMonths,
  todayYMD,
  diffDays,
  weekdayOf,
  endOfWeekYMD,
  startOfNextWeekYMD,
  nextWeekdayYMD,
  endOfMonthYMD,
  startOfNextMonthYMD,
  formatDueLabel,
} from '../js/dateutil.js';

describe('toYMD / fromYMD', () => {
  test('ローカル日付を YYYY-MM-DD に変換する', () => {
    assert.equal(toYMD(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(toYMD(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  });

  test('fromYMD はローカル 00:00 の Date を返す', () => {
    const d = fromYMD('2026-03-09');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 2);
    assert.equal(d.getDate(), 9);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
  });

  test('往復変換で値が変わらない', () => {
    assert.equal(toYMD(fromYMD('2024-02-29')), '2024-02-29');
  });
});

describe('addDays', () => {
  test('月をまたぐ加算', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  });
  test('年をまたぐ加算', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });
  test('負数で減算', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
  test('うるう年', () => {
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  });
});

describe('addMonths', () => {
  test('1/31 +1 は 2/28 に丸める', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  });
  test('うるう年は 2/29 に丸める', () => {
    assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  });
  test('3/31 +1 は 4/30', () => {
    assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
  });
  test('丸め不要な日はそのまま', () => {
    assert.equal(addMonths('2026-01-15', 1), '2026-02-15');
  });
  test('年をまたぐ', () => {
    assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  });
  test('負数で減算（5/31 -1 は 4/30）', () => {
    assert.equal(addMonths('2026-05-31', -1), '2026-04-30');
  });
});

describe('todayYMD', () => {
  test('指定した now を基準にする', () => {
    assert.equal(todayYMD(new Date(2026, 9, 3, 12, 0)), '2026-10-03');
  });
  test('引数なしでも YYYY-MM-DD 形式を返す', () => {
    assert.match(todayYMD(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('diffDays', () => {
  test('to - from を日数で返す', () => {
    assert.equal(diffDays('2026-10-01', '2026-10-04'), 3);
    assert.equal(diffDays('2026-10-04', '2026-10-01'), -3);
    assert.equal(diffDays('2026-10-01', '2026-10-01'), 0);
  });
  test('年をまたぐ', () => {
    assert.equal(diffDays('2026-12-31', '2027-01-01'), 1);
  });
});

describe('weekdayOf', () => {
  test('2026-10-03 は土曜(6)、2026-10-04 は日曜(0)、2026-10-05 は月曜(1)', () => {
    assert.equal(weekdayOf('2026-10-03'), 6);
    assert.equal(weekdayOf('2026-10-04'), 0);
    assert.equal(weekdayOf('2026-10-05'), 1);
  });
});

describe('endOfWeekYMD（月曜始まり・日曜終わり）', () => {
  test('月曜 → 同じ週の日曜', () => {
    assert.equal(endOfWeekYMD('2026-10-05'), '2026-10-11');
  });
  test('土曜 → 翌日の日曜', () => {
    assert.equal(endOfWeekYMD('2026-10-03'), '2026-10-04');
  });
  test('日曜 → その日', () => {
    assert.equal(endOfWeekYMD('2026-10-04'), '2026-10-04');
  });
  test('水曜 → 同じ週の日曜', () => {
    assert.equal(endOfWeekYMD('2026-10-07'), '2026-10-11');
  });
});

describe('startOfNextWeekYMD', () => {
  test('月曜 → 来週月曜', () => {
    assert.equal(startOfNextWeekYMD('2026-10-05'), '2026-10-12');
  });
  test('日曜 → 翌日の月曜', () => {
    assert.equal(startOfNextWeekYMD('2026-10-04'), '2026-10-05');
  });
  test('土曜 → 翌々日の月曜', () => {
    assert.equal(startOfNextWeekYMD('2026-10-03'), '2026-10-05');
  });
});

describe('nextWeekdayYMD', () => {
  test('土曜から次の金曜', () => {
    assert.equal(nextWeekdayYMD('2026-10-03', 5), '2026-10-09');
  });
  test('同じ曜日は includeToday=false なら 7 日後', () => {
    assert.equal(nextWeekdayYMD('2026-10-03', 6), '2026-10-10');
  });
  test('同じ曜日は includeToday=true なら当日', () => {
    assert.equal(nextWeekdayYMD('2026-10-03', 6, true), '2026-10-03');
  });
  test('月曜から次の日曜', () => {
    assert.equal(nextWeekdayYMD('2026-10-05', 0), '2026-10-11');
  });
});

describe('endOfMonthYMD / startOfNextMonthYMD', () => {
  test('月末', () => {
    assert.equal(endOfMonthYMD('2026-02-10'), '2026-02-28');
    assert.equal(endOfMonthYMD('2024-02-10'), '2024-02-29');
    assert.equal(endOfMonthYMD('2026-12-01'), '2026-12-31');
  });
  test('翌月1日', () => {
    assert.equal(startOfNextMonthYMD('2026-10-03'), '2026-11-01');
    assert.equal(startOfNextMonthYMD('2026-12-15'), '2027-01-01');
  });
});

describe('formatDueLabel', () => {
  const today = '2026-10-07';

  test('null → 期限なし', () => {
    assert.equal(formatDueLabel(null, today), '期限なし');
    assert.equal(formatDueLabel(undefined, today), '期限なし');
  });
  test('当日 → 今日', () => {
    assert.equal(formatDueLabel('2026-10-07', today), '今日');
  });
  test('+1 → 明日', () => {
    assert.equal(formatDueLabel('2026-10-08', today), '明日');
  });
  test('+2 → 明後日', () => {
    assert.equal(formatDueLabel('2026-10-09', today), '明後日');
  });
  test('過去 → M/D（n日超過）', () => {
    assert.equal(formatDueLabel('2026-10-04', today), '10/4（3日超過）');
    assert.equal(formatDueLabel('2026-09-30', today), '9/30（7日超過）');
  });
  test('今週中（+3 以降で日曜まで）→ 曜日名', () => {
    assert.equal(formatDueLabel('2026-10-10', today), '土曜');
    assert.equal(formatDueLabel('2026-10-11', today), '日曜');
  });
  test('来週以降 → M/D', () => {
    assert.equal(formatDueLabel('2026-10-12', today), '10/12');
    assert.equal(formatDueLabel('2026-11-01', today), '11/1');
  });
  test('日曜が今日なら +2 までは相対表現、+3 以降は M/D', () => {
    const sun = '2026-10-04';
    assert.equal(formatDueLabel('2026-10-06', sun), '明後日');
    assert.equal(formatDueLabel('2026-10-07', sun), '10/7');
  });
});
