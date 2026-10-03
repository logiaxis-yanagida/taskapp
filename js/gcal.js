import { addDays } from './dateutil.js';

const TOKEN_KEY = 'taskapp.gcal.token';
const STATE_KEY = 'taskapp.gcal.state';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.appdata';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API_BASE = 'https://www.googleapis.com/calendar/v3/calendars/';
const TEMPLATE_BASE = 'https://calendar.google.com/calendar/render';
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const EVENT_COLORS = {
  1: '#a4bdfc',
  2: '#7ae7bf',
  3: '#dbadff',
  4: '#ff887c',
  5: '#fbd75b',
  6: '#ffb878',
  7: '#46d6db',
  8: '#e1e1e1',
  9: '#5484ed',
  10: '#51b749',
  11: '#dc2127',
};

const PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };
const REPEAT_LABEL = { none: 'なし', daily: '毎日', weekly: '毎週', monthly: '毎月' };

const GIS_ERROR_MESSAGES = {
  popup_closed: 'サインインがキャンセルされました',
  popup_failed_to_open: 'ポップアップがブロックされました。ブラウザの設定でポップアップを許可してください',
  access_denied: 'アクセスが拒否されました。OAuth 同意画面のテストユーザーに自分の Google アカウントが追加されているか確認してください',
  invalid_client: 'クライアントIDが正しくありません',
  immediate_failed: 'サインインが必要です',
  interaction_required: 'サインインが必要です',
};

export class GcalAuthError extends Error {
  constructor(message = 'Googleカレンダーへのサインインが必要です') {
    super(message);
    this.name = 'GcalAuthError';
  }
}

export class GcalApiError extends Error {
  status;

  constructor(status, message) {
    super(message || `Googleカレンダー API エラー（${status}）`);
    this.name = 'GcalApiError';
    this.status = status;
  }
}

let clientId = '';
let calendarId = 'primary';
let tokenClient = null;
let tokenClientId = '';
let gisPromise = null;
let pendingSignIn = null;
let lastSignedIn = null;
const listeners = new Set();

function notify(signedIn) {
  if (signedIn === lastSignedIn) return;
  lastSignedIn = signedIn;
  for (const fn of listeners) {
    try {
      fn(signedIn);
    } catch (e) {
      console.error(e);
    }
  }
}

function readToken() {
  try {
    const raw = globalThis.sessionStorage?.getItem(TOKEN_KEY);
    if (!raw) return null;
    const token = JSON.parse(raw);
    if (!token || typeof token.access_token !== 'string' || typeof token.expires_at !== 'number') return null;
    return token;
  } catch {
    return null;
  }
}

function writeToken(token) {
  try {
    globalThis.sessionStorage?.setItem(TOKEN_KEY, JSON.stringify(token));
  } catch (e) {
    console.error(e);
  }
}

function clearToken() {
  try {
    globalThis.sessionStorage?.removeItem(TOKEN_KEY);
  } catch {}
}

function getValidToken() {
  const token = readToken();
  if (!token) return null;
  if (token.expires_at - Date.now() <= EXPIRY_MARGIN_MS) {
    clearToken();
    notify(false);
    return null;
  }
  return token;
}

function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const doc = globalThis.document;
    if (!doc) {
      reject(new GcalAuthError('この環境では Google サインインを利用できません'));
      return;
    }
    const script = doc.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (globalThis.google?.accounts?.oauth2) {
        resolve();
      } else {
        reject(new GcalAuthError('Google 認証スクリプトの初期化に失敗しました'));
      }
    };
    script.onerror = () => reject(new GcalAuthError('Google 認証スクリプトの読み込みに失敗しました。ネットワーク接続を確認してください'));
    doc.head.appendChild(script);
  }).catch((e) => {
    gisPromise = null;
    throw e;
  });
  return gisPromise;
}

function describeGisError(code) {
  return GIS_ERROR_MESSAGES[code] || `サインインに失敗しました（${code || 'unknown'}）`;
}

function settlePending(error) {
  const pending = pendingSignIn;
  pendingSignIn = null;
  if (!pending) return;
  if (error) pending.reject(error);
  else pending.resolve();
}

function isStandalone() {
  try {
    if (globalThis.navigator?.standalone === true) return true;
    return Boolean(globalThis.matchMedia?.('(display-mode: standalone)')?.matches);
  } catch {
    return false;
  }
}

function randomState() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function redirectUri() {
  const loc = globalThis.location;
  return `${loc.origin}${loc.pathname}`;
}

