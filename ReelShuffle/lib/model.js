export const DEFAULT_SETTINGS = Object.freeze({ autoplay: true, muted: true, includeNonReels: false, requestDelay: 'normal' });

export function settingsWithDefaults(value = {}) {
  return {
    autoplay: typeof value.autoplay === 'boolean' ? value.autoplay : true,
    muted: typeof value.muted === 'boolean' ? value.muted : true,
    includeNonReels: value.includeNonReels === true,
    requestDelay: value.requestDelay === 'slow' ? 'slow' : 'normal',
  };
}

// The last item of the previous round cannot be the first of the next round.
export function shuffle(items, previous, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  if (result.length > 1 && result[0].shortcode === previous) {
    const j = 1 + Math.floor(random() * (result.length - 1));
    [result[0], result[j]] = [result[j], result[0]];
  }
  return result;
}

export function safeMediaUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    const host = u.hostname;
    return host === 'www.instagram.com' || host.endsWith('.cdninstagram.com') || host.endsWith('.fbcdn.net') ? u.href : '';
  } catch { return ''; }
}

export function cleanRecord(value) {
  if (typeof value?.mediaId === 'number' && !Number.isSafeInteger(value.mediaId)) throw new Error('Unsafe numeric media ID');
  if (!value || !/^[A-Za-z0-9_-]{1,80}$/.test(value.shortcode || '') || !/^\d+(?:_\d+)?$/.test(String(value.mediaId || ''))) {
    throw new Error('Invalid reel record');
  }
  return {
    shortcode: value.shortcode,
    mediaId: String(value.mediaId).split('_')[0],
    author: String(value.author || 'instagram').slice(0, 60),
    caption: String(value.caption || '').slice(0, 200),
    thumbUrl: safeMediaUrl(value.thumbUrl),
    savedAt: Number.isFinite(value.savedAt) ? value.savedAt : null,
    kind: value.kind === 'image' ? 'image' : 'video',
  };
}
