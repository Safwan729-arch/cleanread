---
tags: [architecture, testing, chrome]
related: [[build-pipeline]], [[message-contract]], [[reader-view]]
---
# Running the extension for real

`npm run smoke:chrome` (after `npm run build`) loads the built extension from `dist/` into
real Chrome and drives the core flow. Script: `scripts/smoke-chrome.mjs`,
fixtures: `scripts/fixtures/messy-article.html` (the full flow) and `short-article.html`
(too few headings for a contents rail). Screenshots land in
`node_modules/.cache/cleanread-smoke-shots/`.

It drives the real [[message-contract]] from the extension's own service worker —
not by importing internals — so a pass means the wiring genuinely works.

## Four traps, each of which silently produces "nothing happens"

**1. `--load-extension` no longer works.** Chrome 137+ removed the switch. It still
appears in `chrome://version`'s command line, and Chrome ignores it — no error, the
extension is simply absent from `chrome://extensions-internals`. Use CDP instead:

```js
const cdp = await ctx.browser().newBrowserCDPSession()
const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXT })
```

It needs `--enable-unsafe-extension-debugging`. `--disable-features=DisableLoadExtensionCommandLineSwitch`
does **not** bring the old switch back — verified on Chrome 152.

**2. `Extensions.loadUnpacked` rejects backslash paths.** `D:\...\dist\chrome` fails
with "File path cannot be resolved"; `D:/.../dist` works. On Windows, always
`.replace(/\\/g, '/')`.

**3. Playwright disables extensions by default.** Its default args include
`--disable-extensions`, which blocks the install even though `loadUnpacked` returns an
id. Pass `ignoreDefaultArgs: ['--disable-extensions']`. This was the cause of the
longest dead end — CDP reports success while Chrome has no record of the extension.

**4. Do not grab the first `serviceworker` event.** Chrome runs its own component
extensions (Hangouts, Network Speech) whose workers can register first. Sending from
the wrong worker fails with "Could not establish connection. Receiving end does not
exist." — which reads exactly like a broken content script. Poll
`ctx.serviceWorkers()` for the one whose URL host matches your loaded id.

## Reading the results

Content lives inside a shadow root ([[shadow-dom-isolation]]), so assert against
`#cleanread-root .cr-surface` — Playwright's CSS engine pierces open shadow roots.
`innerText` returns *rendered* text, so `.cr-meta`'s `text-transform: uppercase` makes
it "1 MIN READ"; match case-insensitively.

## Scope

Chrome only — see [[firefox-deferred]].
