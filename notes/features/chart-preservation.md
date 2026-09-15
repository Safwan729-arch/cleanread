---
tags: [feature, content-script, rendering]
related: [[media-preservation]], [[distraction-removal]], [[reader-view]], [[shadow-dom-isolation]]
---
# Keeping SVG charts

[[media-preservation]] covers pictures. This covers the other kind of graphic: a
chart drawn as inline `<svg>` by Vega, D3, Recharts, visx or Highcharts. Those
disappear for entirely different reasons, and on a page full of them the reader
showed captions describing graphs that were not there.

Measured on a live article with 12 charts: **0 survived** before, **12 of 12** after.

## Why they vanished

**Readability's negative class weight.** `_getClassWeight` subtracts 25 when a
class or id matches its negative list, which contains the bare substrings
`scroll`, `media`, `share`, `promo`, `related` and `banner`. A Tailwind
scroll-margin utility — `scroll-mt-anchor-offset` — is enough. The node is then
dropped by `weight + contentScore < 0` before anything looks at what it holds.
That list was written for 2010 markup; utility-class frameworks collide with it
constantly.

**`input > Math.floor(p / 3)`.** A chart container has form controls and no
paragraphs, so a chart *with switches* deletes itself.

**Readability has no notion of `svg`.** It counts `img`, `embed`, `object` and
`iframe` when deciding whether a container is empty, so a div holding nothing but
a chart scores as empty.

## The three fixes

1. **Stand in for the chart.** Every inline `<svg>` the live page renders at
   200x100 or larger is swapped for an `<img>` placeholder carrying the real
   dimensions, so Readability sees media instead of an empty div. The real SVG
   goes back after extraction (`restoreCharts`).
2. **Unweight the wrapper.** `class` and `id` are removed from the ancestry
   between the chart and its figure, and the chart's now-inert controls are
   removed. Narrow on purpose: only ancestors of a confirmed, content-sized
   chart, never the page at large.
3. **Freeze the paint.** Chart libraries colour marks from a stylesheet, often
   through CSS custom properties. The shadow root cannot see the page's CSS
   ([[shadow-dom-isolation]]) and `stripClasses` removes the hooks anyway, so
   `freezeSvgPaint` writes the computed fill, stroke, font and opacity onto every
   node as inline style before extraction.

Icons are left alone — below the size threshold, they are not charts.

## Light ink on a light page

The first version passed every count and still looked broken: the marks were
there and the axis labels were invisible. The page was dark, so the computed
text fill was white, and white text was frozen onto the reader's pale surface.
Only the screenshot showed it.

Walking up for a background colour does not work — chart containers stack
translucent overlays, so the nearest painted ancestor was `oklab(0 0 0 / 0.2)`,
a veil rather than a surface. The decision is made from the chart's **own ink**
instead: median lightness of its `text` fills above 0.55 means it was drawn for a
dark background, so it keeps a dark panel of its own. `lightnessOf` parses
`rgb`, `rgba`, hex and `oklab`/`oklch`, because sites author in all of them.

## Charts hidden behind switches

Many charts show one series at a time and put the rest behind tabs or a
`<select>` ("API cost", "Output tokens", …). Those views exist only after a
click, so extraction never saw them — the reader kept one view out of three.

The reader cannot re-run the site's charting code, so the views are **captured
while the page is still live**: `captureChartVariants()` runs before the clone is
taken, works each chart's own switches, and photographs every result. The reader
then rebuilds them as a group with its own tab bar, wired by
`attachChartToggles()` (delegated, because the article arrives as an HTML string
and no listener survives that). The saved-article page wires the same markup.

On the live article that prompted this: **7 charts switchable, 2–3 distinct views
each, all genuinely different data.** Extraction cost ~1.7s.

Safeguards, because this drives someone's live page:
- only controls **inside the chart's own figure**, and only `[role=tab]`, a
  `<select>`, or plain buttons — a label matching `download|share|close|play|…`
  is never clicked
- the original selection is restored afterwards, so the page is left as found
- bounded: 8 charts, 6 views each, a 6s total budget; a chart that will not be
  driven costs a moment and never the article
- a view whose shape is identical to one already captured is discarded

Where only one view can be captured, the old behaviour stands: the reader names
the others rather than passing one series off as the whole picture.

### Photograph it after it settles, not when it moves
The first version captured on the first change and caught charts mid-flight,
with legend labels printed on top of each other. Redraws are staged — marks
first, legend afterwards. `waitForRedraw` now waits for the shape to change and
then to *stop* changing (two identical readings). The fingerprint had to include
`x`/`y` and `transform` as well as geometry, or a legend settling into place was
invisible to it.

### Markdown says what it cannot draw
Turndown keeps unknown elements' text, so an SVG chart spilled every axis tick
and series name into the prose as `70%API CostGPT-6` — from the hidden views as
well as the visible one. Charts now export as `*[Chart: <label>]*`, with one line
naming the views; decorative icons export as nothing.

## Limits worth knowing
- Only charts **mounted at the moment you clean** can be captured — but
  extraction now scrolls the page through first to make them mount, so this is
  no longer something the reader has to do by hand (see the last section).
- A chart drawn to `<canvas>` goes through the canvas path in
  [[media-preservation]] instead, and a cross-origin-tainted canvas still cannot
  be read.
- Markdown export has no representation for an inline SVG, so charts do not
  appear there. The print path keeps them.

Covered by `scripts/fixtures/chart-article.html`, which reproduces the
`scroll-*` wrapper, CSS-only paint, switches, a dark page and a decorative icon.

## A figure that was never built cannot be rescued

Everything above assumes the chart exists when extraction runs. On a long
article it usually does not: figures are mounted as you scroll past them, so
opening a page and clicking Clean straight away finds almost nothing.

Measured on the live article, without touching the scroll wheel:

| | charts mounted | reader charts | switchable |
|---|---|---|---|
| after scrolling through | 10 | 24 | 7 |
| open, then Clean | **1** | 4 | **1** |

That is the whole bug: nine of ten charts had never been created, so there was
nothing to photograph and no switches to rebuild. `mountLazyContent()` now
scrolls the page through once before anything is measured or cloned, then puts
the scroll position back. Bounded to 2.5s, because an infinite-scroll page would
otherwise keep going forever.

With it, opening the page and cleaning immediately gives the same 24 charts and
7 switchable groups as scrolling by hand first.

The fixture covers this: its last chart mounts on an `IntersectionObserver`
1800px down the page, and the smoke test never scrolls.
