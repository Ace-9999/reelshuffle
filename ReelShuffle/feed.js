import { getReels } from './lib/db.js';
import { shuffle, settingsWithDefaults } from './lib/model.js';

const $ = id => document.getElementById(id);
const feed = $('feed');
let settings = settingsWithDefaults(), state = {}, library = new Map(), order = [], active = 0, round = 0;
let cards = new Map(), assets = new Map(), unavailable = new Set(), pending = new Map();
let blocked = false, switchingRound = false, refreshingCache = false, refreshAgain = false;
let toastTimer, undoTimer, undoAction, nextRoundTimer, wheelAt = 0, wheelDelta = 0;
// Reels already shown. No repeats until every cached reel has been shown or Reshuffle is pressed. Persists across opens.
let shown = new Set(), shownSaveTimer = 0, fastFor = null;
function saveShown() {
  clearTimeout(shownSaveTimer);
  shownSaveTimer = setTimeout(() => { chrome.storage.local.set({ shownReels: [...shown] }).catch(() => {}); }, 500);
}
function markShown(shortcode) { if (shortcode && !shown.has(shortcode)) { shown.add(shortcode); saveShown(); } }
let scrollFrame = 0, lastFirst = null, manuallyPaused = new Set(), clearInProgress = false, programmaticUntil = 0;
const blockers = new Set(['AUTH', 'RATE_LIMIT', 'CHALLENGE', 'FORMAT']);
const before = document.createElement('div'), after = document.createElement('div');
before.className = after.className = 'feed-spacer';
const ending = document.createElement('div'); ending.className = 'round-end'; ending.textContent = 'A new round is on its way…';
feed.append(before, after);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

async function rpc(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    const detail = response?.error || { code: 'LOCAL', message: 'The extension restarted. Refresh this tab to reconnect.' };
    const err = Object.assign(new Error(detail.message), detail);
    if (blockers.has(err.code)) applyState({ ...state, phase: 'error', ...detail });
    throw err;
  }
  return response.data;
}
function notify(message, { undo, duration = 5000 } = {}) {
  clearTimeout(toastTimer); clearInterval(undoTimer);
  $('toast-text').textContent = message;
  $('toast').hidden = false;
  $('toast-undo').hidden = !undo;
  $('toast-timer').hidden = !undo;
  $('toast-timer').getAnimations().forEach(a => a.cancel());
  undoAction = undo || null;
  if (undo) {
    const deadline = Date.now() + 5000;
    $('undo-seconds').textContent = '5';
    $('toast-timer').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: 5000, fill: 'forwards' });
    undoTimer = setInterval(() => { $('undo-seconds').textContent = String(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))); }, 200);
  }
  toastTimer = setTimeout(dismissToast, duration);
}
function dismissToast() {
  $('toast').hidden = true; undoAction = null; clearTimeout(toastTimer); clearInterval(undoTimer);
}

function applyState(next) {
  state = next;
  blocked = next.phase === 'error' && blockers.has(next.code);
  $('sync-status').textContent = (next.message || 'Ready') + (next.pendingUnsaves && next.phase !== 'syncing' ? ` · ${next.pendingUnsaves} unsave${next.pendingUnsaves === 1 ? '' : 's'} waiting for Refresh` : '');
  $('sync-status').title = next.lastSync ? `Last full refresh: ${new Date(next.lastSync).toLocaleString()}` : 'No complete refresh yet';
  $('status-dot').className = `status-dot ${next.phase === 'syncing' ? 'busy' : next.phase === 'error' ? 'error' : ''}`;
  $('refresh').disabled = next.phase === 'syncing' || clearInProgress;
  $('cancel-sync').hidden = next.phase !== 'syncing';
  $('banner').hidden = next.phase !== 'error' || library.size === 0;
  let message = next.message || '';
  if (next.retryAt) message += ` Try again after ${new Date(next.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  $('banner-text').textContent = message;
  $('banner-instagram').href = next.code === 'AUTH' ? 'https://www.instagram.com/accounts/login/' : 'https://www.instagram.com/';
  $('banner-resume').disabled = Boolean(next.retryAt && next.retryAt > Date.now());
  updateEmpty();
  if (!blocked && order.length) prepareWindow();
}

function updateEmpty() {
  const hasItems = order.length > 0;
  $('player-shell').hidden = !hasItems;
  $('empty').hidden = hasItems;
  $('saved-count').textContent = `${library.size.toLocaleString()} saved`;
  if (hasItems) return;
  const auth = state.code === 'AUTH';
  $('empty-title').textContent = auth ? 'Your library is one login away.' : state.phase === 'syncing' ? 'Finding your saved gems.' : state.phase === 'error' ? 'Let’s pick this up shortly.' : 'No saved reels found';
  $('empty-description').textContent = auth ? 'Log in to Instagram in this Chrome profile. Then come back and refresh your library.' : state.phase === 'error' ? state.message : state.phase === 'syncing' ? 'Your first reels will appear as soon as they arrive. Larger libraries take a moment.' : 'Open your Saved page on Instagram. ReelShuffle loads your whole saved library from there.';
  const savedPage = state.username ? `https://www.instagram.com/${encodeURIComponent(state.username)}/saved/` : 'https://www.instagram.com/';
  $('empty-instagram').href = auth ? 'https://www.instagram.com/accounts/login/' : savedPage;
  $('empty-instagram').firstChild.textContent = auth ? 'Log in to Instagram ' : state.username ? 'Open my Saved page ' : 'Open Instagram ';
  $('empty-retry').disabled = state.phase === 'syncing' || Boolean(state.retryAt && state.retryAt > Date.now()) || clearInProgress;
  $('empty-retry').textContent = auth ? 'I’m logged in · Refresh' : 'Refresh now';
}

