import {
  addDays,
  endOfWeekYMD,
  startOfNextWeekYMD,
  nextWeekdayYMD,
  endOfMonthYMD,
  startOfNextMonthYMD,
} from './dateutil.js';

const MASK = '\u0000';
const NUM = '(?:[0-9０-９]{1,2}|[一二三]?十[一二三四五六七八九]?|[一二三四五六七八九])';
const WEEKDAY = '([月火水木金土日])曜(?:日)?';
const KANJI_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEKDAY_INDEX = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

const DUE_PREFIX_RE = /(?:期限|締切|締め切り|〆切)(?:は|が|:|：)?$/;
const DUE_SUFFIX_RE = /\s*(?:まで(?:に)?(?:は)?|(?:が|は)?(?:期限|締切|締め切り|〆切)(?:です)?)?\s*(?:に|の|で|は|を|へ)?/y;
const PRIORITY_SUFFIX_RE = /\s*(?:です|で|に|な)?/y;
const REPEAT_SUFFIX_RE = /\s*(?:の|に|で|は)?/y;
const CATEGORY_SUFFIX_RE = /\s*(?:の|で)?/y;

const TIME_NUM = '(?:[0-9０-９]{1,2}|[一二三四五]?十[一二三四五六七八九]?|[一二三四五六七八九])';
const TIME_RE = new RegExp(
  `(?:(午前|今朝|朝|深夜|午後|今夜|今晩|昼|夕方|夜|晩)(?:の)?)?(?<![0-9０-９])(${TIME_NUM})` +
    `(?:時(?!間|々|点|期|刻|代|限)(?:(半)|(${TIME_NUM})分)?|[:：]([0-9０-９]{2})(?![0-9０-９]))`,
  'g',
);
const NOON_RE = /正午/;
const PM_PREFIXES = new Set(['午後', '今夜', '今晩', '昼', '夕方', '夜', '晩']);
const TIME_SUFFIX_RE = /\s*(?:頃|ごろ|くらい|ぐらい)?(?:スタート|開始)?(?:までに|まで|から|に|で|の)?/y;

function toHalfWidth(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function parseNumber(s) {
  if (/^[0-9０-９]+$/.test(s)) return parseInt(toHalfWidth(s), 10);
  const idx = s.indexOf('十');
  if (idx < 0) return KANJI_DIGITS[s] ?? NaN;
  const tens = idx === 0 ? 1 : KANJI_DIGITS[s[0]];
  const rest = s.slice(idx + 1);
  const ones = rest ? KANJI_DIGITS[rest] : 0;
  if (tens === undefined || ones === undefined) return NaN;
  return tens * 10 + ones;
}

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function splitYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function daysInMonth(y, m) {
  return splitYMD(endOfMonthYMD(ymd(y, m, 1))).d;
}

function dayInMonthOf(baseYmd, day) {
  const { y, m } = splitYMD(baseYmd);
  return ymd(y, m, Math.min(day, daysInMonth(y, m)));
}

function resolveDayOfMonth(today, day) {
  if (!(day >= 1 && day <= 31)) return null;
  const { y, m } = splitYMD(today);
  if (day <= daysInMonth(y, m)) {
    const candidate = ymd(y, m, day);
    if (candidate >= today) return candidate;
  }
  return dayInMonthOf(startOfNextMonthYMD(today), day);
}

function resolveMonthDay(today, month, day) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const { y } = splitYMD(today);
  const thisYear = ymd(y, month, Math.min(day, daysInMonth(y, month)));
  if (thisYear >= today) return thisYear;
  return ymd(y + 1, month, Math.min(day, daysInMonth(y + 1, month)));
}

function weekdayOfNextWeek(today, weekday) {
  const monday = startOfNextWeekYMD(today);
  return addDays(monday, (weekday + 6) % 7);
}

function saturdayOfThisWeek(today) {
  const sunday = endOfWeekYMD(today);
  const saturday = addDays(sunday, -1);
  return saturday < today ? sunday : saturday;
}

