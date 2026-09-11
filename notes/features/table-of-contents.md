---
tags: [feature, content-script, reader]
related: [[reader-view]], [[shadow-dom-isolation]], [[running-the-extension]]
---
# Table of contents

A contents rail inside the reader view, built from the article's own `h2`/`h3`.
Lives in `src/content-scripts/clean.js` (`buildToc`, `renderToc`) with styles at the
bottom of `reader.css`. Verified in Chrome — see [[running-the-extension]].

### Where it lives, and why there
Inside the reader's shadow root, not the popup. The popup closes the moment you click
anything, which makes it useless for navigation, and CLAUDE.md keeps content scripts as
pure DOM — so the rail is built with `document.createElement`, no React.

### How it is built
`buildToc()` runs **after** `scrubJunk()`, so headings inside removed junk never reach the
rail. It assigns each heading a slug id (`cr-what-the-numbers-miss`), de-duplicating with a
numeric suffix, and returns `[{ id, text, level }]` on the article object. Ids only need to
be unique within the shadow root, so they can never collide with the host page.

### Behaviour
- **Auto-hides below 3 headings** (`TOC_MIN_HEADINGS`). One or two headings is a label, not
  a structure; the rail would be furniture asking to be read before the article.
- **Hidden under 1180px** viewport width, where it would crowd the column it serves.
- **Collapsible** via the toggle in its header — session-only, not persisted.
- **Scroll spy** marks the last heading scrolled past, throttled with `requestAnimationFrame`.
- `h3` entries indent one level under their `h2`.

### Two bugs the browser found that the code could not
1. **The tail sections were unreachable.** The active marker is "last heading above an
   80px cutoff", but the final headings never reach that cutoff — the container runs out of
   scroll first. Clicking the last entry left an earlier one marked. Fixed by treating
   "scrolled to the bottom" as activating the last entry, guarded so it doesn't fire on
   articles short enough not to scroll at all.
2. **The marker went stale after a reflow.** Changing font size or column width moves every
   heading, but nothing re-ran the spy — the rail kept pointing at whatever section was
   active before. `applySettings()` now re-syncs on the next animation frame.

The smoke test asserts the *invariant* for the second one (active heading is above the
cutoff, the next is below) rather than a fixed title, so it stays honest if the fixture changes.

### Known gaps
- No keyboard navigation within the rail beyond native link tabbing.
- Collapse state resets on every clean; it is not in [[storage-layers]].
- `h4` and deeper are ignored — two levels is all the rail can show without becoming a map.
