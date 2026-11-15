// All Instagram paths, headers, parsing, session reads and request pacing live here.
// These are unofficial web endpoints. See README.md for validation and limitations.
import { cleanRecord, safeMediaUrl } from './model.js';

const ORIGIN = 'https://www.instagram.com';
const APP_ID = '936619743392459';
const PATHS = {
  saved: '/api/v1/feed/saved/posts/',
  info: id => `/api/v1/media/${id}/info/`,
  comments: (id, cursor) => `/api/v1/media/${id}/comments/?${new URLSearchParams({ can_support_threading: 'true', permalink_enabled: 'false', ...(cursor ? { min_id: cursor } : {}) })}`,
  bookmark: (id, saved) => `/api/v1/web/save/${id}/${saved ? 'save' : 'unsave'}/`,
};

export class InstagramError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'InstagramError'; this.code = code; Object.assign(this, details); }
}
const error = (code, message) => new InstagramError(code, message);
export function formatError(context) {
  // Deliberately avoid response bodies, cookies, tokens and signed URLs in logs.
  // The context only names fields and status codes, so it is safe to show and lets a format change be diagnosed.
  console.warn(`[ReelShuffle] Unexpected Instagram response structure: ${context}`);
  return error('FORMAT', `Instagram changed its format (${context}). Your cached feed is still here.`);
}
// Top-level field names only, never values.
export function shape(body) {
  if (body === null || typeof body !== 'object') return `got ${body === null ? 'null' : typeof body}`;
  const keys = Object.keys(body).slice(0, 8);
  return keys.length ? `got fields: ${keys.join(', ')}` : 'got an empty object';
}

export function parseSavedPage(body, includeNonReels = false) {
  if (!body || !Array.isArray(body.items)) throw formatError(`saved list has no items, ${shape(body)}`);
  const reels = [];
  let skipped = 0;
  for (const entry of body.items) {
    const media = entry?.media ?? entry;
    // One odd item (deleted post, new media type) must not abort a whole library sync: skip it.
    if (!media || typeof media !== 'object') { skipped++; continue; }
    const mediaType = Number(media.media_type);
    if (![1, 2, 8].includes(mediaType)) { skipped++; continue; }
    if (mediaType !== 2 && !includeNonReels) continue;
    const primary = mediaType === 8 ? media.carousel_media?.[0] : media;
    if (!primary) { skipped++; continue; }
    const image = primary.image_versions2?.candidates?.[0]?.url ?? media.thumbnail_src;
    try {
      reels.push(cleanRecord({
        shortcode: media.code ?? media.shortcode,
        mediaId: typeof media.id === 'string' ? media.id : media.pk,
        author: media.user?.username ?? media.owner?.username,
        caption: media.caption?.text ?? media.caption ?? '',
        thumbUrl: image,
        // taken_at is publication time, not save time. Never label it as saved time.
        savedAt: typeof entry.saved_at === 'number' ? entry.saved_at : typeof media.saved_at === 'number' ? media.saved_at : null,
        kind: Number(primary.media_type) === 2 ? 'video' : 'image',
      }));
    } catch { skipped++; }
  }
  if (skipped) console.warn(`[ReelShuffle] Skipped ${skipped} saved item(s) with an unusable shape`);
  const cursor = body.next_max_id != null ? String(body.next_max_id) : body.next_max_id;
  if (typeof body.more_available !== 'boolean' && body.next_max_id === undefined) throw formatError('missing pagination fields');
  const more = typeof body.more_available === 'boolean' ? body.more_available : Boolean(cursor);
  if (more && (typeof cursor !== 'string' || !cursor)) throw formatError('next page has no cursor');
  if (more && body.items.length === 0) throw formatError('empty page claims more results');
  return { reels, skipped, cursor: more ? cursor : null };
}

