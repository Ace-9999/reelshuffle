// Runs inside your logged-in instagram.com tab.
// 1. Makes ReelShuffle's Instagram API calls from instagram.com itself (same origin, your real session),
//    so Instagram sees exactly what its own web app would send.
// 2. When you open your Saved page, it tells ReelShuffle to sync your whole saved library.
// It never reads, stores or forwards cookies, passwords or tokens. It only adds the CSRF header Instagram expects.
(() => {
  if (window.__reelShuffleLoaded) return;
  window.__reelShuffleLoaded = true;

  const API_PREFIX = '/api/v1/';
  const SAVED_PAGE = /^\/[^/]+\/saved(\/|$)/;

  function cookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function apiFetch({ path, method = 'GET', headers = {}, body }) {
    if (typeof path !== 'string' || !path.startsWith(API_PREFIX)) return { error: 'INPUT' };
    if (!['GET', 'POST'].includes(method)) return { error: 'INPUT' };
    const sendHeaders = { ...headers };
    const csrf = cookie('csrftoken');
    if (csrf) sendHeaders['X-CSRFToken'] = csrf;
    try {
      const claim = sessionStorage.getItem('www-claim-v2');
      if (claim) sendHeaders['X-IG-WWW-Claim'] = claim;
    } catch {}
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        method, headers: sendHeaders, credentials: 'include', cache: 'no-store', redirect: 'follow',
        signal: controller.signal, ...(method === 'POST' ? { body: body ?? '' } : {}),
      });
      return { status: response.status, url: response.url, text: await response.text() };
    } catch {
      return { error: 'NETWORK' };
    } finally { clearTimeout(timer); }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'RS_PING') { respond({ ok: true }); return false; }
    if (message?.type === 'RS_FETCH') { apiFetch(message).then(respond); return true; }
    if (message?.type === 'RS_STATUS') { showStatus(message.state); return false; }
    return false;
  });

  // Small status pill on the Saved page, so you can see the sync happening.
  let pill, hideTimer;
  function showStatus(state) {
    if (!state || !SAVED_PAGE.test(location.pathname)) return;
    if (!pill) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
      const root = host.attachShadow({ mode: 'closed' });
      pill = document.createElement('div');
      pill.setAttribute('role', 'status');
      pill.style.cssText = 'font:500 13px system-ui,sans-serif;color:#fff;background:#1f1f23;border:1px solid #3a3a40;padding:9px 14px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.35)';
      root.append(pill);
      document.documentElement.append(host);
    }
    clearTimeout(hideTimer);
    pill.parentNode.host.style.display = '';
    const label = state.phase === 'syncing' ? state.message
      : state.phase === 'ready' ? `ReelShuffle: ${Number(state.loaded || 0).toLocaleString()} saved reels synced`
      : state.phase === 'error' ? `ReelShuffle: ${state.message}` : state.message;
    pill.textContent = label.startsWith('ReelShuffle') ? label : `ReelShuffle: ${label}`;
    if (state.phase !== 'syncing') hideTimer = setTimeout(() => { pill.parentNode.host.style.display = 'none'; }, 8000);
  }

  // Instagram is a single-page app, so watch for navigation to the Saved page.
  let lastPath = '';
  function checkPage() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (SAVED_PAGE.test(lastPath)) chrome.runtime.sendMessage({ type: 'SAVED_PAGE_OPENED', path: lastPath }).catch(() => {});
  }
  checkPage();
  setInterval(checkPage, 1000);
})();
