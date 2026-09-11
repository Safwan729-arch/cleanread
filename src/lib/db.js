/**
 * The ONE Dexie schema for saved articles.
 * CLAUDE.md rule: no ad-hoc IndexedDB calls anywhere else -- all reads/writes
 * for saved articles go through the helpers in this file.
 */
import Dexie from 'dexie'

export const db = new Dexie('cleanread')

db.version(1).stores({
  // &url -> unique, so re-saving a page updates instead of duplicating
  // *tags -> multi-entry index for tag filtering
  articles: '++id, &url, title, savedAt, folder, *tags',
})

// v2: highlighted paragraphs, keyed by page url.
db.version(2).stores({
  highlights: 'url, updatedAt',
})

/** @typedef {{id?:number,url:string,title:string,byline?:string,siteName?:string,
 *   excerpt?:string,content:string,textContent:string,readingTimeMinutes:number,
 *   savedAt:number,folder?:string,tags?:string[]}} SavedArticle */

export async function saveArticle(article) {
  const url = pageKey(article.url)
  const existing = await db.articles.get({ url })
  const record = { ...article, url, savedAt: Date.now() }
  if (existing) {
    await db.articles.update(existing.id, record)
    return existing.id
  }
  return db.articles.add(record)
}

export function getArticle(id) {
  return db.articles.get(id)
}

export function listArticles({ folder, tag } = {}) {
  if (folder) return db.articles.where('folder').equals(folder).reverse().sortBy('savedAt')
  if (tag) return db.articles.where('tags').equals(tag).reverse().sortBy('savedAt')
  return db.articles.orderBy('savedAt').reverse().toArray()
}

export function deleteArticle(id) {
  return db.articles.delete(id)
}

/**
 * Highlighted paragraphs for one page, stored as content hashes rather than
 * positions so they survive re-extraction -- see notes/features/paragraph-highlighting.md.
 *
 * IMPORTANT: only call these from an extension context (background worker).
 * A content script runs in the *page's* origin, so IndexedDB there belongs to
 * the website, not to CleanRead.
 */
/**
 * Canonical storage key for a page. A `#fragment` only points at a place
 * within the same document, so following an in-page anchor must not orphan
 * saved data. Query strings are kept -- those often do select a different article.
 */
export function pageKey(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href
  } catch {
    return url
  }
}

export async function getHighlights(url) {
  const row = await db.highlights.get(pageKey(url))
  return row?.hashes ?? []
}

export async function setHighlights(url, hashes) {
  const key = pageKey(url)
  if (!hashes.length) {
    await db.highlights.delete(key)
    return []
  }
  await db.highlights.put({ url: key, hashes, updatedAt: Date.now() })
  return hashes
}

/** Is this page already in the reading list? Fragment-insensitive, like highlights. */
export async function findArticleByUrl(url) {
  return db.articles.get({ url: pageKey(url) })
}
