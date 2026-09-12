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

  return standInForCharts(clone)
}

/** A 1x1 transparent GIF. Only ever a placeholder; never rendered. */
const BLANK_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/**
 * Paint properties that a chart gets from a stylesheet rather than from
 * attributes. Vega, D3, Recharts and friends colour their marks with CSS (often
 * through custom properties), and none of that survives into a shadow root that
 * deliberately does not load the page's styles.
 */
const SVG_PAINT_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'display',
  'visibility',
]

/**
 * Resolve the live element's computed paint onto the clone as inline style.
 *
 * The clone is about to lose every class (stripClasses) and will be rendered
 * inside a shadow root that the page's stylesheet cannot reach, so anything
 * still described by CSS would render as an unstyled black-on-black shape.
 * Walking both trees by index works because `copy` is a clone of `live`.
 */
function freezeSvgPaint(live, copy) {
  const liveNodes = [live, ...live.querySelectorAll('*')]
  const copyNodes = [copy, ...copy.querySelectorAll('*')]

  for (let i = 0; i < liveNodes.length && i < copyNodes.length; i++) {
    const computed = getComputedStyle(liveNodes[i])
    let declarations = copyNodes[i].getAttribute('style') ?? ''
    for (const prop of SVG_PAINT_PROPS) {
      const value = computed.getPropertyValue(prop)
      if (value) declarations += `${declarations && !declarations.endsWith(';') ? ';' : ''}${prop}:${value}`
    }
    if (declarations) copyNodes[i].setAttribute('style', declarations)
    // a <style> block inside the chart cannot reach it once it is inline-styled,
    // and Readability would strip it anyway
    if (copyNodes[i].tagName?.toLowerCase() === 'style') copyNodes[i].textContent = ''
  }
}

/**
 * Swap every chart-sized inline <svg> for an <img> placeholder, and hand back
 * the SVGs so they can be put back after extraction.
 *
 * Readability counts `img`, `embed`, `object` and `iframe` as media when it
 * decides whether a container is empty — it has no notion of `svg`. A chart
 * library renders one big `<svg>` inside a bare `<div>`, so that div scores as
 * an empty node and the whole chart is deleted. This is why charts vanished on
 * pages whose text came through perfectly.
 *
 * Icons are left alone: they are small, and turning thousands of them into
 * placeholders would be pointless work.
 */
function standInForCharts(clone) {
  const liveSvgs = [...document.querySelectorAll('svg')]
  const clonedSvgs = [...clone.querySelectorAll('svg')]
  const charts = new Map()

  for (let i = 0; i < clonedSvgs.length && i < liveSvgs.length; i++) {
    const live = liveSvgs[i]
    const copy = clonedSvgs[i]
    const rect = live.getBoundingClientRect()
    if (rect.width < MEDIA_MIN_WIDTH || rect.height < MEDIA_MIN_HEIGHT) continue

    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    freezeSvgPaint(live, copy)
    if (!copy.getAttribute('viewBox')) copy.setAttribute('viewBox', `0 0 ${width} ${height}`)
    // the chart must scale with the reader column, not with whatever pixel width
    // the original site happened to give it
    copy.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    // Keep the size the page actually drew it at. Dropping width/height and
    // letting CSS stretch it to the column turns a tall chart into a screen-high
    // one; the stylesheet scales it down instead, never up.
    copy.setAttribute('width', String(width))
    copy.setAttribute('height', String(height))
    copy.setAttribute('data-cr-chart', `${width}x${height}`)
    // The marks were coloured for the background the site drew them on. On a
    // dark site the axis labels are white, and dropping them onto the reader's
    // light page makes the chart look empty. Bring the background along.
    const backdrop = chartBackdrop(live)
    if (backdrop) copy.style.background = backdrop

    const key = String(charts.size)
    charts.set(key, { svg: copy, options: chartOptions(live) })

    const placeholder = clone.createElement('img')
    placeholder.setAttribute('src', BLANK_PIXEL)
    placeholder.setAttribute('data-cr-chart-slot', key)
    // real dimensions, so the junk scrub reads this as content-sized media
    placeholder.setAttribute('width', String(width))
    placeholder.setAttribute('height', String(height))
    placeholder.setAttribute('alt', chartLabel(live))
    copy.replaceWith(placeholder)
    rescueChartWrapper(placeholder)
  }

  return charts
}

/**
 * Stop Readability from deleting the box the chart sits in.
 *
 * Two things sink a chart container, and both are scored before anything looks
 * at what it contains:
 *
 *  1. `_getClassWeight` subtracts 25 for a class matching its negative list --
 *     which includes `scroll`, `media`, `share`, `promo` and `related` as bare
 *     substrings. A utility class like `scroll-mt-anchor-offset` (scroll-margin,
 *     from Tailwind) is enough, and `weight + contentScore < 0` removes the node
 *     outright. That list was written for 2010 markup; today's utility classes
 *     collide with it constantly.
 *  2. `input > Math.floor(p / 3)` removes a container holding form controls and
 *     no paragraphs -- exactly what a chart with switches looks like.
 *
 * So the ancestry between the chart and its figure is stripped of class and id,
 * and the chart's now-inert controls are removed. Their labels are read first
 * (chartOptions) so the reader can still say what the original offered.
 *
 * This is narrow on purpose: it only touches ancestors of a confirmed,
 * content-sized chart, never the page at large.
 */
