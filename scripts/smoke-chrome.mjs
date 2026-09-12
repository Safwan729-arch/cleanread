/**
 * Chrome smoke test: loads the built extension into real Chrome and drives the
 * core flow through the actual message contract. Run with `npm run smoke:chrome`
 * after `npm run build`.
 *
 * See notes/architecture/running-the-extension.md for why each flag is needed.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { toMarkdown } from '../src/lib/export-markdown.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// forward slashes: Extensions.loadUnpacked rejects backslash paths on Windows
const EXT = path.join(ROOT, 'dist').replace(/\\/g, '/')
const PROFILE = path.join(ROOT, 'node_modules', '.cache', 'cleanread-smoke-profile')
const SHOTS = path.join(ROOT, 'node_modules', '.cache', 'cleanread-smoke-shots')

const CHROME =
  process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error(`No build at ${EXT} — run "npm run build" first.`)
  process.exit(1)
}
fs.mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log(...a)
let failures = 0
function check(name, pass, detail = '') {
  log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`)
  if (!pass) failures++
}

// --- serve the messy fixture over http (content scripts do not run on file://)
const fixtures = {
  '/article': fs.readFileSync(path.join(HERE, 'fixtures', 'messy-article.html')),
  '/short': fs.readFileSync(path.join(HERE, 'fixtures', 'short-article.html')),
  '/math': fs.readFileSync(path.join(HERE, 'fixtures', 'math-article.html')),
  '/media': fs.readFileSync(path.join(HERE, 'fixtures', 'media-article.html')),
  '/chart': fs.readFileSync(path.join(HERE, 'fixtures', 'chart-article.html')),
}
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(fixtures[req.url] ?? fixtures['/article'])
})
await new Promise((r) => server.listen(8781, '127.0.0.1', r))
const FIXTURE_URL = 'http://127.0.0.1:8781/article'
log(`fixture served at ${FIXTURE_URL}\n`)

fs.rmSync(PROFILE, { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  // Chrome 137+ removed --load-extension; CDP Extensions.loadUnpacked replaces it
  args: ['--enable-unsafe-extension-debugging'],
  // Playwright disables extensions by default -- that silently blocks the install
  ignoreDefaultArgs: ['--disable-extensions'],
})

const cdp = await ctx.browser().newBrowserCDPSession()
const { id: loadedId } = await cdp.send('Extensions.loadUnpacked', { path: EXT })

// Chrome runs its own component extensions' workers too, so never just take the
// first 'serviceworker' event -- match on our extension id.
async function workerFor(id, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const w = ctx.serviceWorkers().find((x) => new URL(x.url()).host === id)
    if (w) return w
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`service worker for ${id} never started`)
}

const sw = await workerFor(loadedId)
const extId = new URL(sw.url()).host
check('extension installed + service worker running', extId === loadedId, `id=${extId}`)

// --- icons are declared and actually loadable from the extension origin
const icons = await sw.evaluate(async () => {
  const declared = chrome.runtime.getManifest().icons ?? {}
  const results = {}
  for (const size of Object.keys(declared)) {
    const res = await fetch(chrome.runtime.getURL(declared[size])).catch(() => null)
    results[size] = Boolean(res?.ok) && (await res.blob()).size > 0
  }
  return { declared: Object.keys(declared), results }
})
check('all manifest icon sizes declared', icons.declared.join(',') === '16,32,48,128', icons.declared.join(','))
check('every icon file loads from the extension', Object.values(icons.results).every(Boolean), JSON.stringify(icons.results))

const page = ctx.pages()[0] ?? (await ctx.newPage())
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()))

await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800) // content script runs at document_idle

// drive through the real message contract, from the background worker
const send = (message) =>
  sw.evaluate(async (msg) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    try {
      return await chrome.tabs.sendMessage(tab.id, msg)
    } catch (e) {
      return { ok: false, reason: 'threw', error: String(e) }
    }
  }, message)

// --- 1. GET_STATE before cleaning
const before = await send({ type: 'cleanread/get-state' })
check('content script responds to GET_STATE', before && before.active === false)
check('page reported as readerable', before?.readerable === true)

// --- 2. distractions present before cleaning
check('cookie banner visible before clean', (await page.locator('.cookie-bar').isVisible()) === true)

// --- 3. CLEAN_PAGE
const cleaned = await send({ type: 'cleanread/clean-page' })
check('CLEAN_PAGE returned ok', cleaned?.ok === true)
// Readability only strips site suffixes on its known separators (| - / > »),
// not an em dash, so the suffix legitimately survives here.
check(
  'extracted the real title',
  cleaned?.title?.startsWith('The Quiet Cost of Notifications'),
  `got: ${cleaned?.title}`,
)
check('reading time computed', Number(cleaned?.readingTimeMinutes) >= 1, `${cleaned?.readingTimeMinutes} min`)

await page.waitForTimeout(400)
const root = page.locator('#cleanread-root')
check('reader overlay present', (await root.count()) === 1)
check('reader overlay visible', await root.isVisible())

// --- 4. distraction removal
check('cookie banner hidden after clean', (await page.locator('.cookie-bar').isVisible()) === false)
check('sticky nav hidden after clean', (await page.locator('.sticky-nav').isVisible()) === false)
check('newsletter popup hidden after clean', (await page.locator('.newsletter-popup').isVisible()) === false)

// content lives inside the shadow root; Playwright CSS pierces open shadow roots
const overlayText = await page.locator('#cleanread-root .cr-surface').innerText()
check('ads stripped from reader content', !/ADVERTISEMENT/i.test(overlayText))
// Readability strips classes by default, which once let the cookie bar through
check('cookie banner text not in reader content', !/COOKIE BANNER/i.test(overlayText))
check('newsletter popup text not in reader content', !/NEWSLETTER POPUP/i.test(overlayText))
check('sticky nav text not in reader content', !/STICKY NAV/i.test(overlayText))
check('article body kept', overlayText.includes('The cheapest interruption'))
check('headings kept', overlayText.includes('A more honest accounting'))
// .cr-meta is text-transform:uppercase, and innerText returns rendered text
check('reading time shown in header', /\d+ min read/i.test(overlayText))

// host page CSS must not reach inside the shadow root
const bleed = await root.evaluate((host) => {
  const cs = getComputedStyle(host.shadowRoot.querySelector('.cr-content'))
  return { bg: cs.backgroundColor, maxWidth: cs.maxWidth }
})
check('host page article{} styles do not bleed in', bleed.bg === 'rgba(0, 0, 0, 0)', `content bg: ${bleed.bg}`)

// --- 5. contents rail
const toc = page.locator('#cleanread-root .cr-toc')
const tocLinks = page.locator('#cleanread-root .cr-toc-link')
const activeLink = page.locator('#cleanread-root .cr-toc-link.is-active')

check('contents rail rendered', await toc.isVisible())
const tocTexts = await tocLinks.allInnerTexts()
check('one entry per heading', tocTexts.length === 4, `${tocTexts.length} entries`)
check('rail lists the real headings', tocTexts.includes('Where to start on Monday'), tocTexts.join(' | '))
check(
  'h3 nested one level under its h2',
  (await page.locator('#cleanread-root .cr-toc-item[data-level="3"]').count()) === 1,
)
check('first section active at top of article', (await activeLink.innerText()) === 'What the numbers miss')

await page.screenshot({ path: path.join(SHOTS, '1-cleaned-light.png') })

// clicking an entry scrolls the reader and moves the active marker
await tocLinks.last().click()
await page.waitForTimeout(1000) // smooth scroll needs to settle
const scrolled = await page.locator('#cleanread-root .cr-surface').evaluate((el) => el.scrollTop)
check('clicking an entry scrolls the reader', scrolled > 0, `scrollTop=${Math.round(scrolled)}`)
check('scroll spy follows to that section', (await activeLink.innerText()) === 'Where to start on Monday')

// collapse / expand
const tocToggle = page.locator('#cleanread-root .cr-toc-toggle')
const tocList = page.locator('#cleanread-root .cr-toc-list')
await tocToggle.click()
await page.waitForTimeout(200)
check('collapse hides the list', (await tocList.isVisible()) === false)
await tocToggle.click()
await page.waitForTimeout(200)
check('expand restores the list', await tocList.isVisible())

// the rail must get out of the way on narrow windows
await page.setViewportSize({ width: 1000, height: 720 })
await page.waitForTimeout(250)
check('rail hidden on narrow windows', (await toc.isVisible()) === false)
await page.setViewportSize({ width: 1280, height: 720 })
await page.waitForTimeout(250)
check('rail returns when there is room', await toc.isVisible())

// --- 6. live settings
await send({
  type: 'cleanread/apply-settings',
  settings: { theme: 'dark', fontSize: 24, lineHeight: 2.0, contentWidth: 760 },
})
await page.waitForTimeout(300)
const applied = await root.evaluate((host) => {
  const s = getComputedStyle(host.shadowRoot.querySelector('.cr-surface'))
  return {
    theme: host.dataset.theme,
    fontSize: s.fontSize,
    lineHeight: host.style.getPropertyValue('--cr-line-height'),
    bg: s.backgroundColor,
  }
})
check('dark theme applied', applied.theme === 'dark')
check('font size applied', applied.fontSize === '24px', applied.fontSize)
check('line spacing applied', applied.lineHeight === '2')
check('dark background actually painted', applied.bg === 'rgb(22, 22, 26)', applied.bg)

// Changing type size reflows the column, so the spy must re-run. Assert the
// invariant (active = last heading past the cutoff) rather than a fixed title.
await page.waitForTimeout(300)
const spy = await root.evaluate((host) => {
  const sr = host.shadowRoot
  const surf = sr.querySelector('.cr-surface')
  const cutoff = surf.getBoundingClientRect().top + 80
  const links = [...sr.querySelectorAll('.cr-toc-link')]
  const active = sr.querySelector('.cr-toc-link.is-active')
  if (!active) return { ok: false, why: 'nothing marked active' }

  const idx = links.indexOf(active)
  const headOf = (l) => sr.getElementById(l.getAttribute('href').slice(1))
  if (surf.scrollHeight - surf.scrollTop - surf.clientHeight <= 2) {
    return { ok: idx === links.length - 1, why: 'at bottom -> expect last entry' }
  }
  // before the first heading, marking the first entry is correct
  if (idx === 0 && surf.scrollTop < 40) return { ok: true, why: 'at top -> first entry' }
  const thisTop = headOf(links[idx]).getBoundingClientRect().top
  const nextTop = idx + 1 < links.length ? headOf(links[idx + 1]).getBoundingClientRect().top : Infinity
  return {
    ok: thisTop <= cutoff && nextTop > cutoff,
    why: `active="${active.textContent}" top=${Math.round(thisTop)} next=${Math.round(nextTop)} cutoff=${Math.round(cutoff)}`,
  }
})
check('spy re-syncs after a reflow', spy.ok, spy.why)

// --- print stylesheet: the reader is in dark mode right now, so this also
// proves print forces the light palette rather than burning ink.
await page.emulateMedia({ media: 'print' })
await page.waitForTimeout(250)
const printed = await root.evaluate((host) => {
  const sr = host.shadowRoot
  const cs = (sel) => getComputedStyle(sr.querySelector(sel))
  return {
    toc: cs('.cr-toc').display,
    surfaceBg: cs('.cr-surface').backgroundColor,
    surfaceColor: cs('.cr-surface').color,
    surfaceOverflow: cs('.cr-surface').overflowY,
    pageHidden: getComputedStyle(document.querySelector('.sticky-nav')).display,
  }
})
check('print hides the contents rail', printed.toc === 'none', printed.toc)
check('print forces a white background even in dark mode', printed.surfaceBg === 'rgb(255, 255, 255)', printed.surfaceBg)
check('print forces black text', printed.surfaceColor === 'rgb(0, 0, 0)', printed.surfaceColor)
check('print lets the article flow instead of scrolling', printed.surfaceOverflow === 'visible', printed.surfaceOverflow)
check('print hides the host page behind the reader', printed.pageHidden === 'none', printed.pageHidden)
await page.emulateMedia({ media: null })
await page.waitForTimeout(250)

await page.screenshot({ path: path.join(SHOTS, '2-cleaned-dark.png') })

// --- 7. paragraph highlighting
const paras = page.locator('#cleanread-root .cr-content p[data-cr-hash]')
const firstPara = paras.first()
const isMarked = async (loc) => ((await loc.getAttribute('class')) ?? '').includes('is-highlighted')

check('paragraphs are markable', (await paras.count()) > 3, `${await paras.count()} markable blocks`)

await firstPara.click()
await page.waitForTimeout(250)
check('clicking a paragraph highlights it', await isMarked(firstPara))

await firstPara.click()
await page.waitForTimeout(250)
check('clicking again clears it', (await isMarked(firstPara)) === false)

await firstPara.click() // leave one highlighted for the persistence check
await page.waitForTimeout(400)


// a link inside a paragraph must still behave like a link
const linkPara = page.locator('#cleanread-root .cr-content p[data-cr-hash]', {
  hasText: 'Researchers who study',
})
const beforeLinkClick = await isMarked(linkPara)
await linkPara.locator('a').click()
await page.waitForTimeout(250)
check('clicking a link does not highlight', (await isMarked(linkPara)) === beforeLinkClick)

// the real test: highlights are in IndexedDB in the extension origin, so they
// must survive a full page reload and re-extraction
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(900)
const recleaned = await send({ type: 'cleanread/clean-page' })
check('re-cleans after a reload', recleaned?.ok === true)
await page.waitForTimeout(800) // highlight restore is async
check(
  'highlights survive a reload',
  await isMarked(page.locator('#cleanread-root .cr-content p[data-cr-hash]').first()),
)
await page.screenshot({ path: path.join(SHOTS, '6-highlighted.png') })

// --- 6. RESTORE_PAGE
const restored = await send({ type: 'cleanread/restore-page' })
check('RESTORE_PAGE returned ok', restored?.ok === true)
await page.waitForTimeout(300)
check('overlay removed', (await page.locator('#cleanread-root').count()) === 0)
check('cookie banner restored', (await page.locator('.cookie-bar').isVisible()) === true)
check('sticky nav restored', (await page.locator('.sticky-nav').isVisible()) === true)

// --- 8. save article
// GET_ARTICLE must work even though the page is no longer cleaned
const fetched = await send({ type: 'cleanread/get-article' })
check('GET_ARTICLE returns the full article', fetched?.ok === true && fetched.article?.content?.length > 500,
  `${fetched?.article?.content?.length ?? 0} chars of content`)

// The popup reads the *active* tab, so open it as a background tab and bring
// the article tab back to the front -- a real toolbar click behaves this way.
const popupTab = await ctx.newPage()
await popupTab.goto(`chrome-extension://${extId}/src/popup/index.html`)
await popupTab.waitForTimeout(700)
await page.bringToFront()
await popupTab.waitForTimeout(300)
// programmatic click: a Playwright click would pull focus back to this tab
await popupTab.evaluate(() => document.querySelector('.popup__save').click())
await popupTab.waitForTimeout(1500)

const savedRows = await sw.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('cleanread')
      r.onsuccess = () => {
        const q = r.result.transaction('articles', 'readonly').objectStore('articles').getAll()
        q.onsuccess = () =>
          res(q.result.map((a) => ({ id: a.id, title: a.title, url: a.url, len: a.content?.length ?? 0 })))
        q.onerror = () => res('getAll failed')
      }
      r.onerror = () => res('open failed')
    }),
)
check('saving writes the article to Dexie', Array.isArray(savedRows) && savedRows.length === 1, JSON.stringify(savedRows))
check('stored url drops the #fragment', savedRows[0]?.url?.endsWith('/article'), savedRows[0]?.url)
check('stored record keeps the cleaned content', (savedRows[0]?.len ?? 0) > 500, `${savedRows[0]?.len} chars`)

check('popup reading list shows the saved article',
  (await popupTab.locator('.popup__item-title').innerText()).startsWith('The Quiet Cost of Notifications'))
check('save button flips to remove',
  (await popupTab.locator('.popup__save').innerText()) === 'Remove from reading list')
await popupTab.screenshot({ path: path.join(SHOTS, '7-popup-reading-list.png') })

// --- the saved article opens offline in its own page
const savedId = savedRows[0].id
const readerTab = await ctx.newPage()
const readerErrors = []
readerTab.on('pageerror', (e) => readerErrors.push(String(e)))
await readerTab.goto(`chrome-extension://${extId}/src/reader/index.html?id=${savedId}`)
await readerTab.waitForTimeout(1200)
const readerText = await readerTab.locator('#root .cr-surface').innerText()
check('saved article renders offline', readerText.includes('The Quiet Cost of Notifications'))
check('offline copy keeps the body text', readerText.includes('The cheapest interruption'))
check('offline copy links to the original',
  (await readerTab.locator('#root .cr-header a').innerText()).toLowerCase() === 'view original')
check('reader page threw no errors', readerErrors.length === 0, readerErrors.join(' | '))
await readerTab.screenshot({ path: path.join(SHOTS, '8-saved-offline.png') })

// --- 9. export to Markdown
const [download] = await Promise.all([
  readerTab.waitForEvent('download', { timeout: 20000 }),
  readerTab.locator('#root .cr-action--md').click(),
])
const md = fs.readFileSync(await download.path(), 'utf8')
check('markdown downloads as a .md slug', /^the-quiet-cost-of-notifications.*\.md$/.test(download.suggestedFilename()),
  download.suggestedFilename())
check('markdown opens with the title as H1', md.startsWith('# The Quiet Cost of Notifications'))
check('markdown keeps section headings', md.includes('## What the numbers miss'))
check('markdown keeps the nested h3', md.includes('### Batching is arithmetic'))
check('markdown links back to the original', md.includes('[View original](http://127.0.0.1:8781/article)'))
check('markdown converts inline links', /\[recovery period\]\(#recovery\)/.test(md))
check('markdown converts the blockquote', md.includes('> The cheapest interruption'))
check('markdown carries no raw HTML', !/<(p|div|h[1-6]|article|blockquote)\b/i.test(md))
check('markdown dropped the ads with the rest', !/ADVERTISEMENT/i.test(md))
check('markdown dropped the cookie banner too', !/COOKIE BANNER/i.test(md))
check('markdown carries no leftover class attributes', !/class=/i.test(md))
fs.writeFileSync(path.join(SHOTS, 'export-sample.md'), md)

// --- 10. export to PDF (html2canvas + jsPDF; the lib is ~900KB so give it room)
const [pdfDownload] = await Promise.all([
  readerTab.waitForEvent('download', { timeout: 90000 }),
  readerTab.locator('#root .cr-action--pdf').click(),
])
const pdfPath = await pdfDownload.path()
const pdfBuf = fs.readFileSync(pdfPath)
check('pdf downloads as a .pdf slug', /^the-quiet-cost-of-notifications.*\.pdf$/.test(pdfDownload.suggestedFilename()),
  pdfDownload.suggestedFilename())
check('pdf has the PDF magic header', pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-',
  pdfBuf.subarray(0, 8).toString('latin1'))
check('pdf ends with a valid EOF marker', pdfBuf.subarray(-1024).toString('latin1').includes('%%EOF'))
check('pdf is a substantial file', pdfBuf.length > 20000, `${Math.round(pdfBuf.length / 1024)}KB`)
const pdfRaw = pdfBuf.toString('latin1')
const pageCount = (pdfRaw.match(/\/Type\s*\/Page[^s]/g) ?? []).length
check('pdf paginated the article', pageCount >= 1, `${pageCount} page(s)`)

// Regression guard for right-edge clipping: html2canvas must lay out against our
// 760px column, not the browser window. The embedded image width is the tell --
// RENDER_WIDTH (760) x scale (2). A window-width capture comes out much wider.
const imgWidths = [...pdfRaw.matchAll(/\/Width\s+(\d+)/g)].map((m) => Number(m[1]))
check('pdf rendered at the fixed column width (not clipped)',
  imgWidths.length > 0 && imgWidths.every((w) => w === 1520), imgWidths.join(', ') || 'no image found')
// the download event fires before save() resolves, so poll for the reset;
// .cr-action inherits text-transform:uppercase from .cr-meta, hence lowercasing
let pdfBtnText = ''
for (let i = 0; i < 24; i++) {
  pdfBtnText = (await readerTab.locator('#root .cr-action--pdf').innerText()).toLowerCase()
  if (pdfBtnText === 'download pdf') break
  await readerTab.waitForTimeout(250)
}
check('the export button recovered', pdfBtnText === 'download pdf', pdfBtnText)
fs.copyFileSync(pdfPath, path.join(SHOTS, 'export-sample.pdf'))

// --- 11. print path: the same article through Chrome's print pipeline, which
// keeps text as text. This is the accessibility difference, so assert it.
const printBuf = await readerTab.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } })
const printRaw = printBuf.toString('latin1')
fs.writeFileSync(path.join(SHOTS, 'print-sample.pdf'), printBuf)

check('printed pdf embeds fonts (text stays text)', /\/Type\s*\/Font/.test(printRaw))
// jsPDF always writes base-14 font dictionaries, used or not, so their presence
// proves nothing. The page *content* being an image XObject is the real tell.
check('rasterised pdf draws the page as an image', /\/Subtype\s*\/Image/.test(pdfRaw))
check('printed pdf draws no page-sized raster (this fixture has no images)', !/\/Subtype\s*\/Image/.test(printRaw))
check('printed pdf is far smaller than the rasterised one',
  printBuf.length * 4 < pdfBuf.length,
  `${Math.round(printBuf.length / 1024)}KB printed vs ${Math.round(pdfBuf.length / 1024)}KB rasterised`)
check('printed pdf omits the contents rail', !/Contents\x00/.test(printRaw))

// a missing id must not blow up
await readerTab.goto(`chrome-extension://${extId}/src/reader/index.html?id=999999`)
await readerTab.waitForTimeout(700)
check('missing article shows a message, not a crash',
  (await readerTab.locator('#root .cr-surface').innerText()).includes('no longer saved'))
await readerTab.close()

// --- removing from the list deletes the row
await popupTab.evaluate(() => document.querySelector('.popup__item-remove').click())
await popupTab.waitForTimeout(900)
const afterDelete = await sw.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('cleanread')
      r.onsuccess = () => {
        const q = r.result.transaction('articles', 'readonly').objectStore('articles').count()
        q.onsuccess = () => res(q.result)
      }
    }),
)
check('removing clears the stored row', afterDelete === 0, `${afterDelete} rows left`)
check('popup shows the empty state', await popupTab.locator('.popup__empty').isVisible())
await popupTab.close()
await page.bringToFront()

// --- 9b. maths must stay in the sentence, and stay visible in dark mode
await page.goto('http://127.0.0.1:8781/math', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)
const mathClean = await send({ type: 'cleanread/clean-page' })
check('maths article cleans', mathClean?.ok === true, mathClean?.title ?? mathClean?.reason)
await page.waitForTimeout(500)

const maths = await page.locator('#cleanread-root').evaluate((host) => {
  const sr = host.shadowRoot
  const content = sr.querySelector('.cr-content')
  const inline = [...content.querySelectorAll('[data-cr-math="inline"]')]
  const display = [...content.querySelectorAll('[data-cr-math="display"]')]
  const para = [...content.querySelectorAll('p')].find((p) => p.textContent.includes('viscosity term'))
  return {
    inlineCount: inline.length,
    displayCount: display.length,
    inlineDisplays: inline.map((el) => getComputedStyle(el).display),
    displayDisplays: display.map((el) => getComputedStyle(el).display),
    // the real test: does the equation sit on the same line as the words?
    sameLineAsText: para
      ? (() => {
          const img = para.querySelector('[data-cr-math="inline"]')
          if (!img) return false
          const r = img.getBoundingClientRect()
          const p = para.getBoundingClientRect()
          return r.left > p.left + 20 && r.right < p.right
        })()
      : false,
    ariaHidden: inline.filter((el) => el.hasAttribute('aria-hidden')).length,
    editLinks: content.textContent.includes('[edit]'),
  }
})
check('inline maths detected and tagged', maths.inlineCount === 2, `${maths.inlineCount} inline`)
check('display maths detected and tagged', maths.displayCount === 2, `${maths.displayCount} display`)
check('inline maths renders inline, not as a block',
  maths.inlineDisplays.every((d) => d === 'inline-block'), maths.inlineDisplays.join(', '))
check('display maths renders on its own line',
  maths.displayDisplays.every((d) => d === 'block'), maths.displayDisplays.join(', '))
check('inline maths sits inside the sentence, not centred below it', maths.sameLineAsText)
check('maths is exposed to screen readers (aria-hidden dropped)', maths.ariaHidden === 0, `${maths.ariaHidden} still hidden`)
check('wikipedia [edit] links are scrubbed', maths.editLinks === false)
await page.screenshot({ path: path.join(SHOTS, '9-math-light.png') })

// dark mode must not leave black glyphs on a black background
await send({ type: 'cleanread/apply-settings', settings: { theme: 'dark', fontSize: 18, lineHeight: 1.6, contentWidth: 680 } })
await page.waitForTimeout(400)
const mathDark = await page.locator('#cleanread-root').evaluate((host) => {
  const el = host.shadowRoot.querySelector('.cr-content img[data-cr-math]')
  return getComputedStyle(el).filter
})
check('dark mode inverts maths so it stays legible', /invert/.test(mathDark), mathDark)
await page.screenshot({ path: path.join(SHOTS, '9-math-dark.png') })
await send({ type: 'cleanread/apply-settings', settings: { theme: 'light', fontSize: 18, lineHeight: 1.6, contentWidth: 680 } })

// maths must survive Markdown export as LaTeX, not as an image of an equation
const mathArticle = await send({ type: 'cleanread/get-article' })
const mathId = await sw.evaluate(
  (a) =>
    new Promise((res) => {
      const r = indexedDB.open('cleanread')
      r.onsuccess = () => {
        const q = r.result.transaction('articles', 'readwrite').objectStore('articles').add({ ...a, savedAt: Date.now() })
        q.onsuccess = () => res(q.result)
        q.onerror = () => res(null)
      }
    }),
  mathArticle.article,
)
const mathTab = await ctx.newPage()
await mathTab.goto(`chrome-extension://${extId}/src/reader/index.html?id=${mathId}`)
await mathTab.waitForTimeout(900)
const [mathMdDownload] = await Promise.all([
  mathTab.waitForEvent('download', { timeout: 20000 }),
  mathTab.locator('#root .cr-action--md').click(),
])
const mathMd = fs.readFileSync(await mathMdDownload.path(), 'utf8')
check('display maths exports as a $$ block', /\$\$\n[^\n]*\\frac[^\n]*\n\$\$/.test(mathMd))
check('inline maths exports as $…$ inside the sentence',
  /viscosity term \$.*\\tau.*\$ \(the deviatoric/.test(mathMd.replace(/\n/g, ' ')))
check('maths is not exported as an image', !/!\[/.test(mathMd))
check('the {\\displaystyle …} wrapper is unwrapped', !/displaystyle/.test(mathMd))
fs.writeFileSync(path.join(SHOTS, 'export-math-sample.md'), mathMd)
await mathTab.close()
await sw.evaluate((id) => new Promise((res) => {
  const r = indexedDB.open('cleanread')
  r.onsuccess = () => { r.result.transaction('articles', 'readwrite').objectStore('articles').delete(id); res(true) }
}), mathId)
await page.bringToFront()

await send({ type: 'cleanread/restore-page' })

// --- 9c. figures and charts must survive extraction
await page.goto('http://127.0.0.1:8781/media', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1400) // let the lazy swap and the canvas drawing happen
const mediaClean = await send({ type: 'cleanread/clean-page' })
check('media article cleans', mediaClean?.ok === true, mediaClean?.title ?? mediaClean?.reason)
await page.waitForTimeout(700)

const media = await page.locator('#cleanread-root').evaluate((host) => {
  const c = host.shadowRoot.querySelector('.cr-content')
  const imgs = [...c.querySelectorAll('img')]
  return {
    figures: c.querySelectorAll('figure').length,
    captions: [...c.querySelectorAll('figcaption')].map((f) => f.textContent.trim().slice(0, 9)),
    svgs: c.querySelectorAll('svg').length,
    canvases: c.querySelectorAll('canvas').length,
    pngFromCanvas: imgs.filter((i) => (i.getAttribute('src') ?? '').startsWith('data:image/png')).length,
    placeholders: imgs.filter((i) => (i.getAttribute('src') ?? '').startsWith('data:image/gif')).length,
    renderedWide: imgs.filter((i) => i.getBoundingClientRect().width > 300).length,
    tinyRendered: imgs.filter((i) => {
      const r = i.getBoundingClientRect()
      return r.width > 0 && r.width <= 2
    }).length,
  }
})
// the hero sits in <figure class="article-banner"> -- "banner" used to delete it
check('hero image inside a "banner" wrapper is kept', media.captions.includes('Figure 1.'), media.captions.join(' '))
check('all four figures survive extraction', media.figures === 4, `${media.figures} figures`)
check('lazy-loaded chart keeps its real source, not the placeholder', media.placeholders === 0)
check('inline SVG chart survives', media.svgs === 1, `${media.svgs} svg`)
check('canvas chart is converted to a real image', media.canvases === 0 && media.pngFromCanvas === 1,
  `${media.canvases} canvas, ${media.pngFromCanvas} png`)
check('every surviving figure actually renders wide', media.renderedWide === 3, `${media.renderedWide} wide images`)
check('tracking pixel is dropped', media.tinyRendered === 0, `${media.tinyRendered} tiny images`)

// --- CSS-driven SVG charts (Vega/D3/Recharts shape)
await page.goto('http://127.0.0.1:8781/chart', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(900)
const chartClean = await send({ type: 'cleanread/clean-page' })
check('chart article cleans', chartClean?.ok === true, chartClean?.title ?? chartClean?.reason)
await page.waitForTimeout(800)

const chartView = await page.locator('#cleanread-root').evaluate((host) => {
  const c = host.shadowRoot.querySelector('.cr-content')
  const charts = [...c.querySelectorAll('svg[data-cr-chart]')]
  const inkOf = (sel) => {
    const el = charts[0]?.querySelector(sel)
    return el ? getComputedStyle(el).fill : null
  }
  return {
    charts: charts.length,
    rendered: charts.filter((s) => {
      const r = s.getBoundingClientRect()
      return r.width > 300 && r.height > 100
    }).length,
    // an icon must not be promoted to a chart
    icons: [...c.querySelectorAll('svg:not([data-cr-chart])')].length,
    tickInk: inkOf('.tick-label, text'),
    seriesInk: charts[0] ? getComputedStyle(charts[0].querySelector('polyline')).stroke : null,
    backdrops: charts.filter((s) => s.style.background).length,
    optionNotes: c.querySelectorAll('[data-cr-chart-options]').length,
    optionText: c.querySelector('[data-cr-chart-options]')?.textContent ?? '',
    leftoverSlots: c.querySelectorAll('img[data-cr-chart-slot]').length,
    pageControls: c.querySelectorAll('button:not([data-cr-chart-tab]), select').length,
    ourTabs: c.querySelectorAll('[data-cr-chart-tab]').length,
    adKept: /Upgrade to Messy Times Pro/i.test(c.textContent),
    captions: c.querySelectorAll('figcaption').length,
  }
})

// the wrapper class is `scroll-mt-anchor-offset`; Readability's negative-weight
// list contains the bare substring `scroll`, which used to delete the chart
check('a chart in a "scroll-*" utility wrapper survives', chartView.charts === 5, `${chartView.charts} charts`)
check('every visible chart renders at content size', chartView.rendered === 3, `${chartView.rendered} rendered`)
check('no chart placeholder is left behind', chartView.leftoverSlots === 0)
// the fixture's 16px arrow must not be promoted: the two static charts plus the
// three captured views of the switchable one, and nothing else
check('a 16px icon is not promoted to a chart', chartView.charts === 5 && chartView.icons === 0,
  `${chartView.charts} charts, ${chartView.icons} other svg`)
// paint lives only in the page stylesheet, which the shadow root cannot see
check('axis ink is frozen into the chart', /rgb\(20[0-9], 20[0-9], 20[0-9]\)|rgb\(207, 205, 200\)/.test(chartView.tickInk ?? ''),
  chartView.tickInk)
check('series colour is frozen into the chart', /rgb\(111, 168, 255\)/.test(chartView.seriesInk ?? ''), chartView.seriesInk)
// the fixture is a dark page, so light ink needs its own panel to stay legible
check('a chart drawn for a dark page keeps a dark panel', chartView.backdrops === 5, `${chartView.backdrops} with backdrop`)
check("the page's own dead controls are removed", chartView.pageControls === 0, `${chartView.pageControls} left`)
check('the reader says which views the original offered', chartView.optionNotes === 1, chartView.optionText.slice(0, 70))
check('chart captions survive alongside the chart', chartView.captions === 3, `${chartView.captions} captions`)
check('the chart fix did not weaken ad removal', chartView.adKept === false)

// --- charts hidden behind the page's own switches
// The third fixture chart redraws only when a tab is clicked, asynchronously.
// Extraction works those switches on the live page and photographs each result.
const toggles = await page.locator('#cleanread-root').evaluate((host) => {
  const c = host.shadowRoot.querySelector('.cr-content')
  const bar = c.querySelector('[data-cr-chart-tabs]')
  if (!bar) return { error: 'no chart tab bar' }
  const group = bar.closest('[data-cr-chart-group]')
  const views = [...group.querySelectorAll('[data-cr-chart-view]')]
  const shapeOf = (v) => [...v.querySelectorAll('rect')].map((r) => r.getAttribute('height')).join(',')

  const before = views.findIndex((v) => !v.hasAttribute('hidden'))
  group.querySelectorAll('[data-cr-chart-tab]')[2].click()
  const after = views.findIndex((v) => !v.hasAttribute('hidden'))

  return {
    labels: [...group.querySelectorAll('[data-cr-chart-tab]')].map((b) => b.textContent),
    views: views.length,
    distinct: new Set(views.map(shapeOf)).size,
    shownAtFirst: before,
    shownAfterClick: after,
    visibleCount: views.filter((v) => !v.hasAttribute('hidden')).length,
    pressed: [...group.querySelectorAll('[data-cr-chart-tab]')].map((b) => b.getAttribute('aria-pressed')),
  }
})
check('views behind the page switches are captured', toggles.views === 3, `${toggles.views ?? toggles.error} views`)
check('each captured view holds different data', toggles.distinct === 3, `${toggles.distinct} distinct`)
check('the switch labels come from the page', toggles.labels?.join(',') === 'Speed,Accuracy,Cost', toggles.labels?.join(','))
check('only one view is shown at a time', toggles.visibleCount === 1, `${toggles.visibleCount} visible`)
check('clicking a switch changes the chart', toggles.shownAtFirst === 0 && toggles.shownAfterClick === 2,
  `${toggles.shownAtFirst} -> ${toggles.shownAfterClick}`)
check('the pressed switch is marked for assistive tech', toggles.pressed?.join(',') === 'false,false,true',
  toggles.pressed?.join(','))

// driving the page's controls must leave the page as it was found
const liveTabs = await page.evaluate(() =>
  [...document.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('aria-selected')).join(','))
check('the live page is left on its original view', liveTabs === 'true,false,false', liveTabs)

// Markdown cannot draw an SVG, and Turndown keeps unknown elements' text --
// which spilled every axis tick, from hidden views too, into the prose.
const chartArticle = await send({ type: 'cleanread/get-article' })
const chartMd = chartArticle?.ok ? toMarkdown(chartArticle.article) : ''
check('markdown names each chart instead of spilling its axis labels',
  /\*\[Chart/.test(chartMd) && !/Estimated API cost|Context length/.test(chartMd),
  chartMd.split('\n').find((l) => l.includes('[Chart')) ?? 'no chart placeholder')
check('markdown lists the chart views once', (chartMd.match(/Chart views:/g) ?? []).length === 1,
  chartMd.split('\n').find((l) => l.includes('Chart views:')) ?? 'none')
await page.screenshot({ path: path.join(SHOTS, '10-media.png') })
await send({ type: 'cleanread/restore-page' })

// --- an article with too few headings gets no rail at all
await page.goto('http://127.0.0.1:8781/short', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)
const shortResult = await send({ type: 'cleanread/clean-page' })
check('short article still cleans', shortResult?.ok === true, shortResult?.title ?? shortResult?.reason)
await page.waitForTimeout(300)
check(
  'no contents rail when under 3 headings',
  (await page.locator('#cleanread-root .cr-toc').count()) === 0,
)
await page.screenshot({ path: path.join(SHOTS, '5-short-no-toc.png') })
await send({ type: 'cleanread/restore-page' })

// --- 7. the popup UI itself renders
const popup = await ctx.newPage()
await popup.goto(`chrome-extension://${extId}/src/popup/index.html`)
await popup.waitForTimeout(900)
const popupText = await popup.locator('.popup').innerText().catch(() => '')
check('popup React app mounted', popupText.includes('CleanRead'))
await popup.screenshot({ path: path.join(SHOTS, '3-popup.png') })
await popup.close()

// --- 8. a real page off the public internet (skipped when offline)
try {
  await page.goto('https://en.wikipedia.org/wiki/Attention_span', {
    waitUntil: 'domcontentloaded',
    timeout: 25000,
  })
  await page.waitForTimeout(1500)
  const realResult = await send({ type: 'cleanread/clean-page' })
  check('real article extracted', realResult?.ok === true, realResult?.title ?? realResult?.reason)
  await page.waitForTimeout(600)
  const realText = await page.locator('#cleanread-root .cr-surface').innerText()
  check('real article has substantial body', realText.length > 1500, `${realText.length} chars`)
  await page.screenshot({ path: path.join(SHOTS, '4-real-article.png') })
} catch (e) {
  log('SKIP  real-page test -- ' + e.message.split('\n')[0])
}

// --- 9. surviving an extension reload
// Reloading the extension (every rebuild, and every Web Store auto-update) tears
// the content script out of tabs that are already open, and Chrome does not put
// it back. The popup used to blame the page; it must now re-inject instead.
await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)

await cdp.send('Extensions.loadUnpacked', { path: EXT })
await page.waitForTimeout(1500)
const sw2 = await workerFor(loadedId)

const healed = await sw2.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'cleanread/get-state' })
    return res && typeof res === 'object' ? 'reached' : `replied ${String(res)}`
  } catch (e) {
    return String(e)
  }
})
check('an already-open tab is reachable again after an extension reload', healed === 'reached', healed)

const reloadPopup = await ctx.newPage()
await reloadPopup.goto(`chrome-extension://${extId}/src/popup/index.html`)
await reloadPopup.waitForTimeout(700)
await page.bringToFront()
await reloadPopup.waitForTimeout(300)
await reloadPopup.evaluate(() => document.querySelector('.popup__primary').click())
await reloadPopup.waitForTimeout(2500)

// the popup's own fallback, for a tab the worker missed (asleep, discarded):
// this exact call used to throw "Cannot access contents of the page"
const canInject = await reloadPopup.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? []
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files })
    return 'ok'
  } catch (e) {
    return String(e)
  }
})
check('the popup can re-inject on demand (fallback path)', canInject === 'ok', canInject)

check('popup recovers an orphaned tab instead of erroring',
  (await reloadPopup.locator('.popup__error').count()) === 0,
  (await reloadPopup.locator('.popup__error').count())
    ? await reloadPopup.locator('.popup__error').innerText()
    : 'no error shown')
check('cleaning works after an extension reload, with no page reload',
  await page.locator('#cleanread-root .cr-surface').isVisible())

// a tab carrying both injections must not answer twice
const listeners = await page.evaluate(() => Boolean(window.__cleanReadListening))
check('the re-injection guard is set (one listener per frame)', listeners === false,
  `page-world flag visible: ${listeners}`)
const doubleSend = await sw2.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'cleanread/get-state' })
  return res && typeof res === 'object' ? 'single object reply' : String(res)
})
check('a re-injected tab answers each message once', doubleSend === 'single object reply', doubleSend)
await reloadPopup.screenshot({ path: path.join(SHOTS, '8-popup-after-reload.png') })
await reloadPopup.close()

log('\npage console errors: ' + (pageErrors.length ? JSON.stringify(pageErrors, null, 2) : 'none'))
log(`screenshots: ${SHOTS}`)
log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)

await ctx.close()
server.close()
process.exit(failures === 0 ? 0 : 1)
