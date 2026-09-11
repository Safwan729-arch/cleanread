---
tags: [feature, content-script, rendering]
related: [[reader-view]], [[distraction-removal]], [[markdown-export]], [[pdf-export]]
---
# Maths rendering

Wikipedia, arXiv mirrors and most maths-heavy sites ship equations as **SVG images**, not
text. Handling them takes one step at extraction time (`tagMath` in `clean.js`) and a set
of rules in `reader.css`.

## Why tagging is needed at all
`stripClasses()` removes the site's classes after the scrub. But the class is the *only*
thing that says an SVG is an equation rather than a photograph — `mwe-math-fallback-image-inline`,
`katex`, `mjx-container`. Once it is gone, an equation is just an image.

So `tagMath()` runs **between the scrub and the strip**, and records what we need as our
own attribute:

```
data-cr-math="inline"    keep it in the line of text
data-cr-math="display"   give it a line of its own
```

It also drops `aria-hidden`. MediaWiki hides the SVG because it ships an accessible MathML
twin, but that twin is `display:none` so Readability discards it — leaving maths that no
screen reader could reach. The SVG's `alt` holds the LaTeX, so un-hiding it restores
something readable.

## The bug this fixed
`reader.css` forced **every** image to `display:block; margin:1.5em auto`. On the
Navier–Stokes article that put all 245 equations on their own centred line, so a sentence
read:

> to be the sum of a viscosity term
> *τ*
> (the deviatoric stress) and a pressure term

The root cause was not maths-specific: the stylesheet assumed every image is a photograph.
Images are now **inline by default**, and only become block figures when they genuinely
stand alone (`figure > img`, `p > img:only-child`, …). That fixed inline icons and glyphs
on every other site at the same time. On the real article, block images fell from 245 to 69.

## Dark mode
Maths SVGs are black glyphs on transparency — invisible on a dark background, which is the
other half of what made them "not visible properly". In the dark theme they get
`filter: invert(0.92) hue-rotate(180deg)`; `@media print` resets it, because paper is white
even when reading in dark mode.

## Alignment
`vertical-align: middle`, chosen by comparing it against a fixed `-0.28em` offset on the
real article. MediaWiki puts the exact baseline offset in an inline `style`, but Readability
strips `style` attributes, so that information is gone before we see it. `middle` handles
both a small σ and a tall D/Dt fraction sensibly.

## Across the other surfaces
- **Markdown** — a Turndown rule turns maths into LaTeX: `$…$` inline, `$$…$$` for display,
  unwrapping MediaWiki's `{\displaystyle …}`. Obsidian typesets it. Without this it would
  export as `![{\displaystyle …}](…svg)`, an image of an equation.
- **PDF / print** — `export-pdf.js` carries its own stylesheet and had the same
  block-image trap; it now has matching maths rules.

## Known gaps
- Inline maths keeps its intrinsic pixel size, so it can look slightly small next to an
  18px reading font — the SVG was sized for Wikipedia's 14px body text.
- If a site renders maths as plain text or fonts rather than images, none of this applies
  (nothing to do — it already flows as text).
- MathML that a site exposes *visibly* is tagged but not restyled beyond display/inline.