function redirectSignIn() {
  const loc = globalThis.location;
  if (!loc || typeof loc.assign !== 'function') {
    throw new GcalAuthError('この環境ではリダイレクト方式のサインインを利用できません');
  }
  const state = randomState();
  try {
    globalThis.sessionStorage?.setItem(STATE_KEY, state);
  } catch (e) {
    console.error(e);
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  loc.assign(`${OAUTH_AUTH_URL}?${params.toString()}`);
  return new Promise(() => {});
}

function handleRedirectResult() {
  const loc = globalThis.location;
  const hash = loc?.hash || '';
  if (!hash || hash.length < 2) return false;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has('access_token') && !params.has('error')) return false;
  let savedState = null;
  try {
    savedState = globalThis.sessionStorage?.getItem(STATE_KEY) ?? null;
    globalThis.sessionStorage?.removeItem(STATE_KEY);
  } catch {}
  try {
    globalThis.history?.replaceState(null, '', `${loc.pathname}${loc.search}`);
  } catch {}
  const error = params.get('error');
  if (error) throw new GcalAuthError(describeGisError(error));
  if (!savedState || params.get('state') !== savedState) {
    throw new GcalAuthError('サインインの検証に失敗しました（state 不一致）。もう一度サインインしてください');
  }
  const expiresIn = Number(params.get('expires_in')) || 3600;
  writeToken({
    access_token: params.get('access_token'),
    expires_at: Date.now() + expiresIn * 1000,
  });
  notify(true);
  return true;
}

function ensureTokenClient() {
  if (tokenClient && tokenClientId === clientId) return tokenClient;
  tokenClient = globalThis.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: (response) => {
      if (!response || response.error) {
        settlePending(new GcalAuthError(describeGisError(response?.error)));
        return;
      }
      const expiresIn = Number(response.expires_in) || 3600;
      writeToken({
        access_token: response.access_token,
        expires_at: Date.now() + expiresIn * 1000,
      });
      notify(true);
      settlePending(null);
    },
    error_callback: (err) => {
      if (err?.type === 'popup_failed_to_open' && pendingSignIn && !pendingSignIn.silent) {
        try {
          redirectSignIn();
          return;
        } catch (e) {
          settlePending(e instanceof GcalAuthError ? e : new GcalAuthError(e?.message));
          return;
        }
      }
      settlePending(new GcalAuthError(describeGisError(err?.type)));
    },
  });
  tokenClientId = clientId;
  return tokenClient;
}

function configure({ clientId: nextClientId, calendarId: nextCalendarId } = {}) {
  const normalizedClientId = String(nextClientId ?? '').trim();
  if (normalizedClientId !== clientId) {
    clientId = normalizedClientId;
    tokenClient = null;
    tokenClientId = '';
  }
  calendarId = String(nextCalendarId ?? '').trim() || 'primary';
  if (clientId && globalThis.document) loadGis().catch(() => {});
}

function isConfigured() {
  return clientId !== '';
}

function isSignedIn() {
  return getValidToken() !== null;
}

async function signIn({ silent = false, redirect = false } = {}) {
  if (!isConfigured()) {
    throw new GcalAuthError('Google OAuth クライアントIDが設定されていません');
  }
  const standalone = isStandalone();
  if (silent && standalone) {
    throw new GcalAuthError('サインインが必要です。設定画面からサインインしてください');
  }
  if (!silent && (redirect || standalone)) {
    if (pendingSignIn) settlePending(new GcalAuthError('前回のサインインを中断しました'));
    return redirectSignIn();
  }
  if (pendingSignIn) {
    if (silent) return pendingSignIn.promise;
    settlePending(new GcalAuthError('前回のサインインを中断しました'));
  }
  if (!globalThis.google?.accounts?.oauth2) await loadGis();
  const client = ensureTokenClient();
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pendingSignIn = { promise, resolve, reject, silent };
  try {
    client.requestAccessToken(silent ? { prompt: '' } : {});
  } catch (e) {
    settlePending(new GcalAuthError(e?.message || 'サインインを開始できませんでした'));
  }
  return promise;
}

function signOut() {
  const token = readToken();
  clearToken();
  const revoke = globalThis.google?.accounts?.oauth2?.revoke;
  if (token && typeof revoke === 'function') {
    try {
      revoke(token.access_token, () => {});
    } catch {}
  }
  notify(false);
}