async function refreshCache(reset = false) {
  if (refreshingCache) { refreshAgain = true; return; }
  refreshingCache = true;
  try {
    const records = await getReels();
    library = new Map(records.map(r => [r.shortcode, r]));
    if (reset) { dropAll(); order = []; active = 0; round = 0; }
    if (!order.length && library.size && !clearInProgress) {
      await startRound();
    } else if (order.length) {
      const current = order[active]?.shortcode;
      const previousLength = order.length;
      order = order.filter(r => library.has(r.shortcode));
      const preserved = order.findIndex(r => r.shortcode === current);
      active = preserved >= 0 ? preserved : Math.min(active, Math.max(0, order.length - 1));
      if (order.length) {
        // Keep the round stable while new pages arrive. New saves join the next round.
        order = order.map(r => library.get(r.shortcode));
        if (previousLength !== order.length || preserved < 0) {
          renderWindow(true); feed.scrollTop = active * height();
        } else { updateControls(); prepareWindow(); }
      } else if (library.size) await startRound();
      else dropAll();
    }
    updateEmpty();
  } catch { notify('The local cache could not be opened. Reopen the extension to try again.'); }
  finally {
    refreshingCache = false;
    if (refreshAgain) { refreshAgain = false; void refreshCache(); }
  }
}

async function startRound(manual = false) {
  if (switchingRound) return;
  switchingRound = true;
  clearTimeout(nextRoundTimer); $('round-card').hidden = true;
  try {
    const previous = order[active]?.shortcode || lastFirst;
    const records = await getReels();
    library = new Map(records.map(r => [r.shortcode, r]));
    if (manual) { unavailable.clear(); shown.clear(); }
    for (const code of shown) if (!library.has(code)) shown.delete(code);
    let playable = records.filter(r => !unavailable.has(r.shortcode) && !shown.has(r.shortcode));
    // Everything has been shown: start over with the whole library.
    if (!playable.length) { shown.clear(); playable = records.filter(r => !unavailable.has(r.shortcode)); }
    saveShown();
    if (!playable.length && records.length) { showUnavailable(); return; }
    dropAll();
    order = shuffle(playable, previous); active = 0; round++;
    lastFirst = order[0]?.shortcode || null;
    await chrome.storage.session.set({ previousFirst: lastFirst });
    manuallyPaused.clear();
    updateEmpty();
    renderWindow(); feed.scrollTop = 0;
  } finally { switchingRound = false; }
}

function height() { return feed.clientHeight || 600; }
function dropCard(key, card) {
  const video = card.querySelector('video');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  observer.unobserve(card); card.remove(); cards.delete(key);
}
function dropAll() {
  for (const [key, card] of [...cards]) dropCard(key, card);
  for (const slot of assets.values()) if (slot.pending && slot.requestId) void rpc('CANCEL_RESOLVE', { requestId: slot.requestId }).catch(() => {});
  assets.clear(); ending.remove(); before.style.height = after.style.height = '0px';
}
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const video = entry.target.querySelector('video');
    if (!video) continue;
    if (!entry.isIntersecting || Number(entry.target.dataset.index) !== active || document.hidden) video.pause();
    else if (entry.intersectionRatio >= .6) playActive();
  }
}, { root: feed, threshold: [0, .6, 1] });

