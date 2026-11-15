import { chromium } from '../.qa/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const extension = path.join(root, 'ReelShuffle');
await mkdir(path.join(root, 'qa-output'), { recursive: true });
const context = await chromium.launchPersistentContext(path.join(root, `.qa-profile-${Date.now()}`), {
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [], requests = [], mutations = [];
let mode = 'normal', pageCount = 0;
let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
const origin = `chrome-extension://${id}`;
console.log('Loaded MV3 extension', id);

const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="854" viewBox="0 0 480 854"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#7b9cba"/><stop offset=".6" stop-color="#d8c6b9"/><stop offset="1" stop-color="#cf9a80"/></linearGradient><linearGradient id="land" x2=".2" y2="1"><stop stop-color="#334e57"/><stop offset="1" stop-color="#132d35"/></linearGradient></defs><rect width="480" height="854" fill="url(#sky)"/><circle cx="360" cy="265" r="38" fill="#f4d8b0" opacity=".8"/><path d="M0 440 110 305 235 460 345 330 480 475V854H0" fill="#65808b"/><path d="m0 562 133-169 141 144 90-108 116 117v308H0" fill="#405e69"/><path d="M0 650 120 530 260 660 390 506 480 580V854H0" fill="url(#land)"/><path d="M180 854q80-96 75-180t83-122" fill="none" stroke="#c1b5a1" stroke-width="4" opacity=".6"/><text x="24" y="45" fill="#fff9" font-family="sans-serif" font-size="10" letter-spacing="3">TEST LIBRARY · LOCAL FIXTURE</text></svg>`;
const maker = await context.newPage();
const video64 = await maker.evaluate(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 426;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(12), recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks = []; recorder.ondataavailable = event => chunks.push(event.data);
  const result = new Promise(resolve => { recorder.onstop = async () => { const data = new Uint8Array(await new Blob(chunks).arrayBuffer()); let binary = ''; for (const b of data) binary += String.fromCharCode(b); resolve(btoa(binary)); }; });
  recorder.start();
  for (let i = 0; i < 15; i++) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 426); gradient.addColorStop(0, '#849fb5'); gradient.addColorStop(1, '#d6b69b'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 240, 426);
    ctx.fillStyle = '#e9ccb0'; ctx.beginPath(); ctx.arc(182, 136, 21, 0, Math.PI * 2); ctx.fill();
    for (const [color, points] of [['#6c8790', [[0,240],[65,140],[132,241],[181,172],[240,231]]], ['#3e616a', [[0,310],[69,222],[138,302],[200,227],[240,280]]], ['#1f3e44', [[0,370],[71,301],[145,370],[220,286],[240,326]]]]) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, 426); for (const [x,y] of points) ctx.lineTo(x, y + Math.sin(i/3)); ctx.lineTo(240,426);ctx.closePath();ctx.fill();
    }
    await new Promise(r => setTimeout(r, 85));
  }
  recorder.stop(); stream.getTracks().forEach(track => track.stop()); return result;
});
await maker.close();
const video = Buffer.from(video64, 'base64');
const makeFixture = i => ({ media: { pk: String(1000 + i), code: `Fixture_${i}`, media_type: 2, user: { username: ['the.wandering.frame','slowmornings','somewhere.outside'][i % 3] }, caption: { text: ['Some places make you forget to check your phone. A quiet morning, a long way from the rush.','Keeping a little room for the things worth coming back to.','A different view. The same feeling.'][i % 3] }, image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/fixture.jpg' }] } } });
let fixtures = Array.from({ length: 45 }, (_, i) => makeFixture(i));
await context.addCookies(['csrftoken', 'sessionid', 'ds_user_id'].map(name => ({ name, value: name === 'ds_user_id' ? '99999' : 'fixture-only', domain: '.instagram.com', path: '/', secure: true, sameSite: 'None' })));
// A stand-in instagram.com: HTML pages get the real content script; /api/v1/ calls are answered here.
// Every API request must arrive as a same-origin call from the instagram.com tab, never from the extension origin.
const fixture = { mode: 'normal', requests: [], mutations: [], fixtures, pages: 0, origins: new Set() };
async function installApiFixture() {}
await context.route('https://www.instagram.com/**', async route => {
  const request = route.request(), url = request.url(), mode = fixture.mode;
  if (!new URL(url).pathname.startsWith('/api/v1/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Instagram</title><p>fixture</p>' });
  fixture.requests.push(url);
  const headers = request.headers();
  fixture.origins.add(headers.origin || 'same-origin-get');
  assert.equal(headers['x-csrftoken'], 'fixture-only');
  assert.doesNotMatch(headers.origin || '', /^chrome-extension:/);
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (mode === 'auth') return json({ message: 'login_required', status: 'fail' }, 401);
  if (url.includes('/feed/saved/posts/')) {
    fixture.pages++;
    if (mode === '429') return json({}, 429);
    if (mode === 'format') return json({ status: 'ok', obsolete: [] });
    return json({ status: 'ok', items: fixture.fixtures, more_available: false });
  }
  if (url.includes('/media/') && url.includes('/info/')) return json({ status: 'ok', items: [{ media_type: 2, video_versions: [{ width: 720, url: 'https://video.cdninstagram.com/fixture.webm' }] }] });
  if (url.includes('/web/save/')) {
    fixture.mutations.push(url);
    if (mode === 'mutation-fail') return json({ status: 'fail', message: 'please_try_again' });
    return json({ status: 'ok' });
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
  try { console.error('Videos:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('video')].map(v => [v.src.slice(0, 60), v.error?.code, v.error?.message, v.readyState, v.networkState])))); } catch {}
  try { console.error(await page.locator('body').innerText()); await page.screenshot({ path: path.join(root, 'qa-output/failure.png') }); } catch {}
  await context.close(); process.exit(1);
});
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(`${origin}/feed.html`);
await page.locator('#saved-count').filter({ hasText: '45 saved' }).waitFor({ timeout: 25000 });
await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => !v.paused));
await page.waitForFunction(() => document.querySelector('#sync-status').textContent === 'All caught up');
console.log('Synced first page and autoplayed fixture video');

assert.ok(await page.locator('.reel-card').count() <= 4);
assert.ok(await page.locator('video[src]').count() <= 3);
await page.waitForFunction(() => [...document.querySelectorAll('video')].filter(v => !v.paused).length === 1, null, { timeout: 10000 });
const initialOrder = await page.locator('.reel-card').first().getAttribute('data-shortcode');
await page.screenshot({ path: path.join(root, 'qa-output/feed-desktop.png') });
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
await page.waitForFunction(() => document.querySelector('#toast-text').textContent.includes('Restored to Instagram'), { timeout: 15000 });
const successfulMutations = fixture.mutations;
assert.equal(successfulMutations.length, 2); assert.match(successfulMutations[0], /\/unsave\//); assert.match(successfulMutations[1], /\/save\//);
assert.equal(await page.locator('#saved-count').textContent(), '45 saved');
console.log('Verified unsave and Undo through worker and IndexedDB');

await setMode('mutation-fail');
await page.locator('#unsave').click();
await page.waitForFunction(() => document.querySelector('#toast-text').textContent.includes('Couldn’t unsave'), { timeout: 15000 });
assert.equal(await page.locator('#saved-count').textContent(), '45 saved');
assert.equal(await page.locator('#unsave').getAttribute('aria-pressed'), 'true');
await setMode('normal');

await page.reload();
await page.locator('#player-shell').waitFor({ state: 'visible' });
assert.notEqual(await page.locator('.reel-card').first().getAttribute('data-shortcode'), initialOrder);
await page.waitForFunction(() => document.querySelector('#sync-status').textContent === 'All caught up', { timeout: 20000 });
console.log('Verified cache launch and different order on reload');

await page.locator('#settings-open').click();
await page.locator('#settings-dialog').waitFor({ state: 'visible' });
await page.screenshot({ path: path.join(root, 'qa-output/settings-desktop.png') });
await page.locator('[data-close="settings-dialog"]').click();
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: path.join(root, 'qa-output/feed-narrow.png') });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
await page.setViewportSize({ width: 1440, height: 1000 });

await setMode('format');
await page.locator('#refresh').click();
await page.waitForFunction(() => document.querySelector('#banner-text').textContent.includes('changed its format'), { timeout: 20000 });
const afterFormat = (await getRequests()).length;
await page.waitForTimeout(2200);
assert.equal((await getRequests()).length, afterFormat);
assert.equal(await page.locator('#saved-count').textContent(), '45 saved');
console.log('Verified format-change request halt and intact cache');

await setMode('429');
await page.locator('#banner-resume').click();
await page.waitForFunction(() => document.querySelector('#banner-text').textContent.includes('slow down'), { timeout: 20000 });
const afterLimit = (await getRequests()).length;
await page.waitForTimeout(2200);
assert.equal((await getRequests()).length, afterLimit);
assert.equal(await page.locator('#banner-resume').isDisabled(), true);
await page.screenshot({ path: path.join(root, 'qa-output/rate-limit.png') });
console.log('Verified 429 stops calls and disables premature retry');

// Clear the test-only cooldown, then explicitly request a new session check.
await page.evaluate(() => chrome.storage.local.remove('apiBlock'));
const firstRun = { requests: [...fixture.requests], pages: fixture.pages, mutations: [...fixture.mutations] };
fixture.requests = []; fixture.mutations = []; fixture.pages = 0;
// Terminating/restarting the worker proves persisted state rehydrates safely.
const cdp = await context.newCDPSession(page);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
worker = context.serviceWorkers().find(w => w.url().includes(id)) || await context.waitForEvent('serviceworker');
await installApiFixture(); await setMode('auth');
await page.reload();
await page.waitForFunction(() => document.querySelector('#banner-text').textContent.includes('session expired'), { timeout: 20000 });
const afterAuth = (await getRequests()).length;
await page.waitForTimeout(1800);
assert.equal((await getRequests()).length, afterAuth);
assert.equal(await page.locator('#saved-count').textContent(), '45 saved');
console.log('Verified session expiry preserves position/library and stops calls');

await page.locator('#settings-open').click(); await page.locator('#clear-open').click(); await page.locator('#clear-confirm').click();
await page.locator('#empty').waitFor({ state: 'visible' });
assert.equal(await page.locator('#saved-count').textContent(), '0 saved');
await page.screenshot({ path: path.join(root, 'qa-output/empty-state.png') });
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
await page.waitForFunction(() => document.querySelector('#sync-status').textContent === 'All caught up', null, { timeout: 20000 });
await page.evaluate(() => { const feed = document.querySelector('#feed'); feed.scrollTop = feed.clientHeight * 1500; feed.dispatchEvent(new Event('scroll')); });
await page.waitForFunction(() => document.querySelector('#position').textContent.startsWith('1501'));
assert.ok(await page.locator('.reel-card').count() <= 4);
assert.ok(await page.locator('video[src]').count() <= 3);
await page.waitForFunction(() => [...document.querySelectorAll('video')].filter(v => !v.paused).length === 1, null, { timeout: 20000 });
console.log('Verified 2,000-reel feed and bounded DOM at position 1,501');
assert.deepEqual(errors, []);
assert.ok((await getRequests()).every(url => new URL(url).hostname === 'www.instagram.com'));
await writeFile(path.join(root, 'qa-output/browser-report.json'), JSON.stringify({ passed: true, requests: firstRun.requests.length + (await getRequests()).length, pages: firstRun.pages, mutations: firstRun.mutations.length, pageErrors: errors, verified: ['MV3 load', 'real worker messaging', 'IndexedDB cache', 'autoplay', 'keyboard controls', 'lazy video loading', 'unsave and Undo', 'unsave failure', 'reload shuffle', 'responsive layout', 'format halt', '429 halt', 'session expiry', 'clear local data', '2,000-reel feed at position 1,501', 'sync from Instagram Saved page', 'same-origin requests via content script'], liveInstagramAccount: false }, null, 2));
await context.close();
console.log('Browser checks passed. No live Instagram account was used.');
