/**
 * DOM cleaning logic. Pure DOM only -- no React in content scripts.
 *
 * Strategy: we do NOT rewrite the host page's DOM in place (fragile, and it
 * makes restoring hard). We extract the article with Readability from a CLONE,
 * scrub the leftover junk Readability keeps, then paint our own overlay above
 * the page inside a shadow root so the host page's CSS cannot reach it.
 */
import { Readability, isProbablyReaderable } from '@mozilla/readability'
import browser from '../lib/browser.js'
import { MSG } from '../lib/messages.js'
import { readingTimeMinutes } from '../lib/reading-time.js'
import readerCss from './reader.css?inline'

export const ROOT_ID = 'cleanread-root'
const HTML_FLAG = 'cleanreadActive'

/**
 * Junk tokens come in two strengths, because "banner" means a cookie bar on one
 * site and the hero image of the article on another.
 *
 * ADVERTISING is never content, whatever it contains.
 */
const AD_TOKEN =
  /^(ad|ads|adslot|advert|adsense|advertisement|sponsor|sponsored|outbrain|taboola|doubleclick)$/i

/**
 * FURNITURE is usually not content -- but only when it carries no real picture.
 * `<figure class="article-banner">` around the headline chart is content, and
 * deleting it is how graphs went missing from pages that lead with an image.
 * Matched per token, so "header-ad" hits on `ad` but "badge" does not.
 */
const FURNITURE_TOKEN =
  /^(promo|promoted|newsletter|subscribe|subscription|signup|social|share|sharing|related|recommended|comment|comments|disqus|popup|modal|cookie|consent|banner|paywall|editsection)$/i

const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Text belonging to `fixed`/`sticky` elements on the LIVE page -- cookie bars,
 * sticky nav, newsletter popups. Readability often unwraps these into bare
 * <p> tags with no class left to match on, so identify them by their text
 * before extraction rather than guessing at keywords afterwards.
 */
function overlayTexts() {
  const texts = new Set()
  for (const el of document.body.querySelectorAll('*')) {
    if (el.id === ROOT_ID || el.closest(`#${ROOT_ID}`)) continue
    const { position } = getComputedStyle(el)
    if (position !== 'fixed' && position !== 'sticky') continue

    const t = norm(el.textContent)
    // a very long match would be a layout wrapper, not a banner
    if (t && t.length < 400) texts.add(t)
  }
  return texts
}

/** Below this, a picture is decoration rather than part of the article. */
const MEDIA_MIN_WIDTH = 200
const MEDIA_MIN_HEIGHT = 100

/**
 * Measures every image on the LIVE page, because a detached clone has no
 * layout and no loaded bitmaps. Returns the sources worth keeping and the
 * tracking pixels worth dropping.
 */
function collectMedia() {
  const big = new Set()
  const tiny = new Set()

  for (const img of document.images) {
    if (img.closest(`#${ROOT_ID}`)) continue
    const box = img.getBoundingClientRect()
    const w = Math.max(box.width, img.naturalWidth)
    const h = Math.max(box.height, img.naturalHeight)

    for (const key of [img.currentSrc, img.getAttribute('src')]) {
      if (!key) continue
      if (w >= MEDIA_MIN_WIDTH && h >= MEDIA_MIN_HEIGHT) big.add(key)
      else if (w > 0 && w <= 2 && h <= 2) tiny.add(key)
    }
  }
  return { big, tiny }
}

/** A 1x1 spacer or an inline placeholder standing in for the real picture. */
function looksLikePlaceholder(img) {
  return img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight <= 2
}

/**
 * Bakes what the page actually rendered into the clone, before Readability
 * sees it. Two things are lost by `cloneNode` alone:
 *
 *  - a lazy-loaded <img> keeps whatever `src` it was born with, so the reader
 *    would show the placeholder rather than the chart that replaced it
 *  - a <canvas> clones as an empty canvas -- the drawing does not come with it,
 *    which is why script-drawn graphs arrived blank
 */