function makeCard(reel, index) {
  const card = document.createElement('article'); card.className = 'reel-card'; card.dataset.shortcode = reel.shortcode; card.dataset.index = index;
  card.setAttribute('aria-label', `Saved ${reel.kind === 'image' ? 'post' : 'reel'} by ${reel.author}`);
  const video = document.createElement('video');
  video.playsInline = true; video.loop = true; video.muted = settings.muted; video.preload = 'auto'; video.disablePictureInPicture = false;
  if (reel.thumbUrl) video.poster = reel.thumbUrl;
  video.setAttribute('aria-label', `Video by ${reel.author}`);
  const image = document.createElement('img'); image.className = 'post-image'; image.alt = `Saved post by ${reel.author}`; image.hidden = true;
  const overlay = document.createElement('button'); overlay.className = 'play-overlay paused'; overlay.setAttribute('aria-label', 'Play or pause reel');
  overlay.innerHTML = '<span class="play-symbol"><svg><use href="#i-play"/></svg></span>';
  overlay.addEventListener('click', togglePlay);
  const metadata = document.createElement('div'); metadata.className = 'card-metadata';
  const author = document.createElement('div'); author.className = 'author-line';
  const avatar = document.createElement('span'); avatar.className = 'author-avatar'; avatar.textContent = reel.author.slice(0, 1);
  const username = document.createElement('a'); username.className = 'author-link'; username.textContent = `@${reel.author}`;
  username.href = `https://www.instagram.com/${encodeURIComponent(reel.author)}/`; username.target = '_blank'; username.rel = 'noopener noreferrer';
  author.append(avatar, username);
  const caption = document.createElement('p'); caption.className = 'caption'; caption.textContent = reel.caption;
  const savedTag = document.createElement('div'); savedTag.className = 'saved-tag';
  savedTag.innerHTML = '<svg><use href="#i-bookmark"/></svg><span>FROM YOUR SAVED LIBRARY</span>';
  metadata.append(author, caption, savedTag);
  const progress = document.createElement('div'); progress.className = 'video-progress'; progress.innerHTML = '<span></span>';
  const loading = document.createElement('span'); loading.className = 'loading-label'; loading.textContent = 'Getting your reel ready';
  card.append(video, image, overlay, metadata, progress, loading);
  // Click or drag the bar to seek (mouse only).
  const seekTo = event => {
    if (!Number.isFinite(video.duration) || !video.duration) return;
    const rect = progress.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    progress.firstChild.style.width = `${ratio * 100}%`;
  };
  progress.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    progress.setPointerCapture(event.pointerId); progress.classList.add('seeking'); seekTo(event);
  });
  progress.addEventListener('pointermove', event => { if (progress.hasPointerCapture(event.pointerId)) seekTo(event); });
  const endSeek = event => { if (progress.hasPointerCapture(event.pointerId)) progress.releasePointerCapture(event.pointerId); progress.classList.remove('seeking'); };
  progress.addEventListener('pointerup', endSeek); progress.addEventListener('pointercancel', endSeek);
  progress.addEventListener('click', event => event.stopPropagation());
  video.addEventListener('timeupdate', () => {
    if (progress.classList.contains('seeking')) return; progress.firstChild.style.width = `${Number.isFinite(video.duration) && video.duration ? video.currentTime / video.duration * 100 : 0}%`; });
  video.addEventListener('play', () => overlay.classList.remove('paused'));
  video.addEventListener('pause', () => overlay.classList.add('paused'));
  video.addEventListener('loadeddata', () => { loading.hidden = true; if (reel.shortcode === order[active]?.shortcode) playActive(); });
  video.addEventListener('error', () => { if (video.hasAttribute('src')) void retryMedia(reel); });
  image.addEventListener('load', () => { loading.hidden = true; });
  image.addEventListener('error', () => { if (image.hasAttribute('src')) void retryMedia(reel); });
  cards.set(reel.shortcode, card); observer.observe(card);
  return card;
}

function renderWindow(rebuild = false) {
  if (!order.length) { updateEmpty(); return; }
  if (rebuild) for (const [key, card] of [...cards]) dropCard(key, card);
  const first = Math.max(0, active - 1), last = Math.min(order.length - 1, active + 2);
  const desired = new Set(order.slice(first, last + 1).map(r => r.shortcode));
  for (const [key, card] of [...cards]) if (!desired.has(key)) dropCard(key, card);
  before.style.height = `${first * height()}px`;
  after.style.height = `${Math.max(0, order.length - last - 1) * height()}px`;
  for (let i = first; i <= last; i++) {
    const reel = order[i];
    const card = cards.get(reel.shortcode) || makeCard(reel, i);
    card.dataset.index = i; card.style.height = `${height()}px`;
    feed.insertBefore(card, after);
  }
  // One extra snap target makes scrolling past the last reel start the next round.
  ending.style.height = `${height()}px`; feed.append(ending);
  updateControls(); prepareWindow();
}

