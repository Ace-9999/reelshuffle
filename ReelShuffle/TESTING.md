# Verification and live acceptance

Built on 15 November 2026 from the supplied Saved Reels Feed SRS.

## Automated verification

The development workspace includes `tests/core.test.mjs`, `tests/worker.test.mjs`, and `tests/browser-check.mjs`. Runtime files in this extension require no npm packages. Test tools were isolated outside the extension folder.

The core and service-worker suite passes 13 tests:

- 2,000-record shuffling with no repeats and no immediate round-boundary repeat.
- Credential and signed playback URL exclusion from persisted records.
- URL allowlist validation, caption truncation, safe media IDs and saved-time handling.
- Saved-video filtering, optional image/carousel parsing, media resolution and pagination validation.
- IndexedDB persistence, complete-sync reconciliation and local data clearing.
- A complete 40-page, 2,000-record worker sync, with progress after each page.
- Old records surviving an unexpected second-page response.
- Repeated pagination cursors stopping safely.
- Serialized requests, minimum request spacing and cancellation hooks.
- 429 cooldown escalation, challenge/session blocks, format-change blocks, and zero automatic block retries.
- Save/unsave success and failed mutation cache preservation.
- Untrusted message rejection, new-tab launch and existing-tab focus.
- Settings validation and deletion.

The browser suite runs the actual unpacked Manifest V3 extension in headless Chromium, with generated local media and Instagram JSON responses injected into the service worker's fetch boundary. Page-side media is served by the test harness at allowed Instagram CDN URLs. It verifies extension loading, real runtime messaging and IndexedDB, autoplay of only the active video, a maximum of three media sources, keyboard controls, persistent mute, Unsave with Undo, failed unsaves, changed shuffle on reload, settings, narrow layout, request halts after 429/format/session errors, and local clearing. Large-library checks exercise 2,000 records far into the virtualized feed.

Desktop, narrow-window, settings, empty and rate-limit screenshots were inspected. Test artwork and fake cookies are not shipped in the extension.

## What has not been verified

No authenticated live Instagram account was used. Tests cannot establish that the unofficial routes, application ID, cookie policy or response shapes work for your account today. They also cannot establish the SRS's broadband startup or transition time targets with actual Instagram video files.

## Check in your own browser

1. Install the folder using Load unpacked, log into Instagram in that profile, and click the extension icon. Confirm real saved reels appear and the full refresh finishes.
2. Scroll and use J/K, M and Space. Confirm only the visible video plays; close and reopen the feed to check that the order changes.
3. Unsave one item you are comfortable removing. Verify its saved state in Instagram. Within five seconds, click Undo and confirm it is saved again. A failed request must leave the cache entry intact.
4. In Settings, test autoplay off, your preferred mute state and Slow request pace. Optionally enable photos/carousels and perform a full refresh.
5. If a login, challenge, rate-limit or format message appears, follow the displayed guidance. Do not force repeated refreshes through a block. Inspect your normal Instagram Network traffic and update `lib/instagram.js` if its web interface changed.

## Requirement coverage

| SRS requirements | Implementation |
| --- | --- |
| FR-1 to FR-3 | Toolbar tab launch/focus, authenticated session check, login prompt/link |
| FR-4 to FR-9 | Complete paced pagination, video filtering, metadata, incremental progress, safe reconciliation |
| FR-10 to FR-12 | IndexedDB cache, manual refresh, local-data reset |
| FR-13 to FR-19 | Fisher-Yates rounds, vertical snapping, visibility playback, three-media window, controls, Instagram links |
| FR-20 to FR-21 | In-memory just-in-time media links, one fresh retry, skip and unavailable notice |
| FR-22 to FR-26 | Bookmark control, actual save/unsave adapter, optimistic state, five-second Undo, cache changes after server confirmation |
| FR-27 to FR-28 | Local settings including optional first-slide non-reel posts |
| FR-29 to FR-31 | Position-preserving login prompt, persistent block gate, safe format-change handling |
| NFR-1 to NFR-2 | Cache-first and preloading implemented; real network timing remains unverified |
| NFR-3 to NFR-11 | Bounded media/DOM, pacing and backoff, resilient cache, credential controls, local-only design, modular adapter, accessible controls and live announcements |

The Instagram adapter is complete as code; the SRS's live endpoint discovery (M0) and real-account acceptance remain unverified, as described above.
