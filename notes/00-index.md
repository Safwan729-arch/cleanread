---
tags: [moc]
---
# CleanRead — Map of Content

Start here every session. Follow links out; don't scan `/src` or `/notes` wholesale.
Project rules (stack, conventions, feature status) live in `CLAUDE.md` — not duplicated here.

## Architecture
- [[build-pipeline]] — Vite + CRXJS, one codebase → two browser targets
- [[running-the-extension]] — `npm run smoke:chrome`; the four traps that make a load silently fail
- [[message-contract]] — how popup and content script talk
- [[content-script-lifecycle]] — why an extension reload orphans open tabs, and the two repairs
- [[storage-layers]] — which data goes to `storage.local` vs Dexie

## Decisions
- [[reader-overlay-vs-dom-rewrite]] — why we paint an overlay instead of rewriting the page
- [[shadow-dom-isolation]] — why the reader view lives in a shadow root
- [[firefox-deferred]] — why Chrome only, and exactly what a future Firefox port costs
- [[entry-filenames-must-differ]] — two entries named `index.js` silently broke the worker
- [[vault-at-repo-root]] — why the Obsidian vault root is the repo root

## Features
- [[reader-view]] — extraction, clean article, reading controls *(verified in Chrome)*
- [[distraction-removal]] — the three signals that decide what is junk
- [[math-rendering]] — equations as images: keeping them inline, legible and exportable
- [[media-preservation]] — why figures and charts went missing, and the four fixes
- [[chart-preservation]] — SVG charts: why Readability deletes them, and the three fixes
- [[embed-preservation]] — video embeds: Readability keeps five hosts and deletes the rest
- [[table-of-contents]] — the contents rail: auto-generated, auto-hidden, scroll-spied
- [[paragraph-highlighting]] — click to highlight; why the worker owns the storage
- [[save-article]] — the reading list and the offline saved-article page
- [[markdown-export]] — Turndown output, and why there is no `downloads` permission
- [[pdf-export]] — print vs rasterised PDF, and the clipping guard
- [[store-packaging]] — `npm run package`, permission justifications, listing assets
- [[extension-icons]] — the mark, and `npm run icons` to regenerate it

Every feature on the CLAUDE.md list is built and verified in Chrome.

## Sessions
- [[2026-09-11]] — scaffold, then verified in real Chrome; two bugs found and fixed
- [[2026-09-12]] — maths, media, the orphaned-tab fix, and SVG charts
- [[2026-09-15]] — video embeds: Readability deletes every player it does not recognise
