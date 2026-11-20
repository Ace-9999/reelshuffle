import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { shuffle, cleanRecord, safeMediaUrl, settingsWithDefaults } from '../ReelShuffle/lib/model.js';
import { InstagramClient, parseSavedPage, parseVideo } from '../ReelShuffle/lib/instagram.js';
globalThis.indexedDB = indexedDB;
const db = await import('../ReelShuffle/lib/db.js');
const reel = (i, extra = {}) => ({ shortcode: `REEL_${i}`, mediaId: String(i), author: 'creator', caption: 'Saved moment', thumbUrl: 'https://scontent.cdninstagram.com/poster.jpg', savedAt: null, kind: 'video', ...extra });
const media = (i, type = 2) => ({ pk: String(i), code: `REEL_${i}`, media_type: type, user: { username: 'creator' }, caption: { text: 'x'.repeat(250) }, image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/a.jpg' }] } });
function harness(responses) {
  const stored = {}, calls = []; let time = 10000, waits = [];
  const storage = { async get(k) { return { [k]: stored[k] }; }, async set(v) { Object.assign(stored, v); }, async remove(k) { delete stored[k]; } };
  const cookies = { async get({ name }) { return { value: name === 'ds_user_id' ? '12345' : 'test-csrf-not-real' }; } };
  const fetcher = async (url, options) => {
    calls.push({ url, options, time });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected extra request');
    return { status: next.status || 200, ok: (next.status || 200) < 400, url, async json() {
      if (next.html) throw new SyntaxError('Expected JSON');
      return next.body;
    } };
  };
  const client = new InstagramClient({ storage, cookies, fetcher, now: () => time, sleep: async ms => { waits.push(ms); time += ms; } });
  return { client, calls, stored, waits, advance(ms) { time += ms; } };
}
beforeEach(async () => { await db.clearDB(); });

test('shuffle preserves 2,000 unique reels and changes round boundary', () => {
  const items = Array.from({ length: 2000 }, (_, i) => reel(i + 1));
  const result = shuffle(items, 'REEL_2000', () => 0.999999);
  assert.equal(result.length, 2000); assert.equal(new Set(result.map(r => r.shortcode)).size, 2000);
  assert.notEqual(result[0].shortcode, 'REEL_2000'); assert.deepEqual(items[0], reel(1));
});
test('record persistence strips video URLs, tokens and arbitrary fields', () => {
  const result = cleanRecord(reel(1, { videoUrl: 'secret-signed-url', token: 'secret', caption: 'x'.repeat(300) }));
  assert.equal(result.caption.length, 200); assert.equal(result.savedAt, null);
  assert.equal('videoUrl' in result, false); assert.equal('token' in result, false);
  assert.equal(safeMediaUrl('https://cdninstagram.com.evil.example/video'), '');
  assert.equal(safeMediaUrl('http://scontent.cdninstagram.com/video'), '');
  assert.equal(safeMediaUrl('https://user:password@video.fbcdn.net/video'), '');
});
test('saved parser skips photos/carousels by default and validates pagination', () => {
  const body = { items: [{ media: media(1) }, { media: media(2, 1) }, { media: { ...media(3, 8), carousel_media: [media(4, 1)] } }], more_available: true, next_max_id: 'cursor' };
  const parsed = parseSavedPage(body); assert.equal(parsed.reels.length, 1); assert.equal(parsed.cursor, 'cursor');
  assert.equal(parsed.reels[0].caption.length, 200); assert.equal(parsed.reels[0].savedAt, null);
  assert.equal(parseSavedPage(body, true).reels.length, 3);
  assert.throws(() => parseSavedPage({ items: [], more_available: true }), { code: 'FORMAT' });
  assert.throws(() => parseSavedPage({ something_else: [] }), { code: 'FORMAT', message: /got fields: something_else/ });
  const odd = parseSavedPage({ items: [{ media: media(5) }, { media: { media_type: 99 } }, { media: { media_type: 2 } }, null], more_available: false });
  assert.equal(odd.reels.length, 1); assert.equal(odd.skipped, 3); assert.equal(odd.cursor, null);
});
test('video resolver allows only Instagram media hosts and best available version', () => {
  assert.equal(parseVideo({ items: [{ media_type: 2, video_versions: [{ width: 300, url: 'https://video.cdninstagram.com/small' }, { width: 720, url: 'https://video.fbcdn.net/large' }] }] }).url, 'https://video.fbcdn.net/large');
  assert.throws(() => parseVideo({ items: [{ media_type: 2, video_versions: [{ url: 'https://evil.example/video' }] }] }), { code: 'UNAVAILABLE' });
});
test('partial sync retains old cache; successful reconciliation removes missing reels', async () => {
  await db.putReels([reel(1), reel(2)]); await db.putReels([reel(3)]);
  assert.equal((await db.getReels()).length, 3);
  await db.reconcile(new Set(['REEL_2', 'REEL_3']), 12345);
  assert.deepEqual((await db.getReels()).map(r => r.shortcode), ['REEL_2', 'REEL_3']);
  assert.equal(await db.getMeta('lastSync'), 12345);
});
test('cache handles 2,000 records and clear removes records and metadata', async () => {
  await db.putReels(Array.from({ length: 2000 }, (_, i) => reel(i + 1)));
  assert.equal((await db.getReels()).length, 2000);
  await db.setMeta('owner', 'test-user'); await db.clearDB();
  assert.equal((await db.getReels()).length, 0); assert.equal(await db.getMeta('owner'), undefined);
});
test('all calls are serialized and at least 1.5 seconds apart', async () => {
  const h = harness([{ body: { items: [], more_available: false } }, { body: { items: [{ media_type: 2, video_versions: [{ url: 'https://v.cdninstagram.com/a' }] }] } }, { body: { status: 'ok' } }]);
  await Promise.all([h.client.session(), h.client.saved(null, false), h.client.resolve('1'), h.client.bookmark('1', false)]);
  assert.deepEqual(h.calls.map(c => c.time), [10000, 11500, 13000]);
  assert.equal(h.calls[2].options.credentials, 'include'); assert.match(h.calls[2].url, /\/api\/v1\/web\/save\/1\/unsave\//);
  assert.equal(JSON.stringify(h.stored).includes('test-csrf-not-real'), false);
});
test('a missing reel does not block saved-list requests', async () => {
  const h = harness([
    { status: 404, html: true },
    { body: { data: { xdt_api__v1__media__shortcode__web_info: { items: [] } } } },
    { body: { items: [], more_available: false } },
  ]);
  await assert.rejects(h.client.resolve('1', undefined, 'REEL_1'), { code: 'UNAVAILABLE' });
  await h.client.saved('cursor&value', false);
  assert.deepEqual(h.calls.map(c => c.time), [10000, 11500, 13000]);
  assert.equal(new URL(h.calls[1].url).pathname, '/api/graphql');
  assert.equal(new URL(h.calls[2].url).search, '?max_id=cursor%26value');
  assert.equal(h.stored.apiBlock, undefined);
});
test('429 blocks all queued calls, survives restart and doubles explicit retry cooldown', async () => {
  const h = harness([{ status: 429, body: {} }, { status: 429, body: {} }]);
  const results = await Promise.allSettled([h.client.saved(null, false), h.client.resolve('1')]);
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'RATE_LIMIT'));
  assert.equal(h.calls.length, 1); assert.equal(h.stored.apiBlock.retryAt, 70000);
  await assert.rejects(h.client.resume(), { code: 'RATE_LIMIT' });
  h.advance(60000); await h.client.resume();
  await assert.rejects(h.client.saved(null, false), { code: 'RATE_LIMIT' });
  assert.equal(h.stored.apiBlock.retryAt, 190000); assert.equal(h.calls.length, 2);
});
test('challenge never retries automatically; session expiry stops queued calls', async () => {
  for (const [response, code] of [[{ status: 403, body: { message: 'challenge_required' } }, 'CHALLENGE'], [{ status: 401, body: {} }, 'AUTH']]) {
    const h = harness([response]);
    const results = await Promise.allSettled([h.client.resolve('1', undefined, 'REEL_1'), h.client.saved(null, false)]);
    assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === code)); assert.equal(h.calls.length, 1);
  }
});
test('format change halts the API and leaves cache available', async () => {
  await db.putReels([reel(1)]);
  const h = harness([{ body: { obsolete_shape: [] } }]);
  await assert.rejects(h.client.saved(null, false), { code: 'FORMAT' });
  await assert.rejects(h.client.resolve('1'), { code: 'FORMAT' });
  assert.equal(h.calls.length, 1); assert.equal((await db.getReels()).length, 1);
});
test('missing session never sends a request; mutation success is explicit', async () => {
  const h = harness([{ body: {} }]);
  h.client.cookies = { async get() { return null; } };
  await assert.rejects(h.client.session(), { code: 'AUTH' }); assert.equal(h.calls.length, 0);
  const failed = harness([{ body: {} }]);
  await assert.rejects(failed.client.bookmark('1', false), { code: 'FORMAT' });
});
test('settings reject unexpected types and stay within safe request pace', () => {
  assert.deepEqual(settingsWithDefaults({ autoplay: 'true', muted: false, requestDelay: 0, includeNonReels: 'yes' }), { autoplay: true, muted: false, includeNonReels: false, requestDelay: 'normal' });
});
