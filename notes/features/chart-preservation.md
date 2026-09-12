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

## Toggles are recorded, not replicated

Many charts sit behind tabs or a `<select>` ("API cost", "Output tokens", …).
A static reading view cannot re-run the site's charting code, so it cannot switch
between them. Rather than present one series as if it were the whole picture,
`chartOptions` reads the labels and the reader prints a line under the chart:

> Shown: API Cost. The original page also offered Output tokens, GPT‑6 Astra, … —
> open it to switch between them.

## Limits worth knowing
- Only charts **mounted at the moment you clean** are captured. A page that
  mounts charts as you scroll will yield 9 one time and 10 the next; scrolling
  through the article first captures more.
- A chart drawn to `<canvas>` goes through the canvas path in
  [[media-preservation]] instead, and a cross-origin-tainted canvas still cannot
  be read.
- Markdown export has no representation for an inline SVG, so charts do not
  appear there. The print path keeps them.

Covered by `scripts/fixtures/chart-article.html`, which reproduces the
`scroll-*` wrapper, CSS-only paint, switches, a dark page and a decorative icon.
