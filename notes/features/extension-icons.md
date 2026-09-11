---
tags: [feature, branding, packaging]
related: [[build-pipeline]], [[running-the-extension]]
---
# Extension icons

`npm run icons` regenerates `public/icons/{16,32,48,128}.png` from the single SVG
definition in `scripts/generate-icons.mjs`. **Edit the SVG there, never the PNGs** — they
are build output that happens to be committed.

Rendered through headless Chrome (already a dev dependency for the smoke test) so the
rounded corners and bar edges get real antialiasing at every size.

### The mark
An ink tile (`#17171b`) holding an accent-blue title bar (`#5b9bff`) and two cream body
lines (`#fbfaf8`) — an article reduced to what CleanRead leaves behind. Only three shapes,
because anything busier turns to mud at 16px.

### Wiring
Declared twice in `manifest.json`: `icons` (store listing, extensions page) and
`action.default_icon` (toolbar button). Both point at `icons/*.png`.

Vite copies `public/` to the output root, so the paths need no build-time rewriting and
CRXJS passes them through unchanged — verified in `dist/manifest.json`.

The smoke test asserts all four sizes are declared and that each file actually loads from
the extension origin, so a broken path fails loudly rather than showing a blank toolbar
square — see [[running-the-extension]].
