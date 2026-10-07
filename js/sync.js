const DEBOUNCE_MS = 2000;
const VISIBLE_PULL_INTERVAL_MS = 30 * 1000;

function sortById(items) {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortedEntries(obj) {
  return Object.entries(obj || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function canonical(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return JSON.stringify({
    tasks: sortById(Array.isArray(payload.tasks) ? payload.tasks : []),
    categories: sortById(Array.isArray(payload.categories) ? payload.categories : []),
    deleted: sortedEntries(payload.deleted),
  });
}

function isOffline() {
  return typeof globalThis.navigator !== 'undefined' && globalThis.navigator.onLine === false;
}

export function createSync({ store, gcal, drive, onStatus, afterPull }) {
  let status = { state: gcal.isSignedIn() ? 'idle' : 'signed-out', lastSyncedAt: null, message: '' };
  let applyingRemote = false;
  let inFlight = null;
  let queued = null;
  let debounceTimer = null;
  let lastPullAt = 0;
  let lastCanonical = null;
  let pendingWhileOffline = false;
  let started = false;

  function setStatus(next) {
    status = { ...status, ...next };
    if (typeof onStatus === 'function') {
      try {
        onStatus(status);
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function run({ forcePush = false } = {}) {
    if (!gcal.isSignedIn()) {
      setStatus({ state: 'signed-out', message: '' });
      return;
    }
    if (isOffline()) {
      pendingWhileOffline = true;
      setStatus({ state: 'idle', message: 'オフラインのため同期を保留しています' });
      return;
    }
    setStatus({ state: 'syncing', message: '' });
    try {
      const remote = await drive.pull();
      lastPullAt = Date.now();
      if (remote && remote.state) {
        applyingRemote = true;
        try {
          store.mergeRemote(remote.state);
        } finally {
          applyingRemote = false;
        }
      }
      if (typeof afterPull === 'function') {
        applyingRemote = true;
        try {
          await afterPull();
        } catch (e) {
          console.error(e);
        } finally {
          applyingRemote = false;
        }
      }
      const local = store.getSyncPayload();
      const localCanonical = canonical(local);
      const remoteCanonical = remote ? canonical(remote.state) : null;
      if (forcePush || localCanonical !== remoteCanonical) {
        await drive.push(local);
      }
      lastCanonical = localCanonical;
      pendingWhileOffline = false;
      setStatus({ state: 'synced', lastSyncedAt: new Date().toISOString(), message: '' });
    } catch (err) {
      console.error(err);
      if (!gcal.isSignedIn()) {
        setStatus({ state: 'signed-out', message: err?.message || '' });
        return;
      }
      setStatus({ state: 'error', message: err?.message || String(err) });
    }
  }

  function schedule(options = {}) {
    if (inFlight) {
      queued = { ...(queued || {}), ...options };
      return inFlight;
    }
    inFlight = run(options).finally(() => {
      inFlight = null;
      if (queued) {
        const next = queued;
        queued = null;
        schedule(next);
      }
    });
    return inFlight;
  }

  function onStoreChange() {
    if (applyingRemote) return;
    if (!gcal.isSignedIn()) return;
    if (lastCanonical !== null && canonical(store.getSyncPayload()) === lastCanonical) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      schedule();
    }, DEBOUNCE_MS);
  }

  function onVisibilityChange() {
    if (globalThis.document?.visibilityState !== 'visible') return;
    if (!gcal.isSignedIn()) return;
    if (Date.now() - lastPullAt < VISIBLE_PULL_INTERVAL_MS) return;
    schedule();
  }

  function onOnline() {
    if (!gcal.isSignedIn()) return;
    if (pendingWhileOffline || status.state === 'error') schedule();
  }

  function start() {
    if (started) return;
    started = true;
    store.subscribe(onStoreChange);
    gcal.onAuthChange((signedIn) => {
      if (signedIn) {
        schedule();
      } else {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        lastCanonical = null;
        setStatus({ state: 'signed-out', message: '' });
      }
    });
    globalThis.document?.addEventListener?.('visibilitychange', onVisibilityChange);
    globalThis.addEventListener?.('online', onOnline);
    if (gcal.isSignedIn()) schedule();
    else setStatus({ state: 'signed-out', message: '' });
  }

  function pullNow() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return schedule();
  }

  function pushNow() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return schedule({ forcePush: true });
  }

  function getStatus() {
    return status;
  }

  return { start, pullNow, pushNow, getStatus };
}
