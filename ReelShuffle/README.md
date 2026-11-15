# ReelShuffle

A personal Manifest V3 Chrome extension for revisiting your own saved Instagram videos in a shuffled vertical feed. No build step, backend, account creation, external libraries, analytics or remote scripts.

## Install

1. Keep this entire **ReelShuffle** folder together. If you received a ZIP, extract it first.
2. In the Chrome profile where you use Instagram, open **chrome://extensions**.
3. Turn on **Developer mode**, click **Load unpacked**, and choose this folder (the one containing `manifest.json`).
4. Log in at **https://www.instagram.com/** in that same profile.
5. Open your **Saved** page on Instagram (`https://www.instagram.com/<your username>/saved/`). ReelShuffle picks it up and syncs your whole saved library from that tab. A small status pill in the bottom-right corner shows progress ("Loaded 350 reels…").
6. Pin ReelShuffle from Chrome's Extensions menu and click its icon. It opens the feed, or focuses the existing feed tab.

**Updating from 1.0:** go to `chrome://extensions` and click the reload icon on ReelShuffle, then reload any open Instagram tabs. Version 1.1 also clears safety pauses left over from 1.0's failed requests.

## How it gets your saved reels

All Instagram requests run **inside your instagram.com tab** via `content.js`. They are ordinary same-origin calls made with your logged-in session, the same calls Instagram's own Saved page makes. Version 1.0 sent them from the extension's background worker (a `chrome-extension://` origin), and Instagram rejected those. That is why it found nothing.

- Opening your Saved page (or navigating to it inside Instagram) starts a full sync of every saved page, about 50 items per request, 1.5 s apart. With ~1,000 saved reels that takes roughly 30–40 seconds.
- Opening the feed or pressing **Refresh** also syncs. It uses any open Instagram tab. If none is open, ReelShuffle opens `instagram.com` in a background tab and closes it after 3 idle minutes.
- One odd saved item (deleted post, unknown type) is skipped and does not abort the sync.

The first full refresh can take a few minutes for a large library. The feed starts after the first page arrives. Future opens draw from IndexedDB immediately while a complete refresh runs. Keep the folder in its installed location; Chrome loads its files from there. Edge and Brave offer equivalent developer extension installation screens.

## Use

- Scroll, swipe vertically, use **Up/Down** or **K/J**, or click **Keep discovering**.
- **M** toggles sound; **Space** toggles play/pause; **U** unsaves the current item.
- **Saved** removes one item from your actual Instagram saved list. **Undo** is available for five seconds and re-saves the item on Instagram. The feed advances only after Instagram confirms the unsave. A failed request keeps the item.
- **Original** opens the Instagram post. **Reshuffle** starts another shuffled round. Reaching the end also starts a new round automatically; there are no repeats inside a round.
- **Refresh** starts a full sync. **Pause refresh** stops pagination while preserving already cached records.
- Settings control autoplay, sound, request pace, and optionally photos and the first slide of carousels. Saved video posts are included by default.
- **Clear local data** removes the cached library and preferences. It does not remove your saves on Instagram. An active Instagram safety cooldown is retained until it expires.

Only the current post and next two have prepared media URLs. The feed keeps at most four post cards in the DOM, so a large library does not create thousands of video elements. A reel that fails gets one fresh URL retry, then is skipped for that round. If none can play, the feed waits for you to retry.

## Session and errors

- **Login needed:** sign in to Instagram in the same Chrome profile, return here and click Refresh. The extension never requests your password. A session expiry preserves your feed position.
- **Instagram asked us to slow down:** all API calls stop. The first cooldown is at least one minute; repeated blocks double the waiting time, up to an hour. Nothing retries automatically.
- **Instagram needs your attention:** requests stop, with an initial cooldown of at least 15 minutes. Open Instagram normally and follow its prompts. The extension does not solve or bypass challenges.
- **Instagram changed its format:** the sync stops and keeps the cache. The Instagram adapter may need an update.
- **Unreachable:** cached metadata remains available. Videos still require a working connection and Instagram authorization; videos are not downloaded for offline use.

