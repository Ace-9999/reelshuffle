// Runs inside your logged-in instagram.com tab.
// 1. Makes ReelShuffle's Instagram API calls from instagram.com itself with the same-origin session.
// 2. When you open your Saved page, it tells ReelShuffle to sync your whole saved library.
// Request tokens are used only inside the Instagram tab and sent only to Instagram.
(() => {
  if (window.__reelShuffleLoaded) return;
  window.__reelShuffleLoaded = true;

  const API_PREFIX = '/api/v1/';
  const POST_QUERY = 'PolarisPostRootQuery';
  const SAVED_PAGE = /^\/[^/]+\/saved(\/|$)/;

  function cookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function apiFetch({ path, method = 'GET', headers = {}, body }) {
    const postQuery = path === '/api/graphql' && method === 'POST';
    if (typeof path !== 'string' || (!path.startsWith(API_PREFIX) && !postQuery)) return { error: 'INPUT' };
    if (!['GET', 'POST'].includes(method)) return { error: 'INPUT' };
    const sendHeaders = { ...headers };
    if (postQuery) {
      const form = new URLSearchParams(body);
      if (form.get('fb_api_req_friendly_name') !== POST_QUERY) return { error: 'INPUT' };
      const bootstrap = Array.from(document.querySelectorAll('script[type="application/json"]'), script => script.textContent).join('\n');
      const dtsg = /"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{[^{}]*"token"\s*:\s*"([^"]+)"/.exec(bootstrap)?.[1]
        || /"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/.exec(bootstrap)?.[1];
      const lsd = /"LSD"\s*,\s*\[\s*\]\s*,\s*\{[^{}]*"token"\s*:\s*"([^"]+)"/.exec(bootstrap)?.[1];
      const viewer = /"IG_USER_EIMU"\s*:\s*"?(\d+)/.exec(bootstrap)?.[1];
      if (dtsg) form.set('fb_dtsg', dtsg);
      if (viewer) form.set('av', viewer);
      if (lsd) {
        form.set('lsd', lsd);
        sendHeaders['X-FB-LSD'] = lsd;
      }
      sendHeaders['X-FB-Friendly-Name'] = POST_QUERY;
      body = form.toString();
    }
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
        method, headers: sendHeaders, credentials: 'include', cache: 'no-store', redirect: postQuery ? 'error' : 'follow',
        signal: controller.signal, ...(method === 'POST' ? { body: body ?? '' } : {}),
      });
      return { status: response.status, url: response.url, text: await response.text() };
    } catch {
      return { error: 'NETWORK' };
    } finally { clearTimeout(timer); }
  }

  function bookmarkControl(shortcode) {
    if (/^\/accounts\/login(?:\/|$)/.test(location.pathname) || document.querySelector('input[name="password"]')) return { code: 'AUTH' };
    if (/^\/(?:challenge|checkpoint|accounts\/suspended)(?:\/|$)/.test(location.pathname)) return { code: 'CHALLENGE' };
    const notices = [...document.querySelectorAll('[role="dialog"], [role="alert"]')].map(node => node.textContent).join(' ');
    if (/try again later|action blocked|restrict certain activity|limit how often/i.test(notices)) return { code: 'RATE_LIMIT' };
    const postCode = pathname => /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel)\/([A-Za-z0-9_-]+)\/?$/.exec(pathname)?.[1];
    if (postCode(location.pathname) !== shortcode) return {};
    const main = document.querySelector('main, [role="main"]');
    if (!main) return {};
    const linkedPosts = article => [...article.querySelectorAll('a[href]')]
      .filter(link => link.origin === location.origin).map(link => postCode(link.pathname)).filter(Boolean);
    const article = [...main.querySelectorAll('article')].find(post => linkedPosts(post).includes(shortcode));
    const controls = [...(article || main).querySelectorAll('svg[aria-label="Save"], svg[aria-label="Remove"], svg[aria-label="Unsave"]')]
      .map(icon => ({ button: icon.closest('button, [role="button"]'), saved: icon.getAttribute('aria-label') !== 'Save', icon }))
      .filter(({ button, icon }) => {
        if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true'
          || !icon.getClientRects().length || getComputedStyle(icon).visibility !== 'visible') return false;
        const post = button.closest('article');
        return !post || post === article || linkedPosts(post).length === 0;
      });
    return controls.length === 1 ? controls[0] : {};
  }

  async function bookmarkPage({ shortcode, saved, change, previousPage }) {
    if (typeof saved !== 'boolean' || !/^[A-Za-z0-9_-]{1,80}$/.test(shortcode || '') || previousPage === performance.timeOrigin) return {};
    const expires = Date.now() + 6000;
    let changed = false;
    do {
      const control = bookmarkControl(shortcode);
      if (control.code) return { code: control.code };
      if (control.button && control.saved === saved) return { ok: true, changed, page: performance.timeOrigin };
      if (control.button && !change) return {};
      if (control.button && !changed) {
        control.button.click();
        changed = true;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < expires);
    return {};
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'RS_PING') { respond({ ok: true }); return false; }
    if (message?.type === 'RS_FETCH') { apiFetch(message).then(respond); return true; }
    if (message?.type === 'RS_BOOKMARK') { bookmarkPage(message).then(respond, () => respond({})); return true; }
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
