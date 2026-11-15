import { getReels, putReels, deleteReel, getMeta, setMeta, clearDB, reconcile } from './lib/db.js';
import { DEFAULT_SETTINGS, settingsWithDefaults, cleanRecord } from './lib/model.js';
import { InstagramClient, InstagramError } from './lib/instagram.js';
import { createTabTransport } from './lib/tab-transport.js';

// Every Instagram call runs inside an instagram.com tab (see content.js), using the real logged-in session.
const transport = createTabTransport();
const api = new InstagramClient({ fetcher: transport.fetcher });
let settings = { ...DEFAULT_SETTINGS };
let state = { phase: 'idle', loaded: 0, message: 'Ready when you are', lastSync: null };
let syncPromise = null, sessionPromise = null, verified = false, generation = 0;
let suppressed = new Set(), seen = null;
let mutations = Promise.resolve();
const resolving = new Map();
const ready = (async () => {
  const stored = await chrome.storage.local.get(['settings']);
  settings = settingsWithDefaults(stored.settings);
  api.delay = settings.requestDelay === 'slow' ? 2500 : 1500;
  state.lastSync = await getMeta('lastSync') || null;
  const previous = (await chrome.storage.session.get('state')).state;
  if (previous?.phase === 'error') state = { ...previous, lastSync: state.lastSync };
  else if (previous?.phase === 'syncing') state.message = 'Refresh interrupted. Press Refresh to finish it.';
})();

function broadcast(message) { chrome.runtime.sendMessage(message).catch(() => {}); }
async function updateState(patch) {
  state = { ...state, ...patch };
  await chrome.storage.session.set({ state });
  broadcast({ type: 'STATE_CHANGED', state });
  transport.notify(state);
}
function publicError(err) {
  return { code: err.code || 'LOCAL', message: err.code ? err.message : 'Something went wrong locally. Please reopen the feed.', retryAt: err.retryAt || null };
}
async function reportError(err) {
  const detail = publicError(err);
  if (['AUTH', 'RATE_LIMIT', 'CHALLENGE', 'FORMAT'].includes(detail.code)) verified = false;
  await updateState({ phase: 'error', ...detail });
  return detail;
}

async function ensureSession(force = false) {
  if (sessionPromise) return sessionPromise;
  if (verified && !force) return;
  sessionPromise = (async () => {
    const user = await api.session();
    const owner = await getMeta('owner');
    if (owner && owner !== user.id) {
      await clearDB();
      broadcast({ type: 'CACHE_CHANGED', reset: true });
    }
    await setMeta('owner', user.id);
    verified = true;
    if (user.username) await updateState({ username: user.username });
  })();
  try { await sessionPromise; } finally { sessionPromise = null; }
}

async function sync() {
  await ready;
  if (syncPromise) return syncPromise;
  const ownGeneration = ++generation;
  const cancelled = () => {
    if (generation !== ownGeneration) throw new InstagramError('CANCELLED', 'Refresh cancelled');
  };
  suppressed = new Set();
  seen = new Set();
  syncPromise = (async () => {
    try {
      await api.resume();
      await updateState({ phase: 'syncing', code: null, retryAt: null, loaded: 0, message: 'Checking your Instagram session…' });
      await ensureSession(true);
      cancelled();
      let cursor = null, pages = 0;
      const cursors = new Set();
      do {
        cancelled();
        const page = await api.saved(cursor, settings.includeNonReels, cancelled);
        cancelled();
        const records = page.reels.filter(reel => !suppressed.has(reel.shortcode));
        for (const reel of records) seen.add(reel.shortcode);
        await putReels(records);
        cancelled();
        pages++;
        await updateState({ loaded: seen.size, message: `Loaded ${seen.size.toLocaleString()} ${settings.includeNonReels ? 'posts' : 'reels'}…` });
        broadcast({ type: 'CACHE_CHANGED' });
        cursor = page.cursor;
        if (cursor && cursors.has(cursor)) throw await api.halt(new InstagramError('FORMAT', 'Instagram changed its format. Pagination repeated; your cache is preserved.'));
        if (cursor) cursors.add(cursor);
        if (pages > 10000) throw new InstagramError('FORMAT', 'Instagram changed its format. Refresh stopped safely.');
      } while (cursor);
      cancelled();
      await reconcile(seen, Date.now());
      await chrome.storage.local.remove('blockFailures');
      const count = (await getReels()).length;
      await updateState({ phase: 'ready', loaded: count, lastSync: Date.now(), message: 'All caught up', code: null, retryAt: null });
      broadcast({ type: 'CACHE_CHANGED' });
    } catch (err) {
      if (err.code !== 'CANCELLED') await reportError(err);
    } finally { syncPromise = null; seen = null; }
    return state;
  })();
  return syncPromise;
}

