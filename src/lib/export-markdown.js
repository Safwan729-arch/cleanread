/**
 * HTML -> Markdown for the cleaned article, via Turndown.
 *
 * Input is the already-extracted, already-scrubbed `article.content`, so this
 * never has to reason about page junk -- see notes/features/reader-view.md.
 */
import TurndownService from 'turndown'

function service() {
  const td = new TurndownService({
    headingStyle: 'atx', //  ## Heading, not underlines
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
  })

  // Turndown drops figcaption text into the flow, which reads as a stray
  // sentence. Keep it, but mark it as a caption.
  td.addRule('figcaption', {
    filter: 'figcaption',
    replacement: (content) => (content.trim() ? `\n\n*${content.trim()}*\n\n` : ''),
  })

  // Maths would otherwise become `![{\displaystyle ...}](…svg)` -- an image of
  // an equation. The alt text IS the LaTeX source, so emit that instead: real
  // maths that Obsidian and most Markdown renderers will typeset.
  td.addRule('math', {
    filter: (node) => node.nodeName === 'IMG' && node.hasAttribute('data-cr-math'),
    replacement: (_content, node) => {
      const tex = texFromAlt(node.getAttribute('alt'))
      if (!tex) return ''
      return node.getAttribute('data-cr-math') === 'display' ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`
    },
  })

  return td
}

/** MediaWiki wraps its LaTeX as `{\displaystyle … }`; unwrap it. */
export function texFromAlt(alt) {
  const text = (alt ?? '').trim()
  const wrapped = text.match(/^\{\s*\\displaystyle\s([\s\S]*)\}$/)
  return (wrapped ? wrapped[1] : text).trim()
}

/** Slug suitable for a filename, without an extension. */
export function slugifyTitle(title, fallback = 'article') {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 80)
    .replace(/^-|-$/g, '')
  return slug || fallback
}

export function markdownFilename(article) {
  return `${slugifyTitle(article?.title)}.md`
}

/**
 * Front matter carries what the reader would otherwise lose: where it came
 * from, who wrote it, and when it was captured.
 */
export function toMarkdown(article) {
  const td = service()
  const body = td.turndown(article.content ?? '').trim()

  const meta = []
  if (article.byline) meta.push(`**${article.byline}**`)
  if (article.siteName) meta.push(article.siteName)
  if (article.readingTimeMinutes) meta.push(`${article.readingTimeMinutes} min read`)

  const parts = [`# ${article.title ?? 'Untitled'}`]
  if (meta.length) parts.push(meta.join(' · '))
  if (article.url) parts.push(`[View original](${article.url})`)
  parts.push('---', body, '')

  return parts.join('\n\n')
}