function inlineLiveMedia(clone) {
  const liveImgs = [...document.images]
  const clonedImgs = [...clone.images]

  for (let i = 0; i < clonedImgs.length && i < liveImgs.length; i++) {
    const live = liveImgs[i]
    const copy = clonedImgs[i]

    const lazy =
      live.getAttribute('data-src') ??
      live.getAttribute('data-lazy-src') ??
      live.getAttribute('data-original')
    const resolved = looksLikePlaceholder(live) && lazy ? lazy : live.currentSrc || live.getAttribute('src')

    if (resolved) {
      copy.setAttribute('src', resolved)
      // src now holds the exact file the page chose; a stale srcset would let
      // the browser pick a different (often placeholder) candidate instead
      copy.removeAttribute('srcset')
      copy.removeAttribute('loading')
    }
  }

  const liveCanvases = [...document.querySelectorAll('canvas')]
  const clonedCanvases = [...clone.querySelectorAll('canvas')]

  for (let i = 0; i < clonedCanvases.length && i < liveCanvases.length; i++) {
    const live = liveCanvases[i]
    const copy = clonedCanvases[i]
    if (live.width < MEDIA_MIN_WIDTH) continue

    let url
    try {
      url = live.toDataURL('image/png')
    } catch {
      continue // tainted by cross-origin drawing; nothing we can do
    }

    const img = clone.createElement('img')
    img.setAttribute('src', url)
    img.setAttribute('width', String(live.width))
    img.setAttribute('height', String(live.height))
    img.setAttribute('alt', live.getAttribute('aria-label') ?? 'Chart')
    copy.replaceWith(img)
  }
}

/** Spacers and analytics beacons are not article content. */
function dropTrackingPixels(container, tinyMedia) {
  for (const img of [...container.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? ''
    const w = Number(img.getAttribute('width'))
    const h = Number(img.getAttribute('height'))
    if (tinyMedia.has(src) || (w && h && w <= 2 && h <= 2)) img.remove()
  }
}

function tokensOf(el) {
  const raw = [...el.classList, el.id].filter(Boolean)
  return raw.flatMap((t) => t.split(/[-_\s]+/)).filter(Boolean)
}

/**
 * Does this block carry a real picture? A caption, or an image/chart that the
 * live page rendered at a content-ish size, means it is worth keeping even if
 * its class says "banner" or "promo".
 */
function holdsContentMedia(el, bigMedia) {
  if (el.querySelector('figcaption')) return true

  for (const img of el.querySelectorAll('img')) {
    if (bigMedia.has(img.getAttribute('src') ?? '')) return true
    if (Number(img.getAttribute('width')) >= MEDIA_MIN_WIDTH) return true
  }
  for (const el2 of el.querySelectorAll('svg, canvas, video')) {
    if (el2.tagName === 'VIDEO') return true
    if (Number(el2.getAttribute('width')) >= MEDIA_MIN_WIDTH) return true
  }
  return false
}

function isJunk(el, furniture, bigMedia) {
  const tokens = tokensOf(el)
  if (tokens.some((t) => AD_TOKEN.test(t))) return true

  // everything below this line spares blocks that carry a real picture
  const hasMedia = holdsContentMedia(el, bigMedia)
  if (tokens.some((t) => FURNITURE_TOKEN.test(t))) return !hasMedia

  const text = el.textContent.trim()
  // it was floating over the page, so it is not part of the article
  if (furniture.has(norm(text))) return !hasMedia
  // short blocks that announce themselves, e.g. "ADVERTISEMENT - ..."
  return text.length < 200 && /^(advertisement|advert|sponsored|promoted)\b/i.test(text)
}

/**
 * Records which elements are maths, and whether they belong in the line of
 * text or on a line of their own, as `data-cr-math`.
 *
 * This has to run BEFORE stripClasses(): the only thing identifying an SVG as
 * maths is the class the site put on it (`mwe-math-fallback-image-inline`,
 * `katex`, ...). Once that is gone, an equation is indistinguishable from a
 * photograph, and inline maths ends up centred on its own line mid-sentence.
 */
function tagMath(container) {
  for (const img of container.querySelectorAll('img')) {
    const own = img.getAttribute('class') ?? ''
    const wrapper = img.closest('[class*="math" i]')?.getAttribute('class') ?? ''
    const cls = `${own} ${wrapper}`
    if (!/math/i.test(cls)) continue

    img.dataset.crMath = /display/i.test(cls) ? 'display' : 'inline'
    // MediaWiki hides the accessible MathML twin, so Readability drops it and
    // this image is the only rendering left. Un-hide it so a screen reader can
    // at least reach the LaTeX in its alt text.
    img.removeAttribute('aria-hidden')
  }

  // MathML, KaTeX and MathJax, when they survive extraction
  for (const el of container.querySelectorAll('math')) {
    el.dataset.crMath = el.getAttribute('display') === 'block' ? 'display' : 'inline'
  }
  for (const el of container.querySelectorAll('.katex-display, mjx-container[display="true"]')) {
    el.dataset.crMath = 'display'
  }
  for (const el of container.querySelectorAll('.katex, mjx-container')) {
    if (!el.dataset.crMath && !el.closest('[data-cr-math="display"]')) el.dataset.crMath = 'inline'
  }
}

/** The site's own classes are dead weight once the scrub has used them. */
function stripClasses(container) {
  for (const el of container.querySelectorAll('[class]')) el.removeAttribute('class')
}

/**
 * Readability scores for prose; it keeps short promo blocks sitting inside the
 * article. Strip those from the extracted markup before we render it.
 */
function scrubJunk(container, furniture = new Set(), bigMedia = new Set()) {
  for (const el of [...container.querySelectorAll('*')]) {
    if (!el.isConnected) continue
    if (isJunk(el, furniture, bigMedia)) el.remove()
  }
  return container
}

/**
 * FNV-1a over normalised text. Highlights are keyed by what a paragraph SAYS,
 * not where it sits, so they survive re-extraction and minor page edits.
 * Collisions just mean two identical paragraphs highlight together -- harmless.
 */
function hashText(text) {
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase()
  let h = 0x811c9dc5
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Tags a paragraph with its content hash, which also makes it clickable. */
function markHighlightable(body) {
  for (const el of body.querySelectorAll('p, blockquote')) {
    const text = el.textContent.trim()
    if (!text) continue
    el.dataset.crHash = hashText(text)
  }
}

/** Selection lives in the shadow root, not the document, in Chrome. */
function selectionIsCollapsed(node) {
  const root = node.getRootNode()
  const sel = root.getSelection ? root.getSelection() : document.getSelection()
  return !sel || sel.isCollapsed
}

function persistHighlights(body, url) {
  const hashes = [...body.querySelectorAll('.is-highlighted[data-cr-hash]')].map(
    (el) => el.dataset.crHash,
  )
  // Fire and forget -- the worker owns IndexedDB, see src/background/index.js.
  browser.runtime.sendMessage({ type: MSG.SET_HIGHLIGHTS, url, hashes }).catch(() => {})
}

function attachHighlighting(body, url) {
  browser.runtime
    .sendMessage({ type: MSG.GET_HIGHLIGHTS, url })
    .then((res) => {
      if (!res?.ok) return
      const saved = new Set(res.hashes)
      for (const el of body.querySelectorAll('[data-cr-hash]')) {
        if (saved.has(el.dataset.crHash)) el.classList.add('is-highlighted')
      }
    })
    .catch(() => {})

  body.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-cr-hash]')
    if (!el || !body.contains(el)) return
    if (e.target.closest('a')) return // a link is still a link
    if (!selectionIsCollapsed(body)) return // never fight a text selection

    el.classList.toggle('is-highlighted')
    persistHighlights(body, url)
  })
}