const DUE_PATTERNS = [
  {
    re: new RegExp(`来週(?:の)?${WEEKDAY}`),
    resolve: (m, today) => weekdayOfNextWeek(today, WEEKDAY_INDEX[m[1]]),
  },
  {
    re: new RegExp(`今週(?:の)?${WEEKDAY}`),
    resolve: (m, today) => nextWeekdayYMD(today, WEEKDAY_INDEX[m[1]], true),
  },
  {
    re: new RegExp(`次の${WEEKDAY}`),
    resolve: (m, today) => nextWeekdayYMD(today, WEEKDAY_INDEX[m[1]], false),
  },
  {
    re: new RegExp(`来月(?:の)?(${NUM})日`),
    resolve: (m, today) => {
      const day = parseNumber(m[1]);
      return day >= 1 && day <= 31 ? dayInMonthOf(startOfNextMonthYMD(today), day) : null;
    },
  },
  {
    re: new RegExp(`今月(?:の)?(${NUM})日`),
    resolve: (m, today) => resolveDayOfMonth(today, parseNumber(m[1])),
  },
  {
    re: new RegExp(`(${NUM})月(${NUM})日`),
    resolve: (m, today) => resolveMonthDay(today, parseNumber(m[1]), parseNumber(m[2])),
  },
  {
    re: new RegExp(`(${NUM})[/／](${NUM})`),
    resolve: (m, today) => resolveMonthDay(today, parseNumber(m[1]), parseNumber(m[2])),
  },
  {
    re: new RegExp(`(${NUM})日後`),
    resolve: (m, today) => {
      const n = parseNumber(m[1]);
      return Number.isNaN(n) ? null : addDays(today, n);
    },
  },
  {
    re: new RegExp(`(${NUM})日`),
    resolve: (m, today) => resolveDayOfMonth(today, parseNumber(m[1])),
  },
  {
    re: /明後日|あさって|(?:明日|あした|あす|今日|本日)(?:中)?|今週中|今週|来週|週末|今月末|月末|来月末|来月/,
    resolve: (m, today) => {
      const word = m[0].replace(/中$/, '');
      switch (word) {
        case '今日':
        case '本日':
          return today;
        case '明日':
        case 'あした':
        case 'あす':
          return addDays(today, 1);
        case '明後日':
        case 'あさって':
          return addDays(today, 2);
        case '今週中':
        case '今週':
          return endOfWeekYMD(today);
        case '来週':
          return startOfNextWeekYMD(today);
        case '週末':
          return saturdayOfThisWeek(today);
        case '今月末':
        case '月末':
          return endOfMonthYMD(today);
        case '来月末':
          return endOfMonthYMD(startOfNextMonthYMD(today));
        case '来月':
          return startOfNextMonthYMD(today);
        default:
          return null;
      }
    },
  },
  {
    re: new RegExp(WEEKDAY),
    resolve: (m, today) => nextWeekdayYMD(today, WEEKDAY_INDEX[m[1]], true),
  },
];

const PRIORITY_PATTERNS = [
  {
    re: /優先(?:度|順位)?(?:は|を|が|:|：)?(?:(最優先|至急|高(?:い|め)?)|(中(?:くらい|ぐらい)?|普通)|(低(?:い|め)?))/,
    level: (m) => (m[1] ? 'high' : m[2] ? 'mid' : 'low'),
  },
  { re: /大至急|最優先|至急|急ぎ|緊急|重要/, level: () => 'high' },
  { re: /あとで|後で|いつか|そのうち|後回し/, level: () => 'low' },
  { re: /普通/, level: () => 'mid' },
  {
    re: /((高|中|低)(?:です|だ)?)[。、．.!！\s\u0000]*$/,
    level: (m) => ({ 高: 'high', 中: 'mid', 低: 'low' })[m[2]],
    group: 1,
  },
];