function updateControls() {
  const reel = order[active]; if (!reel) return;
  markShown(reel.shortcode);
  // 2x only lasts for the reel it was turned on for.
  if (fastFor && fastFor !== reel.shortcode) fastFor = null;
  for (const [key, card] of cards) { const v = card.querySelector('video'); if (v) v.playbackRate = key === fastFor ? 2 : 1; }
  $('speed').setAttribute('aria-pressed', String(fastFor === reel.shortcode));
  $('speed').classList.toggle('on', fastFor === reel.shortcode);
  $('position').replaceChildren();
  $('position').append(document.createTextNode(String(active + 1).padStart(2, '0') + ' '));
  const total = document.createElement('span'); total.textContent = `/ ${String(order.length).padStart(2, '0')}`; $('position').append(total);
  $('round-label').textContent = `ROUND ${String(round).padStart(2, '0')}`;
  $('library-detail').textContent = state.username ? `@${state.username.toUpperCase()} · YOUR LIBRARY` : 'NO ALGORITHMS. JUST YOU.';
  $('open-reel').href = `https://www.instagram.com/${reel.kind === 'image' ? 'p' : 'reel'}/${reel.shortcode}/`;
  const isPending = pending.has(reel.shortcode);
  $('unsave').classList.toggle('saved', !isPending);
  $('unsave').setAttribute('aria-pressed', String(!isPending));
  $('unsave').disabled = isPending || blocked;
  $('save-label').textContent = isPending ? 'Removing' : 'Saved';
  $('mute-icon').firstElementChild.setAttribute('href', settings.muted ? '#i-mute' : '#i-volume');
  $('mute').setAttribute('aria-label', settings.muted ? 'Unmute' : 'Mute');
  $('mute').setAttribute('aria-pressed', String(settings.muted));
  $('mute-label').textContent = settings.muted ? 'Sound off' : 'Sound on';
  if (!$('comments-panel').hidden && comments.shortcode !== reel.shortcode) void loadComments(true);
}

function prepareWindow() {
  if (!order.length || clearInProgress) return;
  const prepared = new Set(order.slice(active, active + 3).map(r => r.shortcode));
  for (const [key, slot] of assets) if (!prepared.has(key)) {
    if (slot.pending && slot.requestId) void rpc('CANCEL_RESOLVE', { requestId: slot.requestId }).catch(() => {});
    assets.delete(key);
    const card = cards.get(key), video = card?.querySelector('video'), img = card?.querySelector('.post-image');
    if (video?.hasAttribute('src')) { video.pause(); video.removeAttribute('src'); video.load(); }
    if (img?.hasAttribute('src')) img.removeAttribute('src');
  }
  for (const [key, card] of cards) if (key !== order[active]?.shortcode) card.querySelector('video')?.pause();
  if (blocked || document.hidden) return;
  for (const reel of order.slice(active, active + 3)) {
    const asset = assets.get(reel.shortcode);
    if (asset?.failed && reel.shortcode === order[active]?.shortcode) void skipUnavailable(reel);
    else if (asset?.data && !asset.failed) attachMedia(reel, asset.data);
    else if (!asset) void loadMedia(reel);
  }
}

