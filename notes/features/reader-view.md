---
tags: [feature, content-script, reader]
related: [[reader-overlay-vs-dom-rewrite]], [[shadow-dom-isolation]], [[distraction-removal]], [[math-rendering]], [[media-preservation]], [[table-of-contents]], [[paragraph-highlighting]], [[message-contract]], [[storage-layers]], [[running-the-extension]]
---
# Reader view

Covers the core flow plus the reading controls: **extraction → junk scrub → clean article
→ font/spacing/theme**. Verified running in real Chrome — see [[running-the-extension]].

### Where it lives
- `src/content-scripts/clean.js` — extraction, junk scrub, overlay render/remove, settings
- `src/content-scripts/reader.css` — styles, loaded as a string into the shadow root
- `src/content-scripts/content.js` — message listener only
- `src/popup/App.jsx` — the controls
- `src/lib/reading-time.js` — word count ÷ 200 wpm, floored at 1 min

### Pipeline
1. `extractArticle()` runs Readability against `document.cloneNode(true)` (Readability
   mutates the document it is handed).
2. `scrubJunk()` re-parses the extracted HTML with `DOMParser` (never executes scripts)
   and drops leftover furniture — see below.
3. Reading time is computed **after** the scrub, so ad text does not inflate it.
4. `renderReader()` paints into a shadow root — strategy in
   [[reader-overlay-vs-dom-rewrite]], isolation rationale in [[shadow-dom-isolation]].
5. The contents rail is built from the same pass — see [[table-of-contents]].

### Why the scrub step exists
Full detail, and the three signals it uses, now live in [[distraction-removal]].

<!-- kept short here on purpose -->
Readability scores for prose and **keeps short promo blocks that sit inside the article**.
A `<div class="ad">ADVERTISEMENT — …</div>` between two paragraphs survived extraction and
rendered in the reader view. `scrubJunk()` removes an element when a hyphen/underscore
token of its class or id matches a junk word (`ad`, `promo`, `sponsored`, `newsletter`,
`related`, `share`, `comments`, `cookie`, `outbrain`, `taboola`, …), or when a block under
200 chars opens with "Advertisement"/"Sponsored"/"Promoted".

Token matching, not substring: `header-ad` is junk, `badge` is not.

**Accepted risk:** an article genuinely about advertising with a class like `ad-analysis`
would lose that block. Tokens are conservative, but this is the trade-off if a false
negative ever shows up.

### Live styling
`applySettings()` sets custom properties on the host element (`--cr-font-size`,
`--cr-line-height`, `--cr-width`) plus `data-theme`. They inherit through the shadow
boundary, so moving a slider repaints instantly with no re-parse. Persisted via
[[storage-layers]].

### Known gaps
- No in-page toolbar — controls are popup-only, so the popup must be reopened to adjust.
- `currentArticle` is module state in the content script; it resets on navigation.
- Readability only strips a site-name suffix on its own separators (`|`, `-`, `/`, `>`, `»`).
  A title like `Article — Site Name` keeps the suffix. Cosmetic; Readability's own
  behaviour, left alone per CLAUDE.md ("don't reinvent this").