function onAuthChange(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function readErrorMessage(response) {
  let message = '';
  try {
    const data = await response.json();
    message = data?.error?.message || '';
  } catch {}
  return message || response.statusText || '';
}

async function rawFetch(method, url, body, token, options = {}) {
  const headers = { Authorization: `Bearer ${token.access_token}`, ...(options.headers || {}) };
  const init = { method, headers };
  if (body !== undefined) {
    if (typeof body === 'string') {
      if (!headers['Content-Type']) headers['Content-Type'] = options.contentType || 'text/plain; charset=UTF-8';
      init.body = body;
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  return fetch(url, init);
}

async function apiFetch(method, url, body, allowStatuses = [], options = {}) {
  let token = getValidToken();
  if (!token) {
    await signIn({ silent: true }).catch((e) => {
      throw e instanceof GcalAuthError ? e : new GcalAuthError(e?.message);
    });
    token = getValidToken();
    if (!token) throw new GcalAuthError();
  }
  let response = await rawFetch(method, url, body, token, options);
  if (response.status === 401) {
    clearToken();
    try {
      await signIn({ silent: true });
    } catch (e) {
      notify(false);
      throw e instanceof GcalAuthError ? e : new GcalAuthError(e?.message);
    }
    token = getValidToken();
    if (!token) {
      notify(false);
      throw new GcalAuthError();
    }
    response = await rawFetch(method, url, body, token, options);
    if (response.status === 401) {
      clearToken();
      notify(false);
      throw new GcalAuthError();
    }
  }
  if (response.ok) {
    if (response.status === 204) return { status: response.status, data: null };
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }
  if (allowStatuses.includes(response.status)) {
    return { status: response.status, data: null };
  }
  throw new GcalApiError(response.status, await readErrorMessage(response));
}

function eventsUrl(eventId) {
  const base = `${API_BASE}${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, s, l];
}

function pickColorId(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [h, s, l] = rgbToHsl(rgb);
  if (s < 0.15) return '8';
  let best = null;
  let bestDist = Infinity;
  for (const [id, colorHex] of Object.entries(EVENT_COLORS)) {
    if (id === '8') continue;
    const [ch, , cl] = rgbToHsl(hexToRgb(colorHex));
    const dh = Math.min(Math.abs(h - ch), 360 - Math.abs(h - ch)) / 180;
    const dl = Math.abs(l - cl);
    const d = dh * dh + dl * dl * 0.25;
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

function buildSummary(task) {
  const title = String(task.title ?? '').trim();
  return task.priority === 'high' ? `【重要】${title}` : title;
}

function buildDescription(task, category) {
  const parts = [
    `カテゴリ: ${category?.name || 'なし'}`,
    `優先度: ${PRIORITY_LABEL[task.priority] || PRIORITY_LABEL.mid}`,
    `繰り返し: ${REPEAT_LABEL[task.repeat] || REPEAT_LABEL.none}`,
    `taskapp:${task.id}`,
  ];
  return parts.join(' / ');
}

const TIMED_EVENT_MINUTES = 30;

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
  } catch {
    return 'Asia/Tokyo';
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDateTime(ymd, hm, addMinutes = 0) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm + addMinutes, 0, 0);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:00`;
}

function buildEventTimes(task, { patch = false } = {}) {
  if (task.time) {
    const tz = localTimeZone();
    const start = { dateTime: localDateTime(task.due, task.time), timeZone: tz };
    const end = { dateTime: localDateTime(task.due, task.time, TIMED_EVENT_MINUTES), timeZone: tz };
    if (patch) {
      start.date = null;
      end.date = null;
    }
    return { start, end };
  }
  const start = { date: task.due };
  const end = { date: addDays(task.due, 1) };
  if (patch) {
    start.dateTime = null;
    start.timeZone = null;
    end.dateTime = null;
    end.timeZone = null;
  }
  return { start, end };
}

function buildEventBody(task, category, { patch = false } = {}) {
  if (!task?.due) {
    throw new Error('期限のないタスクはカレンダーに登録できません');
  }
  const body = {
    summary: buildSummary(task),
    description: buildDescription(task, category),
    ...buildEventTimes(task, { patch }),
    extendedProperties: { private: { taskappId: task.id } },
  };
  const colorId = pickColorId(category?.color);
  if (colorId) body.colorId = colorId;
  return body;
}

async function upsertEvent(task, category) {
  if (task.gcalEventId) {
    const patchBody = buildEventBody(task, category, { patch: true });
    const res = await apiFetch('PATCH', eventsUrl(task.gcalEventId), patchBody, [404, 410]);
    if (res.status !== 404 && res.status !== 410 && res.data?.id) {
      return res.data.id;
    }
  }
  const body = buildEventBody(task, category);
  const res = await apiFetch('POST', eventsUrl(), body);
  if (!res.data?.id) {
    throw new GcalApiError(res.status, 'イベントIDを取得できませんでした');
  }
  return res.data.id;
}

async function deleteEvent(eventId) {
  if (!eventId) return;
  await apiFetch('DELETE', eventsUrl(eventId), undefined, [404, 410]);
}

function compactYMD(ymd) {
  return ymd.replace(/-/g, '');
}

function buildTemplateUrl(task, category = null) {
  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  params.set('text', buildSummary(task));
  if (task.due && task.time) {
    const compact = (s) => s.replace(/[-:]/g, '');
    params.set('dates', `${compact(localDateTime(task.due, task.time))}/${compact(localDateTime(task.due, task.time, TIMED_EVENT_MINUTES))}`);
  } else if (task.due) {
    params.set('dates', `${compactYMD(task.due)}/${compactYMD(addDays(task.due, 1))}`);
  }
  params.set('details', buildDescription(task, category));
  return `${TEMPLATE_BASE}?${params.toString()}`;
}

export const authorizedFetch = apiFetch;

export const gcal = {
  configure,
  isConfigured,
  isSignedIn,
  signIn,
  signOut,
  onAuthChange,
  handleRedirectResult,
  upsertEvent,
  deleteEvent,
  buildTemplateUrl,
};
