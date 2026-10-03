const WEEKDAY_NAMES = ['日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function toYMD(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function fromYMD(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function addDays(ymd, n) {
  const d = fromYMD(ymd);
  d.setDate(d.getDate() + n);
  return toYMD(d);
}

export function addMonths(ymd, n) {
  const d = fromYMD(ymd);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return toYMD(target);
}

export function todayYMD(now = new Date()) {
  return toYMD(now);
}

export function diffDays(fromYmd, toYmd) {
  const a = fromYMD(fromYmd);
  const b = fromYMD(toYmd);
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86400000);
}

export function weekdayOf(ymd) {
  return fromYMD(ymd).getDay();
}

export function endOfWeekYMD(ymd) {
  const wd = weekdayOf(ymd);
  if (wd === 0) return ymd;
  return addDays(ymd, 7 - wd);
}

export function startOfNextWeekYMD(ymd) {
  return addDays(endOfWeekYMD(ymd), 1);
}

export function nextWeekdayYMD(ymd, weekday, includeToday = false) {
  const wd = weekdayOf(ymd);
  let delta = (weekday - wd + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return addDays(ymd, delta);
}

export function endOfMonthYMD(ymd) {
  const d = fromYMD(ymd);
  return toYMD(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function startOfNextMonthYMD(ymd) {
  const d = fromYMD(ymd);
  return toYMD(new Date(d.getFullYear(), d.getMonth() + 1, 1));
}

export function formatDueLabel(ymd, today) {
  if (!ymd) return '期限なし';
  const base = today || todayYMD();
  const diff = diffDays(base, ymd);
  const d = fromYMD(ymd);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (diff < 0) return `${md}（${-diff}日超過）`;
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === 2) return '明後日';
  if (diffDays(ymd, endOfWeekYMD(base)) >= 0) return WEEKDAY_NAMES[d.getDay()];
  return md;
}
