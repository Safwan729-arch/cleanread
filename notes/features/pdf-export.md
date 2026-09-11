---
tags: [feature, export]
related: [[markdown-export]], [[save-article]], [[reader-view]], [[math-rendering]]
---
# PDF export

`src/lib/export-pdf.js` renders the cleaned article with html2pdf.js (html2canvas +
jsPDF). Available from the popup and the saved-article page, same as [[markdown-export]].

## Two paths, and which one to prefer

**Print (recommended).** "Print / Save as PDF" in the popup, "Print" on the saved-article
page. Goes through Chrome's own print pipeline, so **text stays text**. Measured on the
same article: **61KB with embedded fonts**, against 615KB as a flat image. Selectable,
searchable, and readable by a screen reader.

**Download PDF (html2pdf.js).** One click to a file with no print dialog — but html2canvas
**rasterises** the DOM, so the PDF is a picture of the article. Not selectable, not
searchable, invisible to screen readers, ~10x the size, and ~900KB of library.

Both ship. The rasterised path is what CLAUDE.md's stack table specifies, and it is the
only one that produces a file without a dialog; the print path is the one to point people
at. If html2pdf is ever dropped, `exportPdf()` is one function behind one button, and the
900KB chunk goes with it.

## How print is made to work
The reader is a `position: fixed` overlay over the host page, which otherwise prints as a
single clipped page with the site showing beneath it. Two fixes, both needed:

- a stylesheet injected into `document.head` hides every sibling of the host
- the host's own layout properties are swapped **in JS** on `beforeprint` and restored on
  `afterprint`. A stylesheet cannot do this: inline `!important` outranks any stylesheet.
  Only the layout properties are touched — the theme custom properties live on that same
  inline style and must survive.

Inside the shadow root, `@media print` drops the contents rail and the action buttons,
forces the light palette even when reading in dark mode, lets the surface flow instead of
scroll, avoids breaking after a heading or inside a figure, and keeps highlight
backgrounds via `print-color-adjust: exact`.

## The clipping bug, and the guard against it
First working version cut the right edge off every line. The tell was the title not
wrapping — it rendered as one long line and the overflow fell off the page.

Cause: the render container was parked off-screen at `left:-1520px`, and html2canvas then
measured against the **browser window** rather than the 760px column, producing an image
wider than A4.

Fix, both halves needed:
- position the container at `0,0` with `opacity:0` instead of a negative offset
- pass `width` and `windowWidth` (plus `scrollX/scrollY: 0`) to html2canvas

Page count does not catch this, so the smoke test asserts the **embedded image width** is
exactly `RENDER_WIDTH x scale` = 1520. A window-width capture is far wider, so a
regression fails loudly.

## Settings
A4 portrait, 14/12/16/12mm margins, JPEG q0.95 at scale 2, and `pagebreak.avoid` for
`img`, `figure`, `blockquote`, `pre`, `h2`, `h3` so a heading is never orphaned from its
section or an image sliced in half.

## Known gaps
- Cross-origin images need permissive CORS headers even with `useCORS`; images that refuse
  will come out blank rather than failing the export.
- No page numbers, header or footer.
- Rendering a long article is slow and blocks the page it runs in — acceptable in the
  reader tab, less so in the popup, which the user can close mid-render and abort it.
  The print path has neither problem.