async function loadMedia(reel, attempts = 0) {
  const slot = { attempts, pending: true, requestId: crypto.randomUUID() }; assets.set(reel.shortcode, slot);
  try {
    const data = await rpc('RESOLVE', { mediaId: reel.mediaId, requestId: slot.requestId });
    if (assets.get(reel.shortcode) !== slot) return;
    slot.data = data; slot.pending = false;
    attachMedia(reel, data);
  } catch (err) {
    if (assets.get(reel.shortcode) !== slot) return;
    slot.pending = false;
    if (blockers.has(err.code) || err.code === 'CANCELLED') { assets.delete(reel.shortcode); updateControls(); return; }
    if (attempts === 0) { await loadMedia(reel, 1); return; }
    slot.failed = true; slot.data = null;
    if (reel.shortcode === order[active]?.shortcode) void skipUnavailable(reel);
  }
}
function attachMedia(reel, data) {
  const card = cards.get(reel.shortcode); if (!card) return;
  const video = card.querySelector('video'), image = card.querySelector('.post-image');
  if (data.kind === 'image') {
    video.hidden = true; image.hidden = false; card.querySelector('.play-overlay').hidden = true;
    if (image.getAttribute('src') !== data.url) image.src = data.url;
    card.querySelector('.video-progress').hidden = true;
  } else {
    video.hidden = false; image.hidden = true;
    video.muted = settings.muted;
    if (video.getAttribute('src') !== data.url) video.src = data.url;
    if (reel.shortcode === order[active]?.shortcode) playActive();
  }
}
async function retryMedia(reel) {
  const slot = assets.get(reel.shortcode);
  if (!slot || slot.pending || blocked) return;
  const card = cards.get(reel.shortcode);
  const video = card?.querySelector('video'), image = card?.querySelector('.post-image');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  image?.removeAttribute('src');
  if (slot.attempts >= 1) {
    slot.failed = true;
    if (reel.shortcode === order[active]?.shortcode) await skipUnavailable(reel);
  } else await loadMedia(reel, 1);
}
async function skipUnavailable(reel) {
  if (unavailable.has(reel.shortcode)) return;
  unavailable.add(reel.shortcode);
  notify('Unavailable · skipping this reel');
  if (order.every(r => unavailable.has(r.shortcode))) { showUnavailable(); return; }
  if (reel.shortcode === order[active]?.shortcode) navigate(1);
}
function showUnavailable() {
  for (const card of cards.values()) card.querySelector('video')?.pause();
  $('round-card').hidden = false;
  $('round-card').querySelector('h2').textContent = 'A little pause for now.';
  $('round-card').querySelector('p').textContent = 'These reels couldn’t load. Your saves are kept; try again later.';
  $('next-round').textContent = 'Try these reels again';
}
function playActive(force = false) {
  const reel = order[active], video = cards.get(reel?.shortcode)?.querySelector('video');
  if (!video || video.hidden || !video.hasAttribute('src') || document.hidden) return;
  if (!force && (!settings.autoplay || manuallyPaused.has(reel.shortcode))) return;
  video.muted = settings.muted;
  video.playbackRate = fastFor === reel.shortcode ? 2 : 1;
  const attempt = video.play();
  attempt?.catch(err => {
    if (err.name === 'NotAllowedError') cards.get(reel.shortcode)?.querySelector('.play-overlay').classList.add('paused');
  });
}
function togglePlay() {
  const reel = order[active], video = cards.get(reel?.shortcode)?.querySelector('video');
  if (!video || video.hidden) return;
  if (video.paused) { manuallyPaused.delete(reel.shortcode); playActive(true); }
  else { manuallyPaused.add(reel.shortcode); video.pause(); }
}
function navigate(delta) {
  if (!order.length || switchingRound || !$('round-card').hidden) return;
  let index = active + delta;
  while (index >= 0 && index < order.length && unavailable.has(order[index].shortcode)) index += delta;
  if (index < 0) index = 0;
  if (index >= order.length) { endRound(); return; }
  active = index; programmaticUntil = Date.now() + (reduceMotion ? 0 : 650);
  renderWindow();
  feed.scrollTo({ top: active * height(), behavior: reduceMotion ? 'instant' : 'smooth' });
}
function endRound() {
  for (const card of cards.values()) card.querySelector('video')?.pause();
  $('round-card').hidden = false;
  $('round-card').querySelector('h2').textContent = 'A fresh perspective.';
  $('round-card').querySelector('p').textContent = 'You’ve reached the end. Shuffling your next round…';
  $('next-round').textContent = 'Shuffle again';
  clearTimeout(nextRoundTimer);
  nextRoundTimer = setTimeout(() => void startRound(), 1200);
}

async function unsave() {
  const reel = order[active];
  if (!reel || pending.has(reel.shortcode) || blocked) return;
  const operation = { undoRequested: false };
  pending.set(reel.shortcode, operation); updateControls();
  const removed = rpc('BOOKMARK', { reel, saved: false });
  notify('Unsaved · syncs to Instagram on Refresh', { undo: async () => {
    operation.undoRequested = true;
    notify('Restoring your save…', { duration: 12000 });
    try {
      await removed;
      await rpc('BOOKMARK', { reel, saved: true });
      library.set(reel.shortcode, reel);
      if (!order.some(r => r.shortcode === reel.shortcode)) order.splice(Math.min(active + 1, order.length), 0, reel);
      pending.delete(reel.shortcode); await refreshCache();
      notify('Restored to your library');
    } catch (err) { pending.delete(reel.shortcode); updateControls(); notify(`Couldn’t restore this save. ${err.message}`, { duration: 8000 }); }
  } });
  try {
    await removed;
    if (!operation.undoRequested) { pending.delete(reel.shortcode); await refreshCache(); }
  } catch (err) {
    pending.delete(reel.shortcode); updateControls();
    notify(`Couldn’t unsave. ${err.message}`, { duration: 8000 });
  }
}

async function refresh(full = false) {
  try {
    // Only an explicit refresh resumes a halted client. No automatic block retries.
    blocked = false; unavailable.clear();
    await rpc('SYNC', { full });
  } catch (err) { notify(err.message); }
}

