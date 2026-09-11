/**
 * Cleaned article -> PDF, via html2pdf.js (html2canvas + jsPDF).
 *
 * TRADE-OFF, known and accepted: html2canvas *rasterises* the DOM, so the text
 * in the PDF is an image -- not selectable, not searchable, and heavier than it
 * needs to be. `window.print()` would produce real text and real pagination.
 * html2pdf.js is the stack CLAUDE.md specifies; see notes/features/pdf-export.md.
 *
 * The library is ~500KB, so it is imported dynamically and only lands in the
 * bundle when someone actually exports.
 */
import { slugifyTitle } from './export-markdown.js'

/** Rendered at a fixed width so the PDF does not depend on the window size. */
const RENDER_WIDTH = 760

const PRINT_CSS = `
.crpdf { width: ${RENDER_WIDTH}px; box-sizing: border-box; padding: 8px 0;
  background: #fff; color: #14140f;
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 16px; line-height: 1.58; }
.crpdf h1 { font-size: 1.85em; line-height: 1.2; margin: 0 0 10px; }
.crpdf .crpdf-meta { margin: 0 0 22px; font-size: 0.75em; letter-spacing: 0.03em;
  text-transform: uppercase; color: #6b6b66;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  border-bottom: 1px solid #e3e0da; padding-bottom: 14px; }
.crpdf p { margin: 0 0 1.1em; }
.crpdf h2, .crpdf h3, .crpdf h4 { line-height: 1.25; margin: 1.5em 0 0.45em; }
.crpdf h2 { font-size: 1.35em; }
.crpdf h3 { font-size: 1.15em; }
.crpdf a { color: #14140f; text-decoration: underline; }
.crpdf img, .crpdf svg { max-width: 100%; height: auto; }
.crpdf figure > svg { display: block; margin: 1.2em auto; }
.crpdf figure, .crpdf p > img:only-child:not([data-cr-math="inline"]) { display: block; margin: 1.2em auto; }
.crpdf [data-cr-math="inline"] { display: inline-block; vertical-align: -0.28em; margin: 0 0.12em; }
.crpdf [data-cr-math="display"] { display: block; margin: 1.1em auto; }
.crpdf figcaption { font-size: 0.78em; color: #6b6b66; text-align: center;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.crpdf blockquote { margin: 1.3em 0; padding-left: 1em; border-left: 3px solid #d9d5cc;
  color: #4c4c46; font-style: italic; }
.crpdf pre { background: #f2f1ec; padding: 12px 14px; border-radius: 5px;
  font-size: 0.82em; white-space: pre-wrap; word-wrap: break-word; }
.crpdf code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.crpdf table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
.crpdf td, .crpdf th { border: 1px solid #e3e0da; padding: 5px 7px; }
`

export function pdfFilename(article) {
  return `${slugifyTitle(article?.title)}.pdf`
}

/** Builds the off-screen node html2canvas will photograph. */
function buildDocument(article) {
  const holder = document.createElement('div')
  // Laid out at 0,0 and made invisible rather than pushed off-screen: a negative
  // offset makes html2canvas lay out against the viewport width instead of ours,
  // which overflows the PDF page and clips the right edge of every line.
  holder.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    `width:${RENDER_WIDTH}px`,
    'background:#fff',
    'opacity:0',
    'pointer-events:none',
    'z-index:-2147483647',
  ].join(';')

  const style = document.createElement('style')
  style.textContent = PRINT_CSS

  const page = document.createElement('div')
  page.className = 'crpdf'

  const h1 = document.createElement('h1')
  h1.textContent = article.title ?? 'Untitled'

  const meta = document.createElement('p')
  meta.className = 'crpdf-meta'
  meta.textContent = [article.byline, article.siteName, `${article.readingTimeMinutes} min read`]
    .filter(Boolean)
    .join(' · ')

  const body = document.createElement('div')
  body.innerHTML = article.content ?? ''

  page.append(h1, meta, body)
  holder.append(style, page)
  return { holder, page }
}

/**
 * Renders the article to a PDF and hands it to the browser.
 * Resolves once the file has been produced.
 */
export async function exportPdf(article) {
  const { default: html2pdf } = await import('html2pdf.js')
  const { holder, page } = buildDocument(article)
  document.body.append(holder)

  try {
    await html2pdf()
      .set({
        margin: [14, 12, 16, 12], // mm: t r b l
        filename: pdfFilename(article),
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          useCORS: true, // article images are nearly always cross-origin
          backgroundColor: '#ffffff',
          logging: false,
          // pin the capture to our column; without these html2canvas measures
          // against the real window and the page overflows
          width: RENDER_WIDTH,
          windowWidth: RENDER_WIDTH,
          scrollX: 0,
          scrollY: 0,
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        // don't slice a heading or an image across a page boundary
        pagebreak: { mode: ['css', 'legacy'], avoid: ['img', 'figure', 'blockquote', 'pre', 'h2', 'h3'] },
      })
      .from(page)
      .save()
  } finally {
    holder.remove()
  }
}
