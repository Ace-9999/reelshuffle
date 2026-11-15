import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from '../.qa/node_modules/fake-indexeddb/build/esm/index.js';
globalThis.indexedDB = indexedDB;
let listener, clickListener;
const local = {}, session = {}, broadcasts = [], calls = [];
function storage(data) {
  return {
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: data[keys] };
      return Object.fromEntries((keys || Object.keys(data)).map(k => [k, data[k]]));
    },
    async set(value) { Object.assign(data, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
}
const feedUrl = 'chrome-extension://fixture/feed.html';
let focused, created;
const igTab = { id: 42, url: 'https://www.instagram.com/test/saved/', status: 'complete' }, tabStatus = [];
globalThis.chrome = {
  cookies: { async get() { return { value: 'fixture' }; } },
  storage: { local: storage(local), session: storage(session) },
  runtime: {
    id: 'fixture', getURL: name => `chrome-extension://fixture/${name}`,
    async getContexts() { return focused ? [{ tabId: 7, windowId: 3 }] : []; },
    async sendMessage(message) { broadcasts.push(structuredClone(message)); },
    onMessage: { addListener(fn) { listener = fn; } },
  },
  action: { onClicked: { addListener(fn) { clickListener = fn; } } },
  tabs: {
    async query(filter) { if (filter?.url) return [igTab]; return focused ? [{ id: 7, windowId: 3 }] : []; },
    async get(id) { if (id === igTab.id) return igTab; throw new Error('No tab'); },
    async create(value) { created = value; return { id: 99 }; }, async update(id, value) { focused = { id, ...value }; },
    async remove() {}, onUpdated: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {} },
    // Stands in for content.js: the request is made by the instagram.com tab with the page's own fetch.
    async sendMessage(tabId, message) {
      assert.equal(tabId, igTab.id);
      if (message.type === 'RS_PING') return { ok: true };
      if (message.type === 'RS_STATUS') { tabStatus.push(message.state.phase); return; }
      if (message.type !== 'RS_FETCH') throw new Error('Unexpected tab message');
      assert.ok(message.path.startsWith('/api/v1/'));
      const response = await fetch(`https://www.instagram.com${message.path}`, { method: message.method, headers: message.headers });
      return { status: response.status, url: `https://www.instagram.com${message.path}`, text: await response.text() };
    },
  },
  scripting: { async executeScript() {} },
  windows: { async update() {} },
};
let now = 10000;
const realNow = Date.now, realTimeout = globalThis.setTimeout;
Date.now = () => now;
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(() => { now += ms; fn(...args); }, 0);
let mode = 'full', dataset = [];
const media = i => ({ media: { pk: String(100000 + i), code: `Worker_${i}`, media_type: 2, user: { username: 'fixture' }, image_versions2: { candidates: [{ url: 'https://test.cdninstagram.com/poster' }] } } });
globalThis.fetch = async (url, options) => {
  calls.push({ url, time: now, method: options.method });
  const parsed = new URL(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (parsed.pathname.includes('current_user')) return json({ status: 'ok', user: { pk: 'user-1', username: 'test' } });
  if (parsed.pathname.includes('feed/saved')) {
    const page = Number(parsed.searchParams.get('max_id') || 0);
    if (mode === 'partial-format' && page > 0) return json({ obsolete: [] });
    if (mode === 'repeat' && page > 0) return json({ items: dataset.slice(0, 50), more_available: true, next_max_id: '1' });
    const items = dataset.slice(page * 50, page * 50 + 50);
    const more = (page + 1) * 50 < dataset.length;
    return json({ items, more_available: more, ...(more ? { next_max_id: String(page + 1) } : {}) });
  }
  if (parsed.pathname.includes('/web/save/')) return mode === 'mutation-fail' ? json({ status: 'fail' }) : json({ status: 'ok' });
  throw new Error('Unexpected test endpoint');
};
await import('../ReelShuffle/background.js');
const db = await import('../ReelShuffle/lib/db.js');
const send = (type, data = {}) => new Promise(resolve => { listener({ type, ...data }, { id: 'fixture', url: feedUrl }, resolve); });
const waitSync = async () => {
  for (let i = 0; i < 10000; i++) {
    await new Promise(resolve => setImmediate(resolve));
    const result = await send('GET_STATE');
    if (result.data.state.phase !== 'syncing') return result.data.state;
  }
  throw new Error('Sync did not finish');
};

test('full worker flow: 2,000 reels, pagination, partial failure, reconcile, bookmarks and launch', async () => {
  dataset = Array.from({ length: 2000 }, (_, i) => media(i));
  await send('SYNC');
  let state = await waitSync();
  assert.equal(state.phase, 'ready'); assert.equal((await db.getReels()).length, 2000);
  assert.equal(calls.filter(c => c.url.includes('feed/saved')).length, 40);
  assert.ok(calls.every((c, i) => i === 0 || c.time - calls[i - 1].time >= 1500));
  assert.ok(broadcasts.some(b => b.type === 'STATE_CHANGED' && b.state.loaded === 50));
  console.log('Full 40-page sync completed and incremental progress was broadcast');

  mode = 'partial-format'; dataset = Array.from({ length: 100 }, (_, i) => media(3000 + i));
  await send('SYNC'); state = await waitSync();
  assert.equal(state.code, 'FORMAT'); assert.equal((await db.getReels()).length, 2050);
  assert.ok(await db.getMeta('lastSync'));
  console.log('Malformed second page kept every old record and valid first-page additions');

  mode = 'full'; dataset = [media(3001), media(3002)];
  await send('SYNC'); state = await waitSync();
  assert.equal(state.phase, 'ready'); assert.equal((await db.getReels()).length, 2);
  const reel = (await db.getReels())[0];
  mode = 'mutation-fail';
  const failure = await send('BOOKMARK', { reel, saved: false }); assert.equal(failure.ok, false);
  assert.equal((await db.getReels()).length, 2);
  mode = 'full';
  assert.equal((await send('BOOKMARK', { reel, saved: false })).ok, true); assert.equal((await db.getReels()).length, 1);
  assert.equal((await send('BOOKMARK', { reel, saved: true })).ok, true); assert.equal((await db.getReels()).length, 2);
  console.log('Successful reconciliation, failure rollback, unsave and restore verified');

  mode = 'repeat'; dataset = Array.from({ length: 100 }, (_, i) => media(i));
  const beforeRepeat = calls.length;
  await send('SYNC'); state = await waitSync();
  assert.equal(state.code, 'FORMAT'); assert.equal(calls.length - beforeRepeat, 3);
  console.log('Repeated cursor halted sync without an endless request loop');

  mode = 'full'; dataset = Array.from({ length: 120 }, (_, i) => media(5000 + i));
  listener({ type: 'SAVED_PAGE_OPENED' }, { id: 'fixture', tab: { id: 42, url: igTab.url } }, () => {});
  for (let i = 0; i < 50 && (await send('GET_STATE')).data.state.phase !== 'syncing'; i++) await new Promise(r => setImmediate(r));
  state = await waitSync();
  assert.equal(state.phase, 'ready'); assert.equal((await db.getReels()).length, 120);
  assert.ok(tabStatus.includes('syncing') && tabStatus.at(-1) === 'ready');
  console.log('Opening the Instagram Saved page synced the full library through that tab');

  const external = listener({ type: 'CLEAR' }, { id: 'not-our-extension', url: 'https://evil.example/' }, () => { throw new Error('External sender accepted'); });
  assert.equal(external, false);
  await clickListener(); assert.equal(created.url, feedUrl);
  focused = true; await clickListener(); assert.equal(focused.id, 7); assert.equal(focused.active, true);
  await send('SETTINGS', { settings: { muted: false, requestDelay: 'slow' } });
  await send('CLEAR'); assert.equal((await db.getReels()).length, 0); assert.equal(local.settings, undefined); assert.equal(await db.getMeta('owner'), undefined);
  Date.now = realNow; globalThis.setTimeout = realTimeout;
});