feed.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (switchingRound || !order.length || Date.now() < programmaticUntil) return;
    const index = Math.round(feed.scrollTop / height());
    if (index >= order.length) { endRound(); return; }
    if (index !== active && index >= 0) { active = index; renderWindow(); }
  });
}, { passive: true });
// Native snap points cannot span virtualized gaps. Snap after a touch/trackpad
// gesture settles instead, so a long swipe can land anywhere in a large library.
feed.addEventListener('scrollend', () => {
  if (!order.length || switchingRound || !$('round-card').hidden) return;
  const target = Math.min(order.length - 1, Math.round(feed.scrollTop / height()));
  const top = target * height();
  if (Math.abs(feed.scrollTop - top) > 1) {
    active = target; renderWindow();
    programmaticUntil = Date.now() + (reduceMotion ? 0 : 650);
    feed.scrollTo({ top, behavior: reduceMotion ? 'instant' : 'smooth' });
  }
});
// Wheel anywhere on the page (not just over the reel) moves between reels.
window.addEventListener('wheel', event => {
  if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  if (event.target.closest?.('#comments-panel')) return;
  if ($('player-shell').hidden || !order.length || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (Date.now() - wheelAt < 520) return;
  wheelDelta += event.deltaY;
  if (Math.abs(wheelDelta) >= 24) { navigate(wheelDelta > 0 ? 1 : -1); wheelDelta = 0; wheelAt = Date.now(); }
}, { passive: false });
window.addEventListener('resize', () => { if (order.length) { renderWindow(); feed.scrollTop = active * height(); } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) for (const card of cards.values()) card.querySelector('video')?.pause();
  else prepareWindow();
});
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]') || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  const key = event.key.toLowerCase();
  if (event.target.closest('button,a') && [' ', 'enter'].includes(key)) return;
  if (['arrowdown', 'arrowright', 'j'].includes(key)) { event.preventDefault(); navigate(1); }
  else if (['arrowup', 'arrowleft', 'k'].includes(key)) { event.preventDefault(); navigate(-1); }
  else if (key === 'm') { event.preventDefault(); void toggleMute(); }
  else if (key === ' ') { event.preventDefault(); togglePlay(); }
  else if (key === 'u') { event.preventDefault(); void unsave(); }
  else if (key === 'c') { event.preventDefault(); toggleComments(); }
  else if (key === 'escape' && !$('comments-panel').hidden) toggleComments(false);
  else if (key === '?') $('help-dialog').showModal();
});
async function toggleMute() {
  settings.muted = !settings.muted;
  for (const card of cards.values()) card.querySelector('video').muted = settings.muted;
  updateControls(); playActive(true);
  try { await rpc('SETTINGS', { settings }); } catch (err) { notify(err.message); }
}
$('mute').addEventListener('click', () => void toggleMute());
$('unsave').addEventListener('click', () => void unsave());
$('next').addEventListener('click', () => navigate(1));
$('reshuffle').addEventListener('click', () => void startRound(true));
$('next-round').addEventListener('click', () => void startRound(true));
for (const id of ['refresh', 'empty-retry', 'banner-resume']) $(id).addEventListener('click', () => void refresh());
$('cancel-sync').addEventListener('click', async () => { try { await rpc('CANCEL_SYNC'); } catch (err) { notify(err.message); } });
$('toast-dismiss').addEventListener('click', dismissToast);
$('toast-undo').addEventListener('click', () => { const undo = undoAction; dismissToast(); if (undo) void undo(); });
$('help-open').addEventListener('click', () => $('help-dialog').showModal());
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
$('settings-open').addEventListener('click', () => {
  const form = $('settings-form');
  for (const key of ['autoplay', 'muted', 'includeNonReels']) form.elements[key].checked = settings[key];
  form.elements.requestDelay.value = settings.requestDelay;
  $('settings-dialog').showModal();
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  const previousInclude = settings.includeNonReels;
  settings = { autoplay: form.elements.autoplay.checked, muted: form.elements.muted.checked, includeNonReels: form.elements.includeNonReels.checked, requestDelay: form.elements.requestDelay.value };
  try {
    await rpc('SETTINGS', { settings });
    $('settings-dialog').close(); updateControls();
    for (const card of cards.values()) { const v = card.querySelector('video'); v.muted = settings.muted; if (!settings.autoplay) v.pause(); }
    if (settings.autoplay) playActive();
    if (previousInclude !== settings.includeNonReels) await refresh(true);
    notify('Preferences saved');
  } catch (err) { notify(err.message); }
});
// Comments: read-only, fetched for the reel in view while the panel is open.
const comments = { shortcode: null, cursor: null, loading: false, token: 0 };
function timeAgo(seconds) {
  if (!seconds) return '';
  const s = Math.max(0, Date.now() / 1000 - seconds);
  for (const [unit, size] of [['y', 31536000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]]) if (s >= size) return `${Math.floor(s / size)}${unit}`;
  return 'now';
}
function commentNode(c) {
  const row = document.createElement('div'); row.className = 'comment';
  const avatar = document.createElement(c.avatar ? 'img' : 'span'); avatar.className = 'comment-avatar';
  if (c.avatar) { avatar.src = c.avatar; avatar.alt = ''; avatar.referrerPolicy = 'no-referrer'; } else avatar.textContent = c.author.slice(0, 1);
  const body = document.createElement('div');
  const head = document.createElement('div'); head.className = 'comment-head';
  const name = document.createElement('strong'); name.textContent = c.author;
  const when = document.createElement('span'); when.textContent = timeAgo(c.createdAt);
  head.append(name, when);
  const text = document.createElement('p'); text.textContent = c.text;
  const meta = document.createElement('div'); meta.className = 'comment-meta';
  meta.textContent = [c.likes ? `${c.likes.toLocaleString()} like${c.likes === 1 ? '' : 's'}` : '', c.replies ? `${c.replies.toLocaleString()} repl${c.replies === 1 ? 'y' : 'ies'}` : ''].filter(Boolean).join(' · ');
  body.append(head, text); if (meta.textContent) body.append(meta);
  row.append(avatar, body);
  return row;
}
function commentsNote(text) { const p = document.createElement('p'); p.className = 'comments-note'; p.textContent = text; return p; }
async function loadComments(reset = false) {
  const reel = order[active]; if (!reel) return;
  if (reset) {
    Object.assign(comments, { shortcode: reel.shortcode, cursor: null, loading: false, token: comments.token + 1 });
    $('comments-title').textContent = 'Comments';
    $('comments-list').replaceChildren(commentsNote('Loading comments…'));
    $('comments-instagram').href = `https://www.instagram.com/${reel.kind === 'image' ? 'p' : 'reel'}/${reel.shortcode}/`;
    $('comments-more').hidden = true;
  }
  if (comments.loading) return;
  const token = comments.token; comments.loading = true; $('comments-more').disabled = true;
  try {
    const page = await rpc('COMMENTS', { mediaId: reel.mediaId, cursor: comments.cursor });
    if (token !== comments.token) return;
    if (reset) $('comments-list').replaceChildren();
    if (page.total != null) $('comments-title').textContent = `Comments · ${page.total.toLocaleString()}`;
    $('comments-list').append(...page.comments.map(commentNode));
    if (!$('comments-list').childElementCount) $('comments-list').append(commentsNote(page.disabled ? 'Comments are turned off for this reel.' : 'No comments yet.'));
    comments.cursor = page.cursor; $('comments-more').hidden = !page.cursor;
  } catch (err) {
    if (token !== comments.token) return;
    if (reset) $('comments-list').replaceChildren();
    $('comments-list').append(commentsNote(err.message || 'Comments couldn’t load right now.'));
  } finally {
    if (token === comments.token) { comments.loading = false; $('comments-more').disabled = false; }
  }
}
function toggleComments(show = $('comments-panel').hidden) {
  $('comments-panel').hidden = !show;
  document.body.classList.toggle('comments-open', show);
  $('comments-open').setAttribute('aria-expanded', String(show));
  if (show && comments.shortcode !== order[active]?.shortcode) void loadComments(true);
  if (!show) feed.focus({ preventScroll: true });
}
$('comments-open').addEventListener('click', () => toggleComments());
$('speed').addEventListener('click', () => {
  const reel = order[active]; if (!reel) return;
  fastFor = fastFor === reel.shortcode ? null : reel.shortcode;
  updateControls();
});
$('comments-close').addEventListener('click', () => toggleComments(false));
$('comments-more').addEventListener('click', () => void loadComments());