async function bookmark(record, saved) {
  const reel = cleanRecord(record);
  const run = async () => {
    await ensureSession();
    if (!saved) suppressed.add(reel.shortcode);
    try {
      await api.bookmark(reel.mediaId, saved);
      if (saved) {
        suppressed.delete(reel.shortcode);
        seen?.add(reel.shortcode);
        await putReels([reel]);
      } else {
        seen?.delete(reel.shortcode);
        await deleteReel(reel.shortcode);
      }
      broadcast({ type: 'CACHE_CHANGED', shortcode: reel.shortcode, saved });
      return { saved };
    } catch (err) {
      if (!saved) suppressed.delete(reel.shortcode);
      throw err;
    }
  };
  const result = mutations.then(run);
  mutations = result.catch(() => {});
  return result;
}

async function handle(message) {
  await ready;
  switch (message.type) {
    case 'GET_STATE': return { state, settings };
    case 'SYNC': void sync(); return { started: true };
    case 'CANCEL_SYNC': generation++; if (syncPromise) await syncPromise; await updateState({ phase: 'idle', message: 'Refresh paused. Cache kept.' }); return {};
    case 'RESOLVE': {
      const requestId = String(message.requestId || crypto.randomUUID());
      const request = { cancelled: false }; resolving.set(requestId, request);
      try {
        await ensureSession();
        return await api.resolve(String(message.mediaId), () => {
          if (request.cancelled) throw new InstagramError('CANCELLED', 'This reel is no longer near the viewport.');
        });
      } finally { resolving.delete(requestId); }
    }
    case 'COMMENTS':
      await ensureSession();
      return api.comments(String(message.mediaId), message.cursor ?? null);
    case 'CANCEL_RESOLVE':
      if (resolving.has(message.requestId)) resolving.get(message.requestId).cancelled = true;
      return {};
    case 'BOOKMARK': return bookmark(message.reel, message.saved === true);
    case 'SETTINGS':
      settings = settingsWithDefaults(message.settings);
      api.delay = settings.requestDelay === 'slow' ? 2500 : 1500;
      await chrome.storage.local.set({ settings });
      broadcast({ type: 'SETTINGS_CHANGED', settings });
      return { settings };
    case 'CLEAR':
      generation++;
      if (syncPromise) await syncPromise;
      await mutations;
      await clearDB();
      await chrome.storage.local.remove('settings');
      await chrome.storage.session.remove('state');
      settings = { ...DEFAULT_SETTINGS }; api.delay = 1500; verified = false;
      // Safety cooldown is intentionally retained: clearing data cannot bypass a block.
      await updateState({ phase: 'idle', loaded: 0, lastSync: null, username: null, code: null, retryAt: null, message: 'Local library cleared' });
      broadcast({ type: 'CACHE_CHANGED', reset: true });
      return { settings };
    default: throw new InstagramError('INPUT', 'Unknown extension request');
  }
}

// Opening your Saved page on instagram.com syncs the full saved library from that tab.
async function savedPageOpened(tabId, path) {
  await ready;
  transport.prefer(tabId);
  const username = /^\/([A-Za-z0-9._]{1,30})\/saved(\/|$)/.exec(String(path || ''))?.[1];
  if (username && username !== state.username) await updateState({ username });
  if (syncPromise) { transport.notify(state); return; }
  const recent = state.phase === 'ready' && state.lastSync && Date.now() - state.lastSync < 60000;
  if (recent) { transport.notify(state); return; }
  void sync();
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id === chrome.runtime.id && sender.tab?.url?.startsWith('https://www.instagram.com/')) {
    if (message?.type === 'SAVED_PAGE_OPENED') void savedPageOpened(sender.tab.id, message.path);
    return false;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('feed.html')) || typeof message?.type !== 'string') return false;
  handle(message).then(data => respond({ ok: true, data })).catch(async err => {
    if (['AUTH', 'RATE_LIMIT', 'CHALLENGE', 'FORMAT'].includes(err.code)) await reportError(err);
    respond({ ok: false, error: publicError(err) });
  });
  return true;
});

chrome.tabs.onRemoved?.addListener(tabId => transport.forget(tabId));

// Earlier versions called Instagram from the extension origin, which Instagram rejected and which
// was recorded as a safety pause. Those pauses were caused by the old transport, so drop them on update.
chrome.runtime.onInstalled?.addListener(async ({ reason }) => {
  if (reason !== 'update') return;
  await chrome.storage.local.remove(['apiBlock', 'blockFailures']);
  await api.ready; api.block = null;
  if (state.phase === 'error') await updateState({ phase: 'idle', code: null, retryAt: null, message: 'Updated. Open your Instagram Saved page or press Refresh.' });
});

let launching = false;
chrome.action.onClicked.addListener(async () => {
  if (launching) return;
  launching = true;
  try {
    const url = chrome.runtime.getURL('feed.html');
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
    if (contexts[0]) {
      await chrome.tabs.update(contexts[0].tabId, { active: true });
      await chrome.windows.update(contexts[0].windowId, { focused: true });
    } else await chrome.tabs.create({ url });
  } finally { launching = false; }
});
