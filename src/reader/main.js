/**
 * Offline view for a saved article. This is an extension page, so it may talk
 * to Dexie directly -- only *content scripts* are barred (they run in the
 * page's origin). See notes/features/save-article.md.
 *
 * It renders into a shadow root for the same reason the in-page reader does:
 * reader.css is written against `:host`, so both share one stylesheet.
 */
import { getArticle } from '../lib/db.js'
import { getSettings } from '../lib/settings.js'
import { markdownFilename, toMarkdown } from '../lib/export-markdown.js'
import { downloadText } from '../lib/download.js'
import { exportPdf } from '../lib/export-pdf.js'
import readerCss from '../content-scripts/reader.css?inline'

const root = document.getElementById('root')

/** The page shell is 100vh on screen; on paper it must flow. */
function installPagePrintStyle() {
  const style = document.createElement('style')
  style.textContent = '@media print { html, body { background: #fff !important; } #root > div { height: auto !important; } }'
  document.head.append(style)
}

function shell() {
  const host = document.createElement('div')
  host.style.cssText = 'display:block;height:100vh'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = readerCss
  shadow.append(style)
  root.append(host)
  return { host, shadow }
}

function renderMessage(shadow, text) {
  const surface = document.createElement('div')
  surface.className = 'cr-surface'
  const p = document.createElement('p')
  p.className = 'cr-notice'
  p.textContent = text
  surface.append(p)
  shadow.append(surface)
}

async function main() {
  installPagePrintStyle()
  const { host, shadow } = shell()
  const settings = await getSettings()

  host.dataset.theme = settings.theme
  host.style.setProperty('--cr-font-size', `${settings.fontSize}px`)
  host.style.setProperty('--cr-line-height', String(settings.lineHeight))
  host.style.setProperty('--cr-width', `${settings.contentWidth}px`)
  document.body.style.background = settings.theme === 'dark' ? '#16161a' : '#fbfaf8'

  const id = Number(new URLSearchParams(location.search).get('id'))
  if (!id) return renderMessage(shadow, 'No article specified.')

  const article = await getArticle(id)
  if (!article) return renderMessage(shadow, 'That article is no longer saved.')

  document.title = `${article.title} — CleanRead`

  const surface = document.createElement('div')
  surface.className = 'cr-surface'

  const header = document.createElement('header')
  header.className = 'cr-header'

  const h1 = document.createElement('h1')
  h1.className = 'cr-title'
  h1.textContent = article.title

  const meta = document.createElement('p')
  meta.className = 'cr-meta'
  meta.textContent = [
    article.siteName,
    article.byline,
    `${article.readingTimeMinutes} min read`,
    `saved ${new Date(article.savedAt).toLocaleDateString()}`,
  ]
    .filter(Boolean)
    .join(' · ')

  const actions = document.createElement('p')
  actions.className = 'cr-meta cr-actions'

  const link = document.createElement('a')
  link.href = article.url
  link.textContent = 'View original'

  const exportBtn = document.createElement('button')
  exportBtn.className = 'cr-action cr-action--md'
  exportBtn.type = 'button'
  exportBtn.textContent = 'Download Markdown'
  exportBtn.addEventListener('click', () =>
    downloadText(markdownFilename(article), toMarkdown(article)),
  )

  const pdfBtn = document.createElement('button')
  pdfBtn.className = 'cr-action cr-action--pdf'
  pdfBtn.type = 'button'
  pdfBtn.textContent = 'Download PDF'
  pdfBtn.addEventListener('click', async () => {
    pdfBtn.disabled = true
    pdfBtn.textContent = 'Rendering...'
    try {
      await exportPdf(article)
    } finally {
      pdfBtn.disabled = false
      pdfBtn.textContent = 'Download PDF'
    }
  })

  const printBtn = document.createElement('button')
  printBtn.className = 'cr-action cr-action--print'
  printBtn.type = 'button'
  printBtn.textContent = 'Print'
  printBtn.addEventListener('click', () => window.print())

  actions.append(link, printBtn, exportBtn, pdfBtn)
  header.append(h1, meta, actions)

  const body = document.createElement('article')
  body.className = 'cr-content'
  body.innerHTML = article.content // sanitised by Readability before it was stored

  surface.append(header, body)
  shadow.append(surface)
}

main()