// Export: every cached record, with its Instagram link, as JSON or CSV.
async function exportRows() {
  const records = await getReels();
  return records.map(r => ({
    url: `https://www.instagram.com/${r.kind === 'image' ? 'p' : 'reel'}/${r.shortcode}/`,
    shortcode: r.shortcode, mediaId: r.mediaId, author: r.author, caption: r.caption, kind: r.kind,
    thumbnailUrl: r.thumbUrl || '', savedAt: r.savedAt ? new Date(r.savedAt * (r.savedAt < 1e12 ? 1000 : 1)).toISOString() : '',
  }));
}
function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const exportName = ext => `reelshuffle-saved-${new Date().toISOString().slice(0, 10)}.${ext}`;
$('export-open').addEventListener('click', async () => {
  $('export-count').textContent = `${(await getReels()).length.toLocaleString()} items in your library.`;
  $('export-dialog').showModal();
});
$('export-json').addEventListener('click', async () => {
  const rows = await exportRows();
  download(exportName('json'), 'application/json', JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, reels: rows }, null, 2));
  $('export-dialog').close(); notify(`Exported ${rows.length.toLocaleString()} reels as JSON`);
});
$('export-csv').addEventListener('click', async () => {
  const rows = await exportRows();
  const columns = ['url', 'author', 'caption', 'kind', 'savedAt', 'shortcode', 'mediaId', 'thumbnailUrl'];
  const cell = v => /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const csv = '﻿' + [columns.join(','), ...rows.map(r => columns.map(c => cell(r[c] ?? '')).join(','))].join('\r\n');
  download(exportName('csv'), 'text/csv', csv);
  $('export-dialog').close(); notify(`Exported ${rows.length.toLocaleString()} reels as CSV`);
});
// Import: read a ReelShuffle JSON or CSV export and make it the new local library.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header = [], ...body] = rows.filter(r => r.some(Boolean));
  return body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}
