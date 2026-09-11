---
tags: [decision, content-script]
related: [[reader-view]], [[shadow-dom-isolation]], [[message-contract]]
---
# Overlay instead of rewriting the page

**Decision:** render the clean article into a fixed, full-viewport `#cleanread-root`
painted above the host page. Do not strip/rewrite the page's own DOM in place.

**Why:**
- **Restoring is free.** "Restore original page" is `root.remove()` plus undoing a handful
  of inline styles. An in-place rewrite would need a full DOM snapshot to reverse.
- **Readability never touches the live document.** We parse `document.cloneNode(true)`,
  because `new Readability(doc).parse()` mutates the document it is given.
- **Fewer fights with the host page.** Framework re-renders and lazy-loaders that would
  undo our deletions can't reach inside the overlay.

**What the overlay still has to handle:** `position: fixed` / `sticky` elements (cookie
bars, sticky nav, newsletter popups) can paint above it. `neutraliseOverlays()` hides them
and records their previous `display` so restore puts them back. We also pause playing
`<video>`/`<audio>` and lock `documentElement` scrolling.

**What the overlay did NOT solve on its own:** host page CSS still reached our elements,
because pages style bare `article`/`h1`/`p` by tag name. Scoping our selectors protected
the page from us, not us from the page. Fixed by moving the view into a shadow root —
see [[shadow-dom-isolation]].

**Cost accepted:** `z-index: 2147483647` is a blunt instrument, and a page that also uses
the max z-index could tie. Not seen in practice; revisit only if it shows up.

Related: CSP blocks injection outright on a small percentage of sites. Per CLAUDE.md that
is expected, not a bug to chase.