This is designed for one account. A different account detected at session check clears the previous account's cache. Open the feed again or Refresh after switching Instagram accounts.

## Privacy and permissions

`scripting` injects `content.js` into Instagram tabs that were open before the extension loaded. `storage` is used for preferences and non-secret status/cooldown metadata. `cookies` reads only the Instagram CSRF cookie at request time; browser fetch attaches your normal session cookies. No password, cookie value or CSRF value is stored or logged by the extension.

Host access covers `www.instagram.com` and its `*.cdninstagram.com` / `*.fbcdn.net` media hosts. API requests go only to `www.instagram.com`, made from your Instagram tab by `content.js`; images and videos stream directly from those permitted media hosts. No API proxy, remote font or third-party service is used. Signed playback URLs exist only in memory, and are never written into IndexedDB or extension storage. Thumbnail URLs are cached as specified.

## Instagram adapter and live validation

All Instagram-specific paths, headers, parsing, cookie reads and pacing live in **`lib/instagram.js`**. `lib/tab-transport.js` carries each request to an Instagram tab, and `content.js` performs it there. It uses these unofficial web routes:

| Operation | Method and path |
| --- | --- |
| Session check | `GET /api/v1/accounts/current_user/?edit=true` |
| Saved library | `GET /api/v1/feed/saved/posts/?count=50&max_id=…` |
| Fresh playback source | `GET /api/v1/media/{mediaId}/info/` |
| Unsave | `POST /api/v1/web/save/{mediaId}/unsave/` |
| Undo / save | `POST /api/v1/web/save/{mediaId}/save/` |

Requests carry the Instagram web app ID, the current CSRF header, and `credentials: include`. They are serialized and spaced at least 1.5 seconds apart (2.5 seconds in Slow mode), including media lookups and save operations. There are no automatic endpoint fallbacks or challenge retries.

**These endpoints are undocumented and account-dependent. This delivery was tested using simulated responses in a real Chromium extension, not against your logged-in Instagram account. Live sync, playback, unsave, cookie policy compatibility, and undo must be confirmed in your browser.** The specification itself leaves endpoint discovery dependent on live network inspection; an authenticated session was not available during the build. The adapter is implemented, but this is not a claim of live Instagram acceptance.

If Instagram has changed a route or shape, open the Network panel on Instagram, inspect your normal Saved page / one manual Save or Unsave action, then update only `lib/instagram.js`. Do not paste session cookies or tokens into source code, issue reports, or console logs. A 404 may mean an endpoint changed or an item is unavailable. Missing `saved_at` is kept as `null`; publication time is never mislabeled as save time. Media IDs are expected as strings to preserve precision.

Implementation references: [Chrome Manifest V3](https://developer.chrome.com/docs/extensions/reference/manifest), [Chrome message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), and [a directly inspectable saved-feed implementation](https://github.com/gabrielvf1/instagram-saved-collections-fix/blob/main/instagram-saved-fix.user.js). These references inform implementation; they do not verify this user's live endpoints.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Chrome entry point, permissions, restrictive content policy |
| `background.js` | Toolbar launch, sync, messages, save/unsave coordination |
| `content.js` | Runs on instagram.com: performs API calls same-origin, detects the Saved page, shows sync status |
| `lib/tab-transport.js` | Routes API requests from the worker to an Instagram tab |
| `lib/instagram.js` | Instagram adapter and request gate |
| `lib/db.js` | IndexedDB cache, metadata, full-sync reconciliation |
| `lib/model.js` | Record sanitization, shuffle, media URL validation |
| `feed.html`, `feed.css`, `feed.js` | Feed, virtualized player, settings, notifications |
| `icons/` | Local extension icons |
| `TESTING.md` | Verification results and live acceptance checklist |

This uses an unofficial Instagram interface. The terms and account risks described in the supplied SRS still apply. Personal use only; no Chrome Web Store publication, downloads, video exports, collections or server components are included.
