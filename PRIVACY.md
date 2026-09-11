# CleanRead — Privacy Policy

_Last updated: 12 September 2026_

**CleanRead does not collect, transmit, or sell any data.**

The extension has no server, no analytics, and no telemetry. It makes no network requests
of its own. Everything it stores stays on the device, in the browser's own storage for the
extension.

## What is stored, and where

| Data | Where | Why |
|---|---|---|
| Reading preferences — theme, font size, line spacing, column width | `chrome.storage.local` on your device | So the reader looks the way you left it |
| Articles you explicitly save | IndexedDB on your device | So you can read them later, offline |
| Paragraphs you highlight, keyed by page address | IndexedDB on your device | So highlights are still there when you return |

Nothing is written unless you act: an article is stored only when you choose "Save for
later", and a highlight only when you click a paragraph.

## What is not stored

CleanRead does not record your browsing history. It reads the page you are on **only**
while you are using it — when you open the popup or ask it to clean, save, or export the
current page — and it does not keep a record of pages you merely visit.

## Permissions, and why each exists

- **`storage`** — to keep your reading preferences and saved articles on your device.
- **`activeTab`** — to read the current tab's address and content when you open the popup,
  so it can clean, save, or export that page. It grants access only to the tab you are on,
  only while you are using the extension, and it is not persistent.

CleanRead declares no host permissions and loads no remote code; all of its code ships
inside the extension package.

## Removing your data

Uninstalling CleanRead deletes everything it stored. You can also remove individual saved
articles from the reading list in the popup, and clear a highlight by clicking the
highlighted paragraph again.

## Third parties

None. No data is shared with anyone, because none leaves your device.

## Contact

Questions about this policy can be raised on the project's issue tracker.
