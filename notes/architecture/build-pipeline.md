---
tags: [architecture, build]
related: [[running-the-extension]], [[firefox-deferred]], [[00-index]]
---
# Build pipeline

Chrome only, Manifest V3. Entry point is `vite.config.js`.

- `manifest.json` (repo root) is the **single source of truth**, written in Chrome shape
  and handed to CRXJS unmodified — no per-target transform any more, see [[firefox-deferred]].
- Output goes to `dist/`, which is what you load as an unpacked extension.

```
npm run dev            # HMR
npm run build          # production build -> dist/
npm run smoke:chrome   # load dist/ in real Chrome and drive it -- see [[running-the-extension]]
npm run icons          # regenerate public/icons/* -- see [[extension-icons]]
npm run package        # build + validate + zip for the store -- see [[store-packaging]]
npm run shots:store    # 1280x800 listing screenshots
```

CRXJS handles on its own, so don't hand-roll it:
- hashing/emitting the content script and its JS chunks
- `web_accessible_resources` for modules the content script dynamically imports
- the `service-worker-loader.js` shim

Vite copies `public/` to the output root, so `public/icons/*` lands at `dist/icons/*` and
the manifest's `icons/16.png` paths need no rewriting.

Note `content_scripts[].css` is **absent** from the built manifest, and that is correct:
the reader stylesheet is imported as a string and injected into a shadow root instead —
see [[shadow-dom-isolation]].
