---
tags: [decision, build, scope, firefox]
related: [[build-pipeline]], [[running-the-extension]]
---
# Firefox is deferred (2026-09-11)

**Decision:** ship Chrome only. The dual-target build was removed — one target, output to
`dist/`. Firefox may be revisited later.

**Why:** it was carrying cost with no payoff. The Firefox target could never be verified
here (Firefox isn't installed), so it shipped as build-verified-only guesswork, and it
required a second build script, an env var, `cross-env`, and a manifest transform — all to
produce an artifact nobody could run.

## What keeps the door open

Source code is **unchanged** and stays browser-agnostic. Every extension API call goes
through `browser.*` via `webextension-polyfill` (`src/lib/browser.js`), which was kept
deliberately. The two builds were *byte-identical in code* — verified by md5 across every
JS/CSS/PNG file. The only difference was three manifest keys. So the port is a build-config
change, not a rewrite.

## Exactly what to restore

1. **Gecko id** — Firefox refuses to install without it; Chrome ignores the key:
   ```json
   "browser_specific_settings": { "gecko": { "id": "cleanread@cleanread.app", "strict_min_version": "128.0" } }
   ```
2. **Background shape** — Firefox MV3 has no extension service workers; it uses a
   non-persistent event page:
   ```js
   manifest.background = { scripts: [chromeManifest.background.service_worker], type: 'module' }
   ```
3. **Re-add the target switch** in `vite.config.js` (a `BROWSER` env var and per-target
   `outDir`), plus `cross-env` for Windows.

### The trap that will bite again
**CRXJS does not convert between the two background shapes.** Verified by reading its
2.7.1 source — `renderCrxManifest` does:

```js
const worker = browser === 'firefox'
  ? manifest.background?.scripts[0]      // not optional-chained past .scripts
  : manifest.background?.service_worker
```

Handing CRXJS a Chrome-shaped manifest with `browser: 'firefox'` throws a TypeError at
build time, because `scripts` is `undefined`. Step 2 above is mandatory, not cosmetic.

### And it still won't be verified
Chrome cannot stand in for Firefox. Loading the Firefox build in Chrome installs an empty
shell — Chrome reports no error and no `disable_reasons`, but the background never starts,
because Chrome MV3 only understands `service_worker`. The Firefox-specific part is exactly
the part Chrome won't run. Real verification needs stock Firefox driven by `web-ext run`
(Playwright's Firefox is a patched build that can't load extensions this way).
`npx web-ext lint` can check AMO packaging rules without Firefox installed.