/** Below this, a contents rail is more chrome than help. */
const TOC_MIN_HEADINGS = 3

function slugify(text) {
  const base = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return `cr-${base || 'section'}`
}

/**
 * Assigns a stable id to every heading and returns the TOC model.
 * Ids only have to be unique inside the shadow root, so they can never collide
 * with the host page's own ids.
 */
function buildToc(container) {
  const used = new Set()
  const items = []

  for (const heading of container.querySelectorAll('h2, h3')) {
    const text = heading.textContent.trim()
    if (!text) continue

    let id = heading.id || slugify(text)
    const base = id
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    heading.id = id

    items.push({ id, text, level: Number(heading.tagName[1]) })
  }

  return items
}

/** Elements that commonly float above everything: cookie bars, sticky nav, popups. */
function neutraliseOverlays() {
  const killed = []
  for (const el of document.body.querySelectorAll('*')) {
    if (el.id === ROOT_ID || el.closest(`#${ROOT_ID}`)) continue
    const { position } = getComputedStyle(el)
    if (position === 'fixed' || position === 'sticky') {
      killed.push([el, el.style.display])
      el.style.display = 'none'
    }
  }
  return killed
}

/** Stop media that keeps playing behind the reader view. */
function silencePage() {
  for (const media of document.querySelectorAll('video, audio')) {
    if (!media.paused) media.pause()
  }
}

/**
 * Run Readability against a clone so the live page is never mutated.
 * @returns {null | {title:string,content:string,textContent:string,byline:string,
 *   siteName:string,excerpt:string,readingTimeMinutes:number,url:string}}
 */
