import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.cwd();
const extension = path.join(root, 'ReelShuffle');
// An empty path makes Playwright use and clean up a temporary browser profile.
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP www.instagram.com 127.0.0.1, MAP *.cdninstagram.com 127.0.0.1'],
});
const errors = [];
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
const origin = `chrome-extension://${id}`;
console.log('Loaded MV3 extension', id);

const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="854" viewBox="0 0 480 854"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#7b9cba"/><stop offset=".6" stop-color="#d8c6b9"/><stop offset="1" stop-color="#cf9a80"/></linearGradient><linearGradient id="land" x2=".2" y2="1"><stop stop-color="#334e57"/><stop offset="1" stop-color="#132d35"/></linearGradient></defs><rect width="480" height="854" fill="url(#sky)"/><circle cx="360" cy="265" r="38" fill="#f4d8b0" opacity=".8"/><path d="M0 440 110 305 235 460 345 330 480 475V854H0" fill="#65808b"/><path d="m0 562 133-169 141 144 90-108 116 117v308H0" fill="#405e69"/><path d="M0 650 120 530 260 660 390 506 480 580V854H0" fill="url(#land)"/><path d="M180 854q80-96 75-180t83-122" fill="none" stroke="#c1b5a1" stroke-width="4" opacity=".6"/><text x="24" y="45" fill="#fff9" font-family="sans-serif" font-size="10" letter-spacing="3">TEST LIBRARY · LOCAL FIXTURE</text></svg>`;
// Three seconds of VP9 so the playback check does not depend on browser capture support.
const video = Buffer.from([
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAALFEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZU',
  'rmtTrIHWTbuMU6uEElTDZ1OsggEnTbuMU6uEHFO7a1OsggKv7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxM',
  'YXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAp3AAAAAAABZUrmvMrgEAAAAAAABD14EBc8WIyAfXPnUrwQacgQAitZyDdW5k',
  'iIEAhoVWX1ZQOYOBASPjg4QdzWUA4JSwgSS6gUCagQJVsIhVt4ECVbiBAhJUw2f+c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2',
  'MS4xLjEwMHNz2WPAi2PFiMgH1z51K8EGZ8ikRaOHRU5DT0RFUkSHl0xhdmM2MS4zLjEwMCBsaWJ2cHgtdnA5Z8ihRaOIRFVSQVRJ',
  'T05Eh5MwMDowMDowMy4wMDAwMDAwMDAAH0O2dUD/54EAo0CLgQAAgIJJg0IAAjAD9gA4JBwYSgAAMHAAAGzgf//+tB///+TYJWJM',
  '6TJ9SAa2L3//iucj2/dtduLXb6ZoDtEugPrv4KgD+2XrRhnQMeRpWYFUiaRAc//feTzz4gm6RzXYbTbLy31P/YGJ6BojVNBfjUdI',
  'WVta/wDPsJVf1rq/FdfrxDOJjgVDsZvsAKOUgQH0AIYAQJKcAFAAAAMgAABUAACjlIED6ACGAECSnABO4AADIAAAVAAAo5SBBdwA',
  'hgBAkpwAUAAAAyAAAFQAAKOUgQfQAIYAQJKcAE1AAAMgAABUAACjlIEJxACGAECSnABQAAADIAAAVAAAHFO7a5G7j7OBALeK94EB',
  '8YIBqvCBAw==',
].join(''), 'base64');
const makeFixture = i => ({ media: { pk: String(1000 + i), code: `Fixture_${i}`, media_type: 2, user: { username: ['the.wandering.frame','slowmornings','somewhere.outside'][i % 3] }, caption: { text: ['Some places make you forget to check your phone. A quiet morning, a long way from the rush.','Keeping a little room for the things worth coming back to.','A different view. The same feeling.'][i % 3] }, image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/fixture.jpg' }] } } });
let fixtures = Array.from({ length: 45 }, (_, i) => makeFixture(i));
await context.addCookies(['csrftoken', 'sessionid', 'ds_user_id'].map(name => ({ name, value: name === 'ds_user_id' ? '99999' : 'fixture-only', domain: '.instagram.com', path: '/', secure: true, sameSite: 'None' })));
// A stand-in instagram.com: HTML pages get the real content script and API calls are answered here.
// Every API request must arrive as a same-origin call from the instagram.com tab, never from the extension origin.
const fixture = { mode: 'normal', requests: [], mutations: [], fixtures, pages: 0, postLoads: [], bookmarkClicks: [] };
await context.route('https://www.instagram.com/**', async route => {
  const request = route.request(), url = request.url(), mode = fixture.mode;
  const { pathname, searchParams } = new URL(url);
  const html = (status, body) => route.fulfill({ status, contentType: 'text/html', body });
  const shortcode = /^\/p\/(Fixture_\d+)\/$/.exec(pathname)?.[1];
  if (shortcode) {
    fixture.postLoads.push(shortcode);
    const saved = fixture.fixtures.some(record => record.media.code === shortcode);
    return html(200, `<!doctype html><title>Instagram</title><main><article><a href="${pathname}">Post</a>
      <button onclick="this.querySelector('svg').setAttribute('aria-label', 'Save'); fetch('/fixture/unsave/${shortcode}', { method: 'POST' });">
        <svg aria-label="${saved ? 'Remove' : 'Save'}" width="20" height="20"></svg>
      </button></article></main>`);
  }
  const unsaved = /^\/fixture\/unsave\/(Fixture_\d+)$/.exec(pathname)?.[1];
  if (unsaved) {
    assert.equal(request.method(), 'POST');
    fixture.bookmarkClicks.push(unsaved);
    if (mode !== 'optimistic-only') fixture.fixtures = fixture.fixtures.filter(record => record.media.code !== unsaved);
    return route.fulfill({ status: mode === 'optimistic-only' ? 500 : 200, body: '' });
  }
  if (!pathname.startsWith('/api/v1/') && pathname !== '/api/graphql') {
    return html(200, '<!doctype html><title>Instagram</title><script type="application/json">[["DTSGInitialData",[],{"token":"fixture-page-token"}],["LSD",[],{"token":"fixture-lsd"}]]</script>');
  }
  fixture.requests.push(url);
  const headers = request.headers();
  assert.equal(headers['x-csrftoken'], 'fixture-only');
  assert.doesNotMatch(headers.origin || '', /^chrome-extension:/);
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (mode === 'auth') return json({ message: 'login_required', status: 'fail' }, 401);
  if (url.includes('/feed/saved/posts/')) {
    fixture.pages++;
    if (mode === '429') return json({}, 429);
    if (searchParams.has('count') || mode === 'format') return html(404, '<!doctype html><title>Not found</title>');
    return json({ status: 'ok', items: fixture.savedPageLag || fixture.fixtures, more_available: false });
  }
  if (url.includes('/media/') && url.includes('/info/')) return html(404, '<!doctype html><title>Not found</title>');
  if (pathname === '/api/graphql') {
    assert.equal(request.method(), 'POST');
    assert.equal(headers['x-fb-friendly-name'], 'PolarisPostRootQuery');
    const form = new URLSearchParams(request.postData());
    assert.equal(form.get('fb_dtsg'), 'fixture-page-token');
    assert.equal(form.get('lsd'), headers['x-fb-lsd']);
    assert.equal(form.get('doc_id'), '27128499623469141');
    assert.match(JSON.parse(form.get('variables')).shortcode, /^(Fixture|Large)_\d+$/);
    const items = [{ media_type: 2, video_versions: [{ width: 720, url: 'https://video.cdninstagram.com/fixture.webm' }] }];
    const body = { data: { xdt_api__v1__media__shortcode__web_info: { items } } };
    return route.fulfill({ contentType: 'application/json', body: `for (;;);${JSON.stringify(body)}` });
  }
  if (url.includes('/web/save/')) {
    fixture.mutations.push(url);
    return html(404, '<!doctype html><title>Not found</title>');
  }
  throw new Error(`Unexpected Instagram endpoint: ${url}`);
});
// Opening the Saved page on Instagram must sync the whole library on its own.
const igPage = await context.newPage();
await igPage.goto('https://www.instagram.com/your.library/saved/');
for (let i = 0; i < 300 && fixture.pages === 0; i++) await new Promise(r => setTimeout(r, 100));
assert.ok(fixture.pages > 0, 'Opening the Saved page did not start a sync');
console.log('Opening instagram.com/<user>/saved/ started a sync through the Instagram tab');
const setMode = value => { fixture.mode = value; };
const getRequests = async () => fixture.requests;
// Like a real CDN, the fixture video supports byte ranges, so looping (a seek back to 0) works.
await context.route('https://**.cdninstagram.com/**', route => {
  if (!route.request().url().endsWith('.webm')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: artwork });
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
  if (!range) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes' }, body: video });
  const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
  return route.fulfill({ status: 206, contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${video.length}` }, body: video.subarray(start, end + 1) });
});

const page = await context.newPage();
page.on('pageerror', err => errors.push(err.message));
page.on('console', msg => { if (msg.type() === 'error') console.log('Browser console:', msg.text()); });
process.on('uncaughtException', async err => {
  console.error(err);
  console.error('Requests:', fixture.requests.map(u => new URL(u).pathname).slice(-15), 'Errors:', errors);
  console.error('Bookmark post loads and clicks:', fixture.postLoads, fixture.bookmarkClicks);
  try { console.error('Videos:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('video')].map(v => [v.src.slice(0, 60), v.error?.code, v.error?.message, v.readyState, v.networkState])))); } catch {}
  try { console.error(await page.locator('body').innerText()); } catch {}
  await context.close(); process.exit(1);
});
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(`${origin}/feed.html`);
await page.locator('#saved-count').filter({ hasText: '45 saved' }).waitFor({ timeout: 25000 });
await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => !v.paused && v.currentTime > 0));
await page.waitForFunction(() => document.querySelector('#sync-status').textContent.startsWith('All caught up'));
assert.ok(fixture.requests.some(url => url.includes('/info/')));
assert.ok(fixture.requests.some(url => url.endsWith('/api/graphql')));
console.log('Synced first page and autoplayed fixture video after an HTML 404');

async function checkReelFrame() {
  const frame = await page.locator('#feed').evaluate(feed => {
    const bounds = feed.getBoundingClientRect();
    return { top: bounds.top, bottom: innerHeight - bounds.bottom, height: innerHeight, radius: getComputedStyle(feed).borderTopLeftRadius };
  });
  assert.ok(Math.abs(frame.top - frame.height * .03) <= 1);
  assert.ok(Math.abs(frame.bottom - frame.height * .03) <= 1);
  assert.equal(frame.radius, '18px');
}
await checkReelFrame();

assert.ok(await page.locator('.reel-card').count() <= 4);
assert.ok(await page.locator('video[src]').count() <= 3);
await page.waitForFunction(() => [...document.querySelectorAll('video')].filter(v => !v.paused).length === 1, null, { timeout: 10000 });
const initialOrder = await page.locator('.reel-card').first().getAttribute('data-shortcode');
await page.keyboard.press('j');
await page.waitForFunction(() => document.querySelector('#position').textContent.startsWith('02'));
await page.waitForFunction(() => [...document.querySelectorAll('video')].filter(v => !v.paused).length === 1);
assert.ok(await page.locator('video[src]').count() <= 3);
await page.keyboard.press('m');
assert.equal(await page.locator('#mute').getAttribute('aria-pressed'), 'false');
await page.keyboard.press('Space');
assert.equal(await page.locator('video').evaluateAll(v => v.filter(x => !x.paused).length), 0);
await page.keyboard.press('Space');
await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => !v.paused));
console.log('Verified keyboard, single active video, lazy loading and mute');

await page.locator('#unsave').click();
await page.locator('#toast-undo').click();
await page.waitForFunction(() => document.querySelector('#toast-text').textContent.includes('Restored to your library'));
assert.equal(fixture.mutations.length, 0);
await page.locator('#saved-count').filter({ hasText: '45 saved' }).waitFor();
console.log('Verified local unsave and Undo through worker and IndexedDB');

await page.reload();
await page.locator('#player-shell').waitFor({ state: 'visible' });
assert.notEqual(await page.locator('.reel-card').first().getAttribute('data-shortcode'), initialOrder);
await page.waitForFunction(() => document.querySelector('#sync-status').textContent.startsWith('All caught up'));
console.log('Verified cache launch and different order on reload');

await page.locator('#settings-open').click();
await page.locator('#settings-dialog').waitFor({ state: 'visible' });
await page.locator('[data-close="settings-dialog"]').click();
await page.setViewportSize({ width: 390, height: 844 });
await checkReelFrame();
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
await page.setViewportSize({ width: 1440, height: 1000 });

async function queueUnsave(count) {
  const original = new URL(await page.locator('#open-reel').getAttribute('href'));
  const shortcode = original.pathname.split('/')[2];
  await page.locator('#unsave').click();
  await page.locator('#saved-count').filter({ hasText: `${count} saved` }).waitFor();
  return shortcode;
}

const removed = await queueUnsave(44);
fixture.savedPageLag = fixture.fixtures;
await page.locator('#refresh').click();
await page.locator('#sync-status').filter({ hasText: '1 unsaved on Instagram' }).waitFor();
assert.match(await page.locator('#sync-status').textContent(), /No new saves/);
fixture.savedPageLag = null;
assert.equal(fixture.mutations.length, 1);
assert.deepEqual(fixture.bookmarkClicks, [removed]);
assert.deepEqual(fixture.postLoads, [removed, removed]);
assert.ok(!fixture.fixtures.some(record => record.media.code === removed));
assert.ok(!context.pages().some(tab => tab.url().includes(`/p/${removed}/`)));
console.log('Verified an unsave HTML 404 falls back to the bookmark control and confirms it after reload');

await setMode('optimistic-only');
const pending = await queueUnsave(43);
fixture.fixtures.unshift(makeFixture(45));
await page.locator('#refresh').click();
await page.locator('#sync-status').filter({ hasText: 'Instagram couldn’t confirm 1 unsave' }).waitFor();
await page.locator('#saved-count').filter({ hasText: '44 saved' }).waitFor();
assert.ok(fixture.fixtures.some(record => record.media.code === pending));
assert.match(await page.locator('#sync-status').textContent(), /1 unsave waiting for Refresh/);
await setMode('normal');
await page.locator('#refresh').click();
await page.locator('#sync-status').filter({ hasText: '1 unsaved on Instagram' }).waitFor();
assert.ok(!fixture.fixtures.some(record => record.media.code === pending));
console.log('Verified an unconfirmed unsave remains queued while new saves sync and can be retried');

await setMode('format');
await page.locator('#refresh').click();
await page.waitForFunction(() => document.querySelector('#banner-text').textContent.includes('saved posts: expected JSON, got HTTP 404 HTML page'));
const afterFormat = (await getRequests()).length;
await page.waitForTimeout(2200);
assert.equal((await getRequests()).length, afterFormat);
assert.equal(await page.locator('#saved-count').textContent(), '44 saved');
console.log('Verified format-change request halt and intact cache');

await setMode('429');
await page.locator('#banner-resume').click();
await page.waitForFunction(() => document.querySelector('#banner-text').textContent.includes('slow down'), { timeout: 20000 });
const afterLimit = (await getRequests()).length;
await page.waitForTimeout(2200);
assert.equal((await getRequests()).length, afterLimit);
assert.equal(await page.locator('#banner-resume').isDisabled(), true);
console.log('Verified 429 stops calls and disables premature retry');

// Clear the test-only cooldown, then explicitly request a new session check.
await page.evaluate(() => chrome.storage.local.remove('apiBlock'));
// Terminating/restarting the worker proves persisted state rehydrates safely.
const cdp = await context.newCDPSession(page);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
await setMode('auth');
await page.reload();
await page.locator('#refresh').click();
await page.waitForFunction(() => document.querySelector('#banner-text').textContent.includes('session expired'), { timeout: 20000 });
const afterAuth = (await getRequests()).length;
await page.waitForTimeout(1800);
assert.equal((await getRequests()).length, afterAuth);
assert.equal(await page.locator('#saved-count').textContent(), '44 saved');
console.log('Verified session expiry preserves position/library and stops calls');

await page.locator('#settings-open').click(); await page.locator('#clear-open').click(); await page.locator('#clear-confirm').click();
await page.locator('#empty').waitFor({ state: 'visible' });
assert.equal(await page.locator('#saved-count').textContent(), '0 saved');
// Seed a large warm cache, then confirm virtualization also works far into the feed.
await setMode('normal');
{
  const first = fixture.fixtures[0];
  fixture.fixtures = Array.from({ length: 2000 }, (_, i) => ({ media: { ...first.media, pk: String(100000 + i), code: `Large_${i}` } }));
}
await page.evaluate(async () => {
  const db = await import('./lib/db.js');
  await db.putReels(Array.from({ length: 2000 }, (_, i) => ({ shortcode: `Large_${i}`, mediaId: String(100000 + i), author: 'large.library', caption: 'Large library test fixture', thumbUrl: 'https://scontent.cdninstagram.com/fixture.jpg', savedAt: null, kind: 'video' })));
});
await page.reload();
await page.waitForFunction(() => document.querySelector('#saved-count').textContent === '2,000 saved');
await page.locator('#refresh').click();
await page.waitForFunction(() => document.querySelector('#sync-status').textContent.startsWith('All caught up'));
await page.evaluate(() => { const feed = document.querySelector('#feed'); feed.scrollTop = feed.clientHeight * 1500; feed.dispatchEvent(new Event('scroll')); });
await page.waitForFunction(() => document.querySelector('#position').textContent.startsWith('1501'));
assert.ok(await page.locator('.reel-card').count() <= 4);
assert.ok(await page.locator('video[src]').count() <= 3);
await page.waitForFunction(() => [...document.querySelectorAll('video')].filter(v => !v.paused).length === 1, null, { timeout: 20000 });
console.log('Verified 2,000-reel feed and bounded DOM at position 1,501');
assert.deepEqual(errors, []);
assert.ok((await getRequests()).every(url => new URL(url).hostname === 'www.instagram.com'));
await context.close();
console.log('Browser checks passed. No live Instagram account was used.');
