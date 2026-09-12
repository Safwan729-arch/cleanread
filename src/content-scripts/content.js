/**
 * Content script entry. Pure DOM -- no React here (see CLAUDE.md conventions).
 * Owns the message contract with the popup; the actual work lives in clean.js.
 */
import browser from '../lib/browser.js'
import { MSG } from '../lib/messages.js'
import { getSettings } from '../lib/settings.js'
import {
  applySettings,
  canCleanPage,
  extractArticle,
  isReaderActive,
  removeReader,
  renderReader,
} from './clean.js'

/** Cached so the popup can read metadata without re-parsing the page. */
let currentArticle = null

async function handleMessage(message) {
  switch (message?.type) {
    case MSG.GET_STATE:
      return {
        active: isReaderActive(),
        readerable: canCleanPage(),
        article: currentArticle && {
          title: currentArticle.title,
          url: currentArticle.url,
          readingTimeMinutes: currentArticle.readingTimeMinutes,
        },
      }

    // The popup needs the full article (content included) in order to save it.
    // Extract on demand so saving works without cleaning the page first.
    case MSG.GET_ARTICLE: {
      currentArticle ??= await extractArticle()
      return currentArticle ? { ok: true, article: currentArticle } : { ok: false, reason: 'no-article' }
    }

    case MSG.CLEAN_PAGE: {
      const article = await extractArticle()
      if (!article) return { ok: false, reason: 'no-article' }
      currentArticle = article
      renderReader(article, await getSettings())
      return { ok: true, title: article.title, readingTimeMinutes: article.readingTimeMinutes }
    }

    case MSG.RESTORE_PAGE:
      removeReader()
      return { ok: true }

    // print gives a PDF with real, selectable text -- unlike the rasterised
    // html2pdf path. The popup closes on print, which is fine.
    case MSG.PRINT_PAGE:
      if (!isReaderActive()) return { ok: false, reason: 'not-cleaned' }
      window.print()
      return { ok: true }

    case MSG.APPLY_SETTINGS:
      applySettings(message.settings)
      return { ok: true }

    default:
      return undefined
  }
}

// The popup re-injects this script into tabs that lost it when the extension
// reloaded (see src/popup/App.jsx). Register once per frame, or a tab that got
// both injections would answer every message twice. `window` here is the
// isolated world's, so the flag is invisible to the page.
if (!window.__cleanReadListening) {
  window.__cleanReadListening = true
  browser.runtime.onMessage.addListener(handleMessage)
}
