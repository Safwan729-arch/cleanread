---
tags: [architecture, messaging]
related: [[reader-view]], [[build-pipeline]]
---
# Message contract

Types are defined once in `src/lib/messages.js` (`MSG`). The popup sends, the content
script answers. Nothing else participates yet.

| Message | Sent by | Returns |
|---|---|---|
| `GET_STATE` | popup on open | `{ active, readerable, article }` |
| `GET_ARTICLE` | popup, to save the page | `{ ok, article }` — extracts on demand if not cleaned |
| `CLEAN_PAGE` | popup | `{ ok: true, title, readingTimeMinutes }` or `{ ok: false, reason: 'no-article' }` |
| `RESTORE_PAGE` | popup | `{ ok: true }` |
| `APPLY_SETTINGS` | popup on any control change | `{ ok: true }` |

And one pair going the other way, **content script → background**, because only the
worker may touch IndexedDB (see [[paragraph-highlighting]]):

| Message | Sent by | Returns |
|---|---|---|
| `GET_HIGHLIGHTS` | content script on render | `{ ok: true, hashes }` |
| `SET_HIGHLIGHTS` | content script on every toggle | `{ ok: true, hashes }` |

**Gotcha:** a missing background listener does not throw here — if the wrong bundle is
running as the worker it answers `null`. See [[entry-filenames-must-differ]].

The listener lives in `src/content-scripts/content.js`; the work it delegates to is in
`src/content-scripts/clean.js`.

**Gotcha:** `browser.tabs.sendMessage` *throws* when no content script is present
(`chrome://`, `about:`, the web stores, and PDF viewer tabs). The popup wraps every send
in `sendToTab()` which catches this and returns `{ ok: false, reason: 'no-content-script' }`.
Never call `sendMessage` bare from the popup.