function importRecord(row) {
  const fromUrl = /instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/.exec(String(row.url || ''))?.[1];
  const saved = row.savedAt === '' || row.savedAt == null ? null
    : Number.isFinite(Number(row.savedAt)) ? Number(row.savedAt) : Math.floor(Date.parse(row.savedAt) / 1000) || null;
  return {
    shortcode: row.shortcode || fromUrl, mediaId: String(row.mediaId ?? ''), author: row.author, caption: row.caption,
    thumbUrl: row.thumbnailUrl ?? row.thumbUrl, savedAt: saved, kind: row.kind,
  };
}
$('import-open').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  try {
    const text = (await file.text()).replace(/^﻿/, '');
    let rows;
    if (/^\s*[[{]/.test(text)) { const data = JSON.parse(text); rows = Array.isArray(data) ? data : data.reels; }
    else rows = parseCsv(text);
    if (!Array.isArray(rows) || !rows.length) throw new Error('That file has no reels in it.');
    if (!confirm(`Replace your current library (${library.size.toLocaleString()} reels) with ${rows.length.toLocaleString()} from "${file.name}"?`)) return;
    clearTimeout(nextRoundTimer);
    const result = await rpc('IMPORT', { reels: rows.map(importRecord) });
    $('export-dialog').close();
    notify(`Imported ${result.imported.toLocaleString()} reels${result.skipped ? ` · skipped ${result.skipped} invalid` : ''}`);
  } catch (err) {
    notify(err instanceof SyntaxError ? 'That file isn’t valid JSON.' : err.message, { duration: 8000 });
  }
});
$('full-refresh').addEventListener('click', () => { $('settings-dialog').close(); void refresh(true); });

$('clear-open').addEventListener('click', () => { $('settings-dialog').close(); $('clear-dialog').showModal(); });
$('clear-confirm').addEventListener('click', async () => {
  clearInProgress = true; $('clear-confirm').disabled = true; blocked = true;
  try {
    clearTimeout(nextRoundTimer); dropAll();
    const result = await rpc('CLEAR');
    settings = result.settings; library.clear(); order = []; active = 0; round = 0; pending.clear(); unavailable.clear();
    shown.clear(); await chrome.storage.local.remove('shownReels');
    $('clear-dialog').close(); updateEmpty(); notify('Local library and preferences cleared');
  } catch (err) { notify(err.message); }
  finally { clearInProgress = false; $('clear-confirm').disabled = false; applyState(state); }
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'STATE_CHANGED') { applyState(message.state); updateControls(); }
  else if (message.type === 'CACHE_CHANGED') void refreshCache(message.reset);
  else if (message.type === 'SETTINGS_CHANGED') { settings = message.settings; updateControls(); }
});

async function init() {
  try {
    const [initial, session, seenStore] = await Promise.all([rpc('GET_STATE'), chrome.storage.session.get('previousFirst'), chrome.storage.local.get('shownReels')]);
    shown = new Set(Array.isArray(seenStore.shownReels) ? seenStore.shownReels : []);
    settings = initial.settings; lastFirst = session.previousFirst || null; applyState(initial.state);
    await refreshCache();
    // Open from cache. Only Refresh syncs, except the very first time when there is nothing cached yet.
    if (library.size === 0 && !state.lastSync && state.phase !== 'syncing') await rpc('SYNC');
    // Update cooldown controls without making requests.
    setInterval(() => { if (state.retryAt && state.retryAt <= Date.now()) { $('banner-resume').disabled = false; $('empty-retry').disabled = false; } }, 1000);
  } catch (err) {
    applyState({ phase: 'error', code: err.code || 'LOCAL', message: err.message });
  }
}
void init();
