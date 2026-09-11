---
tags: [architecture, content-script]
related: [[message-contract]], [[running-the-extension]], [[store-packaging]]
---
# Content script lifecycle

Manifest content scripts are injected when a page **loads**. Nothing re-injects them
afterwards. That single fact causes the most confusing failure this extension has:

> Reloading the extension — every rebuild in development, and every Web Store
> auto-update for a real user — destroys the content script in tabs that are already
> open. Chrome does not put it back.

The popup then gets `Could not establish connection. Receiving end does not exist.` from
`tabs.sendMessage` and, before this was handled, reported **"CleanRead can't run on this
page."** — blaming the page for a tab that only needed re-injecting. Reloading the tab
fixed it, which made the bug look random.

## Two layers of repair

1. **`reinjectOpenTabs()` in the service worker**, on `runtime.onInstalled` (both
   `install` and `update`). Queries every `http`/`https` tab and injects the content
   script. This is the main fix: an update becomes invisible.
2. **Lazy recovery in the popup** (`sendToTab` in `src/popup/App.jsx`). A failed message
   is not proof the page is unsupported — inject, wait for the listener, send again. This
   covers tabs the worker missed, such as one that was discarded while asleep.

Both read the script filenames from `runtime.getManifest().content_scripts[0].js`, because
the built filenames are content-hashed.

The injected loader imports its module asynchronously, so `executeScript` resolving does
**not** mean the listener is registered. The popup polls `GET_STATE` until it answers.

## One listener per frame

A tab can receive both the manifest injection and a recovery injection. `content.js`
guards with `window.__cleanReadListening` before calling `onMessage.addListener`, or the
tab would answer every message twice. That `window` is the isolated world's, so the flag
is invisible to the page — asserted in the smoke test.

## Why `host_permissions` had to be added

`scripting.executeScript` needs host access. `activeTab` grants it only when the user
invokes the action from the toolbar, which neither the service worker nor a test harness
can do — the call fails with *"Cannot access contents of the page."*

`host_permissions: ["http://*/*", "https://*/*"]` was therefore added. It matches the
`content_scripts` matches we already declare, so the install-time warning the user sees is
unchanged. See [[store-packaging]] for the justification text.

## Pages where it genuinely cannot run

`chrome://`, `about:`, the Chrome Web Store, and the built-in PDF viewer bar content
scripts outright. Injection fails there too, so the honest "can't run on this page"
message survives for the cases that deserve it.