function rescueChartWrapper(placeholder) {
  for (const control of chartWrapper(placeholder).querySelectorAll('button, select, input, textarea, form, style')) {
    control.remove()
  }
  for (const el of chartAncestors(placeholder)) {
    el.removeAttribute('class')
    el.removeAttribute('id')
  }
}

/** The chart's own box: its figure, or a few levels up when it has none. */
function chartWrapper(node) {
  return node.closest?.('figure') ?? node.parentElement ?? node
}

/** Everything from the chart up to (and including) its figure, bounded. */
function chartAncestors(node) {
  const chain = []
  let el = node.parentElement
  for (let depth = 0; el && el.tagName !== 'BODY' && depth < 8; depth++) {
    chain.push(el)
    if (el.tagName === 'FIGURE') break
    el = el.parentElement
  }
  return chain
}

/**
 * What the original page let you switch between.
 *
 * A static reading view cannot re-run the site's charting code, so the choices
 * cannot be made live. Recording them at least means the reader does not
 * silently present one series as if it were the whole picture.
 */
function chartOptions(liveSvg) {
  const wrapper = liveSvg.closest('figure') ?? liveSvg.parentElement?.parentElement
  if (!wrapper) return []

  const labels = new Set()
  for (const tab of wrapper.querySelectorAll('[role="tab"], select option, button')) {
    const text = tab.textContent?.replace(/\s+/g, ' ').trim()
    if (text && text.length <= 40) labels.add(text)
  }
  return [...labels].slice(0, 12)
}

/**
 * Rough perceived lightness, 0 (black) to 1 (white), or null if unreadable.
 * Handles the forms getComputedStyle actually returns, including the oklab/oklch
 * that modern sites author in -- whose first component already IS lightness.
 */
function lightnessOf(colour) {
  if (!colour) return null
  const oklab = colour.match(/^okl(?:ab|ch)\(\s*([\d.]+)%?/i)
  if (oklab) return Number(oklab[1]) > 1 ? Number(oklab[1]) / 100 : Number(oklab[1])

  const rgb = colour.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map(Number)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  }

  const hex = colour.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  }
  return null
}

/**
 * A chart drawn for a dark site has light ink, and light ink on the reader's
 * pale page is invisible -- the marks were there and the axis labels were not.
 *
 * Rather than guess at a background (chart containers stack translucent
 * overlays, so the nearest painted ancestor is usually a 20%-black veil, not
 * the real surface), decide from the chart's own ink and give it a panel only
 * when it needs one.
 */
function chartBackdrop(liveSvg) {
  const inks = []
  for (const node of [...liveSvg.querySelectorAll('text')].slice(0, 24)) {
    const value = lightnessOf(getComputedStyle(node).fill)
    if (value !== null) inks.push(value)
  }
  if (!inks.length) return null

  inks.sort((a, b) => a - b)
  const median = inks[Math.floor(inks.length / 2)]
  if (median < 0.55) return null // dark ink: the reader's own page suits it

  // Light ink needs a dark panel. Prefer the page's real surface when it is
  // dark, so the chart keeps looking like it did on the original site.
  const pageColour = getComputedStyle(document.body).backgroundColor
  const pageLightness = lightnessOf(pageColour)
  return pageLightness !== null && pageLightness < 0.4 ? pageColour : '#16161a'
}

/** Charts usually label themselves for screen readers; fall back to the caption. */
function chartLabel(svg) {
  return (
    svg.getAttribute('aria-label') ??
    svg.querySelector('title')?.textContent?.trim() ??
    svg.closest('figure')?.querySelector('figcaption')?.textContent?.trim()?.slice(0, 120) ??
    'Chart'
  )
}

/** Put the real charts back where their placeholders survived extraction. */
function restoreCharts(container, charts) {
  const doc = container.ownerDocument
  for (const slot of container.querySelectorAll('img[data-cr-chart-slot]')) {
    const entry = charts.get(slot.getAttribute('data-cr-chart-slot'))
    if (!entry) {
      slot.remove()
      continue
    }

    const chart = doc.importNode(entry.svg, true)
    if (!entry.options.length) {
      slot.replaceWith(chart)
      continue
    }

    // Say what the original offered, rather than passing one series off as all
    // of them. Plain DOM -- content scripts hold no React (CLAUDE.md).
    const figure = doc.createElement('div')
    figure.setAttribute('data-cr-chart-group', '')
    figure.append(chart)
    const note = doc.createElement('p')
    note.setAttribute('data-cr-chart-options', '')
    note.textContent = `Shown: ${entry.options[0]}. The original page also offered ${entry.options
      .slice(1)
      .join(', ')} — open it to switch between them.`
    figure.append(note)
    slot.replaceWith(figure)
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
  const charts = inlineLiveMedia(clone)
  // keepClasses: Readability strips class attributes by default, which would
  // leave scrubJunk() with nothing to match on but its text heuristic.
  const parsed = new Readability(clone, { keepClasses: true }).parse()
  if (!parsed?.content) return null

  // DOMParser never executes scripts, so this is safe to scrub in.
  const doc = new DOMParser().parseFromString(parsed.content, 'text/html')
  scrubJunk(doc.body, furniture, media.big)
  dropTrackingPixels(doc.body, media.tiny)
  // after the pixel sweep, so a chart placeholder is never mistaken for a beacon
  restoreCharts(doc.body, charts)
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