export function extractArticle() {
  // must be read from the LIVE document -- a clone has no computed styles
  const furniture = overlayTexts()
  const media = collectMedia()
  const clone = document.cloneNode(true)
  // bake in what the page actually rendered before Readability sees the clone
  inlineLiveMedia(clone)
  // keepClasses: Readability strips class attributes by default, which would
  // leave scrubJunk() with nothing to match on but its text heuristic.
  const parsed = new Readability(clone, { keepClasses: true }).parse()
  if (!parsed?.content) return null

  // DOMParser never executes scripts, so this is safe to scrub in.
  const doc = new DOMParser().parseFromString(parsed.content, 'text/html')
  scrubJunk(doc.body, furniture, media.big)
  dropTrackingPixels(doc.body, media.tiny)
  tagMath(doc.body) // must precede stripClasses -- it reads the site's classes
  stripClasses(doc.body) // classes were only needed for the scrub
  // must run after the scrub, so removed sections never reach the contents rail
  const toc = buildToc(doc.body)

  const textContent = doc.body.textContent ?? ''

  return {
    title: parsed.title || document.title,
    content: doc.body.innerHTML,
    textContent,
    toc,
    byline: parsed.byline ?? '',
    siteName: parsed.siteName ?? location.hostname,
    excerpt: parsed.excerpt ?? '',
    readingTimeMinutes: readingTimeMinutes(textContent),
    url: location.href,
  }
}

export function canCleanPage() {
  return isProbablyReaderable(document)
}

/**
 * Custom properties are set on the host element; they inherit through the
 * shadow boundary, so the stylesheet inside can read them.
 */
export function applySettings(settings) {
  const host = document.getElementById(ROOT_ID)
  if (!host) return
  host.dataset.theme = settings.theme
  host.style.setProperty('--cr-font-size', `${settings.fontSize}px`)
  host.style.setProperty('--cr-line-height', String(settings.lineHeight))
  host.style.setProperty('--cr-width', `${settings.contentWidth}px`)

  // Type size and column width reflow the article, which moves every heading.
  // Without this the active entry stays stale until the reader next scrolls.
  requestAnimationFrame(() => tocHandle?.sync())
}

const PRINT_STYLE_ID = 'cleanread-print-style'

/**
 * Printing the overlay as-is gives one clipped page with the host page beneath
 * it. Two things are needed: hide the page (a stylesheet can do that), and
 * un-fix our host (a stylesheet cannot -- inline `!important` outranks it, so
 * the layout properties are swapped in JS and put back afterwards).
 *
 * Custom properties live on the same inline style, so only the specific layout
 * properties are touched; never reset cssText or the theme goes with it.
 */
function installPrintSupport(host) {
  const style = document.createElement('style')
  style.id = PRINT_STYLE_ID
  style.textContent = `@media print {
    html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
    body > *:not(#${ROOT_ID}) { display: none !important; }
  }`
  document.head.append(style)

  const onBefore = () => {
    host.style.setProperty('position', 'static', 'important')
    host.style.setProperty('inset', 'auto', 'important')
    host.style.setProperty('height', 'auto', 'important')
    host.style.setProperty('overflow', 'visible', 'important')
  }
  const onAfter = () => {
    host.style.setProperty('position', 'fixed', 'important')
    host.style.setProperty('inset', '0', 'important')
    host.style.removeProperty('height')
    host.style.removeProperty('overflow')
  }

  window.addEventListener('beforeprint', onBefore)
  window.addEventListener('afterprint', onAfter)

  return () => {
    window.removeEventListener('beforeprint', onBefore)
    window.removeEventListener('afterprint', onAfter)
    document.getElementById(PRINT_STYLE_ID)?.remove()
  }
}

let hiddenOverlays = []
/** Teardown for the print hooks; cleared in removeReader(). */
let detachPrint = null
/** { detach, sync } for the contents rail; torn down in removeReader(). */
let tocHandle = null

/**
 * Builds the contents rail and keeps its active item in sync with scrolling.
 * Returns { detach, sync }, or null when the article has too few headings.
 */