export function parseVideo(body) {
  const media = body?.items?.[0];
  if (!media) throw formatError(`media info has no items, ${shape(body)}`);
  const primary = Number(media.media_type) === 8 ? media.carousel_media?.[0] : media;
  if (!primary) throw formatError('media info has no primary item');
  if (Number(primary.media_type) === 1) {
    const url = safeMediaUrl(primary.image_versions2?.candidates?.[0]?.url);
    if (url) return { url, kind: 'image' };
  }
  if (!Array.isArray(primary.video_versions)) throw error('UNAVAILABLE', 'This reel is private, deleted or unavailable.');
  const versions = [...primary.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0));
  const url = versions.map(v => safeMediaUrl(v.url)).find(Boolean);
  if (!url) throw error('UNAVAILABLE', 'This reel is private, deleted or unavailable.');
  return { url, kind: 'video' };
}

// Read-only comments for one post. Keeps only display fields; profile pictures must be Instagram media URLs.
export function parseComments(body) {
  if (!body || !Array.isArray(body.comments)) throw error('COMMENTS', `Comments couldn't be read (${shape(body)}).`);
  const comments = body.comments.map(c => ({
    id: String(c?.pk ?? c?.id ?? ''),
    author: String(c?.user?.username || 'instagram').slice(0, 60),
    avatar: safeMediaUrl(c?.user?.profile_pic_url),
    text: String(c?.text || '').slice(0, 2200),
    createdAt: Number.isFinite(c?.created_at) ? c.created_at : null,
    likes: Number.isFinite(c?.comment_like_count) ? c.comment_like_count : 0,
    replies: Number.isFinite(c?.child_comment_count) ? c.child_comment_count : 0,
  })).filter(c => c.text);
  const more = body.has_more_comments === true || body.has_more_headload_comments === true;
  const cursor = typeof body.next_min_id === 'string' ? body.next_min_id : body.next_min_id ? JSON.stringify(body.next_min_id) : null;
  return {
    comments,
    total: Number.isFinite(body.comment_count) ? body.comment_count : null,
    disabled: body.comments_disabled === true,
    cursor: more && cursor ? cursor : null,
  };
}

