---
tags: [feature, content-script, rendering]
related: [[distraction-removal]], [[math-rendering]], [[reader-view]], [[chart-preservation]]
---
# Keeping figures and charts

Modern article pages lose their pictures in four different ways. All four are handled in
`clean.js`; `scripts/fixtures/media-article.html` reproduces each one.

## 1. Our own scrub was deleting them
The junk-token list was a single list, so `<figure class="article-banner">` around the
headline chart matched `banner` and was removed. That is how "it completely strips off any
graphs or important images" happened — the extension did it to itself.

Tokens are now two lists of different strength:

| List | Examples | Rule |
|---|---|---|
| `AD_TOKEN` | `ad`, `adslot`, `sponsored`, `taboola` | always junk, whatever it contains |
| `FURNITURE_TOKEN` | `banner`, `promo`, `share`, `related`, `cookie` | junk **only if it carries no real picture** |

`holdsContentMedia()` decides "real picture": a `<figcaption>`, or an image/chart the live
page rendered at least 200x100. The same guard protects the fixed/sticky **text** signal
from [[distraction-removal]], so a sticky element holding a genuine figure survives.

**Trade-off, accepted:** a large image inside `<div class="promo">` is now kept. Explicit
ad classes are still removed unconditionally, which is where the real ads are.

## 2. Lazy-loaded images kept their placeholder
`cloneNode` copies attributes, not state. An image whose real source arrived by script
still had its 1x1 placeholder in the clone. `inlineLiveMedia()` writes the live
`currentSrc` (or `data-src`/`data-lazy-src` when the image is still a placeholder) into the
clone before Readability sees it, and drops `srcset`/`loading` so the browser cannot
re-pick a placeholder afterwards.

## 3. Canvas charts arrived blank
A cloned `<canvas>` is an empty canvas — the drawing does not clone. `inlineLiveMedia()`
replaces each sizeable canvas with an `<img>` holding its `toDataURL()`. Wrapped in
try/catch: a canvas tainted by cross-origin drawing throws, and is then left alone rather
than breaking extraction.

## 4. Tracking pixels were kept
`dropTrackingPixels()` removes images the live page rendered at 1x1, or that declare
`width`/`height` of 2 or less.

Inline `<svg>` charts already survived Readability; they just needed `max-width: 100%` so
they cannot overflow the column, and block layout when they stand alone in a figure.

## Note on verification
The report that prompted this was `openai.com`, which sits behind a Cloudflare bot
challenge — headless Chrome gets a 403 "Just a moment..." page, so **the fix was never
verified against that specific site**. It is verified against a fixture reproducing each
mechanism. If pictures still go missing somewhere, the useful thing to capture is the
markup around the missing figure, not the URL.