function renderToc(shadow, surface, toc) {
  if (toc.length < TOC_MIN_HEADINGS) return null

  const nav = document.createElement('nav')
  nav.className = 'cr-toc'

  const head = document.createElement('div')
  head.className = 'cr-toc-head'

  const label = document.createElement('span')
  label.className = 'cr-toc-label'
  label.textContent = 'Contents'

  const toggle = document.createElement('button')
  toggle.className = 'cr-toc-toggle'
  toggle.type = 'button'
  toggle.setAttribute('aria-label', 'Hide contents')
  toggle.textContent = '−'
  toggle.addEventListener('click', () => {
    const collapsed = nav.toggleAttribute('data-collapsed')
    toggle.textContent = collapsed ? '≡' : '−'
    toggle.setAttribute('aria-label', collapsed ? 'Show contents' : 'Hide contents')
  })

  head.append(label, toggle)

  const list = document.createElement('ol')
  list.className = 'cr-toc-list'

  const links = []
  for (const item of toc) {
    const li = document.createElement('li')
    li.className = 'cr-toc-item'
    li.dataset.level = String(item.level)

    const link = document.createElement('a')
    link.className = 'cr-toc-link'
    link.href = `#${item.id}`
    link.textContent = item.text
    link.addEventListener('click', (e) => {
      e.preventDefault()
      // ids live in the shadow root, so resolve there rather than in the document
      shadow.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })

    li.append(link)
    list.append(li)
    links.push({ id: item.id, link })
  }

  nav.append(head, list)
  shadow.append(nav)

  // --- scroll spy: the active item is the last heading scrolled past
  let queued = false
  const sync = () => {
    queued = false
    const cutoff = surface.getBoundingClientRect().top + 80
    let activeId = links[0]?.id

    for (const { id } of links) {
      const heading = shadow.getElementById(id)
      if (heading && heading.getBoundingClientRect().top <= cutoff) activeId = id
      else break
    }

    // The last sections can never reach the cutoff -- the container runs out of
    // scroll first -- so clicking the final entry would leave an earlier one
    // marked. At the bottom, the last heading is by definition on screen.
    const scrollable = surface.scrollHeight - surface.clientHeight > 4
    const atBottom = surface.scrollHeight - surface.scrollTop - surface.clientHeight <= 2
    if (scrollable && atBottom) activeId = links[links.length - 1].id

    for (const { id, link } of links) link.classList.toggle('is-active', id === activeId)
  }

  const onScroll = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(sync)
  }

  surface.addEventListener('scroll', onScroll, { passive: true })
  sync()

  return { detach: () => surface.removeEventListener('scroll', onScroll), sync }
}

export function renderReader(article, settings) {
  removeReader()

  const host = document.createElement('div')
  host.id = ROOT_ID
  // Inline + !important: the host page cannot move, hide or restyle the shell.
  host.style.cssText = [
    'all: initial !important',
    'position: fixed !important',
    'inset: 0 !important',
    'z-index: 2147483647 !important',
    'display: block !important',
  ].join(';')

  // Shadow root is what actually keeps the page's CSS out of the article.
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = readerCss

  const surface = document.createElement('div')
  surface.className = 'cr-surface'

  const header = document.createElement('header')
  header.className = 'cr-header'

  const h1 = document.createElement('h1')
  h1.className = 'cr-title'
  h1.textContent = article.title

  const sub = document.createElement('p')
  sub.className = 'cr-meta'
  sub.textContent = [article.siteName, article.byline, `${article.readingTimeMinutes} min read`]
    .filter(Boolean)
    .join(' · ')

  header.append(h1, sub)

  const body = document.createElement('article')
  body.className = 'cr-content'
  // Readability sanitised this markup and scrubJunk trimmed it further.
  body.innerHTML = article.content
  markHighlightable(body)

  surface.append(header, body)
  shadow.append(style, surface)
  document.body.append(host)

  tocHandle = renderToc(shadow, surface, article.toc ?? [])
  attachHighlighting(body, article.url)
  detachPrint = installPrintSupport(host)

  hiddenOverlays = neutraliseOverlays()
  silencePage()
  document.documentElement.dataset[HTML_FLAG] = 'true'
  document.documentElement.style.overflow = 'hidden'

  applySettings(settings)
  return host
}

export function removeReader() {
  tocHandle?.detach()
  tocHandle = null
  detachPrint?.()
  detachPrint = null
  document.getElementById(ROOT_ID)?.remove()

  for (const [el, display] of hiddenOverlays) el.style.display = display
  hiddenOverlays = []

  delete document.documentElement.dataset[HTML_FLAG]
  document.documentElement.style.overflow = ''
}

export function isReaderActive() {
  return Boolean(document.getElementById(ROOT_ID))
}