const REPEAT_RE = /毎日|デイリー|毎週|ウィークリー|毎月|マンスリー/;
const REPEAT_MAP = {
  毎日: 'daily',
  デイリー: 'daily',
  毎週: 'weekly',
  ウィークリー: 'weekly',
  毎月: 'monthly',
  マンスリー: 'monthly',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function resolveTime(m) {
  let hour = parseNumber(m[2]);
  const minute = m[3] ? 30 : m[4] ? parseNumber(m[4]) : m[5] ? parseInt(toHalfWidth(m[5]), 10) : 0;
  if (!(hour >= 0 && hour <= 24) || !(minute >= 0 && minute <= 59)) return null;
  if (hour === 24) {
    if (minute !== 0) return null;
    hour = 0;
  }
  if (m[1] && PM_PREFIXES.has(m[1]) && hour < 12) hour += 12;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function findTime(masked) {
  TIME_RE.lastIndex = 0;
  let m;
  while ((m = TIME_RE.exec(masked))) {
    const time = resolveTime(m);
    if (time) return { time, start: m.index, end: m.index + m[0].length, text: m[0], prefixed: Boolean(m[1]) };
  }
  const noon = NOON_RE.exec(masked);
  if (noon) {
    return { time: '12:00', start: noon.index, end: noon.index + noon[0].length, text: noon[0], prefixed: false };
  }
  return null;
}

function stickyLength(re, s, at) {
  re.lastIndex = at;
  const m = re.exec(s);
  return m ? m[0].length : 0;
}

function maskRange(s, start, end) {
  return s.slice(0, start) + MASK.repeat(end - start) + s.slice(end);
}

function findCategory(masked, categories) {
  const sorted = categories
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .map((c) => ({ id: c.id, name: c.name.trim() }))
    .sort((a, b) => b.name.length - a.name.length);
  const lower = masked.toLowerCase();
  const comparable = lower.length === masked.length;
  for (const c of sorted) {
    let idx = masked.indexOf(c.name);
    if (idx < 0 && comparable) {
      const lname = c.name.toLowerCase();
      if (lname.length === c.name.length) idx = lower.indexOf(lname);
    }
    if (idx >= 0) return { id: c.id, start: idx, end: idx + c.name.length };
  }
  return null;
}

function cleanTitle(s) {
  return s
    .replace(/\u0000+/g, ' ')
    .replace(/[\s　]+/g, ' ')
    .replace(/^[\s、。,.．]+|[\s、。,.．]+$/g, '')
    .trim();
}

export function parseTaskText(text, { categories = [], today } = {}) {
  const source = typeof text === 'string' ? text : '';
  const result = {
    title: source,
    due: null,
    time: null,
    priority: null,
    repeat: null,
    categoryId: null,
    matched: {},
  };
  if (!source.trim()) return result;

  let masked = source;

  const cat = findCategory(masked, categories);
  if (cat) {
    result.categoryId = cat.id;
    result.matched.category = source.slice(cat.start, cat.end);
    const end = cat.end + stickyLength(CATEGORY_SUFFIX_RE, masked, cat.end);
    masked = maskRange(masked, cat.start, end);
  }

  const rep = REPEAT_RE.exec(masked);
  if (rep) {
    result.repeat = REPEAT_MAP[rep[0]];
    result.matched.repeat = rep[0];
    const start = rep.index;
    const end = start + rep[0].length + stickyLength(REPEAT_SUFFIX_RE, masked, start + rep[0].length);
    masked = maskRange(masked, start, end);
  }

  if (today) {
    for (const p of DUE_PATTERNS) {
      const m = p.re.exec(masked);
      if (!m) continue;
      const due = p.resolve(m, today);
      if (!due) continue;
      result.due = due;
      result.matched.due = m[0];
      let start = m.index;
      let end = start + m[0].length;
      const prefix = DUE_PREFIX_RE.exec(masked.slice(0, start));
      if (prefix) start -= prefix[0].length;
      end += stickyLength(DUE_SUFFIX_RE, masked, end);
      masked = maskRange(masked, start, end);
      break;
    }
  }

  const t = findTime(masked);
  if (t) {
    result.time = t.time;
    result.matched.time = t.text;
    let start = t.start;
    if (t.prefixed && masked[start - 1] === 'の') start -= 1;
    const end = t.end + stickyLength(TIME_SUFFIX_RE, masked, t.end);
    masked = maskRange(masked, start, end);
  }

  for (const p of PRIORITY_PATTERNS) {
    const m = p.re.exec(masked);
    if (!m) continue;
    const word = p.group ? m[p.group] : m[0];
    result.priority = p.level(m);
    result.matched.priority = word;
    const start = m.index;
    const end = start + word.length + stickyLength(PRIORITY_SUFFIX_RE, masked, start + word.length);
    masked = maskRange(masked, start, end);
    break;
  }

  const title = cleanTitle(masked);
  result.title = title || source;
  return result;
}