export class InstagramClient {
  constructor({ fetcher = (url, options) => globalThis.fetch(url, options), cookies = chrome.cookies, storage = chrome.storage.local, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { fetcher, cookies, storage, now, sleep });
    this.queue = Promise.resolve(); this.lastRequest = null; this.delay = 1500; this.block = null;
    this.ready = storage.get('apiBlock').then(v => { this.block = v.apiBlock || null; });
  }
  async assertAllowed() {
    await this.ready;
    if (!this.block) return;
    throw new InstagramError(this.block.code, this.block.message, { retryAt: this.block.retryAt });
  }
  async resume() {
    await this.ready;
    if (this.block?.retryAt > this.now()) await this.assertAllowed();
    this.block = null; await this.storage.remove('apiBlock');
  }
  async halt(err) {
    await this.ready;
    const { blockFailures = 0 } = await this.storage.get('blockFailures');
    const limited = ['RATE_LIMIT', 'CHALLENGE'].includes(err.code);
    const retryAt = limited ? this.now() + Math.min(3600000, (err.code === 'CHALLENGE' ? 900000 : 60000) * 2 ** Math.min(blockFailures, 6)) : null;
    this.block = { code: err.code, message: err.message, retryAt };
    await this.storage.set({ apiBlock: this.block, ...(limited ? { blockFailures: blockFailures + 1 } : {}) });
    err.retryAt = retryAt;
    return err;
  }
  request(path, { method = 'GET', mutation = false, before } = {}) {
    const run = async () => {
      await this.assertAllowed();
      if (before) before();
      if (this.lastRequest != null) await this.sleep(Math.max(0, this.delay - (this.now() - this.lastRequest)));
      await this.assertAllowed();
      if (before) before();
      const csrf = await this.cookies.get({ url: ORIGIN, name: 'csrftoken' });
      if (!csrf?.value) throw await this.halt(error('AUTH', 'Log in to Instagram in this Chrome profile to continue.'));
      const headers = { 'X-IG-App-ID': APP_ID, 'X-CSRFToken': csrf.value, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
      if (mutation) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      let response;
      this.lastRequest = this.now();
      try {
        response = await this.fetcher(`${ORIGIN}${path}`, {
          method, headers, credentials: 'include', redirect: 'follow', cache: 'no-store',
          signal: AbortSignal.timeout(15000), ...(mutation ? { body: '' } : {}),
        });
      } catch { throw error('NETWORK', 'Instagram is unreachable. Your cached list is still available.'); }
      if (response.status === 429) throw await this.halt(error('RATE_LIMIT', 'Instagram asked us to slow down. Requests are paused; wait before refreshing.'));
      if (response.status === 401 || /\/accounts\/login/.test(response.url || '')) throw await this.halt(error('AUTH', 'Your Instagram session expired. Log in, then resume here.'));
      if (/\/(challenge|checkpoint)\//.test(response.url || '')) throw await this.halt(error('CHALLENGE', 'Instagram needs your attention. Requests are paused. Open Instagram and wait before trying again.'));
      let body;
      try { body = await response.json(); } catch {
        if (response.status === 403) throw await this.halt(error('CHALLENGE', 'Instagram blocked this request. Open Instagram and wait before trying again.'));
        throw await this.halt(formatError(`expected JSON, got HTTP ${response.status} ${response.contentKind || 'non-JSON body'}`));
      }
      const message = String(body?.message || '').toLowerCase();
      if (body?.challenge || body?.checkpoint_url || /challenge|checkpoint|feedback_required|consent_required/.test(message)) throw await this.halt(error('CHALLENGE', 'Instagram needs your attention. Open Instagram and wait before trying again.'));
      if (message.includes('login_required')) throw await this.halt(error('AUTH', 'Your Instagram session expired. Log in, then resume here.'));
      if (response.status === 403) throw await this.halt(error('CHALLENGE', 'Instagram blocked this request. Open Instagram and wait before trying again.'));
      if (response.status === 404) throw error('UNAVAILABLE', 'This Instagram endpoint or reel is unavailable.');
      if (!response.ok || body?.status === 'fail') throw error('REQUEST', 'Instagram could not complete this request. Please try later.');
      return body;
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }
  // Login state comes from the session cookies themselves (presence only; values are never stored or sent anywhere).
  // The saved-list request that follows is the real authenticated check: a logged-out session fails it with AUTH.
  async session() {
    await this.assertAllowed();
    const [sessionCookie, userCookie] = await Promise.all([
      this.cookies.get({ url: ORIGIN, name: 'sessionid' }),
      this.cookies.get({ url: ORIGIN, name: 'ds_user_id' }),
    ]);
    if (!sessionCookie?.value || !/^\d+$/.test(userCookie?.value || '')) throw await this.halt(error('AUTH', 'Log in to Instagram in this Chrome profile to continue.'));
    return { id: userCookie.value, username: '' };
  }
  async saved(cursor, includeNonReels, before) {
    const query = new URLSearchParams({ count: '50', ...(cursor ? { max_id: cursor } : {}) });
    const body = await this.request(`${PATHS.saved}?${query}`, { before });
    try { return parseSavedPage(body, includeNonReels); } catch (err) { throw await this.halt(err); }
  }
  async resolve(mediaId, before) {
    if (!/^\d+$/.test(mediaId)) throw error('INPUT', 'Invalid media ID');
    const body = await this.request(PATHS.info(mediaId), { before });
    try { return parseVideo(body); } catch (err) {
      if (err.code === 'FORMAT') throw await this.halt(err);
      throw err;
    }
  }
  async comments(mediaId, cursor) {
    if (!/^\d+$/.test(mediaId)) throw error('INPUT', 'Invalid media ID');
    if (cursor != null && (typeof cursor !== 'string' || cursor.length > 2000)) throw error('INPUT', 'Invalid comments cursor');
    return parseComments(await this.request(PATHS.comments(mediaId, cursor)));
  }
  async bookmark(mediaId, saved) {
    if (!/^\d+$/.test(mediaId)) throw error('INPUT', 'Invalid media ID');
    const body = await this.request(PATHS.bookmark(mediaId, saved), { method: 'POST', mutation: true });
    if (body?.status !== 'ok') throw await this.halt(formatError('bookmark result has no success status'));
  }
}
