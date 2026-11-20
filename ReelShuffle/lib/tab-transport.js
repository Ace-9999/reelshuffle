// Sends Instagram API requests through an open instagram.com tab (content.js), so they are
// same-origin requests made with the user's real Instagram session, not cross-site calls
// from the extension's own chrome-extension:// origin (which Instagram rejects).
const ORIGIN = 'https://www.instagram.com';
const IDLE_CLOSE_MS = 3 * 60 * 1000;

export function createTabTransport({ tabs = chrome.tabs, scripting = chrome.scripting } = {}) {
  let preferred = null;   // tab the user opened their Saved page in
  let owned = null;       // background tab we opened ourselves (closed when idle)
  let closeTimer = null;

  const isInstagram = tab => tab && !tab.discarded && typeof tab.url === 'string' && tab.url.startsWith(`${ORIGIN}/`);

  async function ping(tabId) {
    try { return (await tabs.sendMessage(tabId, { type: 'RS_PING' }))?.ok === true; } catch { return false; }
  }
  async function ready(tabId) {
    if (await ping(tabId)) return true;
    // Tabs opened before the extension was installed or reloaded have no content script yet.
    try { await scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch { return false; }
    return ping(tabId);
  }
  function waitForLoad(tabId) {
    return new Promise(resolve => {
      const done = ok => { clearTimeout(timer); tabs.onUpdated.removeListener(listener); resolve(ok); };
      const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
      const timer = setTimeout(() => done(false), 30000);
      tabs.onUpdated.addListener(listener);
      tabs.get(tabId).then(t => { if (t.status === 'complete') done(true); }, () => done(false));
    });
  }

  async function pickTab() {
    if (preferred != null) {
      try { const tab = await tabs.get(preferred); if (isInstagram(tab) && await ready(tab.id)) return tab.id; } catch {}
      preferred = null;
    }
    const open = (await tabs.query({ url: `${ORIGIN}/*` })).filter(isInstagram);
    open.sort((a, b) => (b.active === true) - (a.active === true));
    for (const tab of open) if (await ready(tab.id)) return tab.id;
    if (owned != null) {
      try { const tab = await tabs.get(owned); if (isInstagram(tab) && await ready(tab.id)) return tab.id; } catch {}
      owned = null;
    }
    // No usable Instagram tab: open one quietly in the background.
    const tab = await tabs.create({ url: `${ORIGIN}/`, active: false });
    owned = tab.id;
    if (!(await waitForLoad(tab.id)) || !(await ready(tab.id))) return null;
    return tab.id;
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    if (owned == null) return;
    closeTimer = setTimeout(() => {
      const id = owned; owned = null;
      if (id != null && id !== preferred) tabs.remove(id).catch(() => {});
    }, IDLE_CLOSE_MS);
  }

  // Same shape as fetch(): returns { status, ok, url, json() }.
  async function fetcher(url, options = {}) {
    clearTimeout(closeTimer);
    const { pathname, search } = new URL(url);
    let tabId;
    try { tabId = await pickTab(); } catch { tabId = null; }
    if (tabId == null) throw new Error('No Instagram tab available');
    let result;
    try {
      result = await tabs.sendMessage(tabId, {
        type: 'RS_FETCH', path: pathname + search, method: options.method || 'GET',
        headers: options.headers || {}, body: options.body,
      });
    } finally { scheduleClose(); }
    if (!result || result.error) throw new Error(result?.error || 'No response from Instagram tab');
    return {
      status: result.status, ok: result.status >= 200 && result.status < 300, url: result.url,
      contentKind: /^\s*</.test(result.text) ? 'HTML page' : result.text.trim() ? 'non-JSON text' : 'empty body',
      async json() { return JSON.parse(result.text.replace(/^\s*for \(;;\);/, '')); },
    };
  }

  async function bookmarkOnPage(shortcode, saved, before) {
    let tab;
    try {
      tab = await tabs.create({ url: 'about:blank', active: false });
      await tabs.update(tab.id, { url: `${ORIGIN}/p/${shortcode}/` });
      const check = async (change, previousPage) => {
        if (!(await waitForLoad(tab.id)) || !isInstagram(await tabs.get(tab.id)) || !(await ready(tab.id))) return null;
        if (change) before?.();
        return tabs.sendMessage(tab.id, { type: 'RS_BOOKMARK', shortcode, saved, change, previousPage });
      };
      const result = await check(true);
      if (!result?.changed) return result;
      // Instagram can update the icon optimistically. Verify the bookmark on a new page load.
      await tabs.reload(tab.id, { bypassCache: true });
      return await check(false, result.page);
    } catch (err) {
      if (err.code === 'CANCELLED') throw err;
      return null;
    } finally {
      if (tab) await tabs.remove(tab.id).catch(() => {});
    }
  }

  return {
    fetcher, bookmarkOnPage,
    prefer(tabId) { preferred = tabId; },
    forget(tabId) { if (preferred === tabId) preferred = null; if (owned === tabId) owned = null; },
    notify(state) {
      const ids = new Set([preferred, owned].filter(id => id != null));
      for (const id of ids) tabs.sendMessage(id, { type: 'RS_STATUS', state }).catch(() => {});
    },
  };
}
