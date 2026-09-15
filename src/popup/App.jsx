/** Popup UI. Functional components + hooks only (CLAUDE.md). */
import React, { useCallback, useEffect, useState } from 'react'
import browser from '../lib/browser.js'
import { MSG } from '../lib/messages.js'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../lib/settings.js'
// The popup is an extension page, so Dexie is safe here -- only content
// scripts are barred, because they run in the page's origin.
import { deleteArticle, findArticleByUrl, listArticles, saveArticle } from '../lib/db.js'
import { markdownFilename, toMarkdown } from '../lib/export-markdown.js'
import { downloadText } from '../lib/download.js'
import { exportPdf } from '../lib/export-pdf.js'

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  return tab
}

/**
 * Re-inject the content script into a tab that has lost it.
 *
 * Manifest content scripts are injected when a page *loads*. Reloading the
 * extension -- every rebuild during development, and every Web Store
 * auto-update for real users -- tears the script out of tabs that are already
 * open, and Chrome does not put it back. Without this, the popup blamed the
 * page ("can't run here") for a tab that merely needed re-injecting.
 *
 * The built filenames are hashed, so read them from the manifest rather than
 * hardcoding them.
 */
async function injectContentScript(tabId) {
  const files = browser.runtime.getManifest().content_scripts?.[0]?.js ?? []
  if (!files.length) return false
  try {
    await browser.scripting.executeScript({ target: { tabId }, files })
    return true
  } catch {
    return false // chrome://, the Web Store, the PDF viewer: genuinely off-limits
  }
}

/** The injected loader imports its module asynchronously, so poll for the listener. */
async function waitForListener(tabId, timeout = 2000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      await browser.tabs.sendMessage(tabId, { type: MSG.GET_STATE })
      return true
    } catch {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/**
 * A failed message is not proof the page is unsupported -- try re-injecting
 * once. Pages where content scripts are genuinely barred (chrome://, about:,
 * the web stores) fail the injection too, and keep the honest error.
 */
async function sendToTab(message) {
  const tab = await activeTab()
  if (!tab?.id) return { ok: false, reason: 'no-tab' }
  try {
    return await browser.tabs.sendMessage(tab.id, message)
  } catch {
    // fall through to recovery
  }
  if (!(await injectContentScript(tab.id))) return { ok: false, reason: 'no-content-script' }
  if (!(await waitForListener(tab.id))) return { ok: false, reason: 'no-content-script' }
  try {
    return await browser.tabs.sendMessage(tab.id, message)
  } catch {
    return { ok: false, reason: 'no-content-script' }
  }
}

function relativeDay(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

export default function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [state, setState] = useState({ active: false, readerable: false, article: null })
  const [savedId, setSavedId] = useState(null)
  const [list, setList] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshList = useCallback(async () => setList(await listArticles()), [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [loaded, tabState, tab] = await Promise.all([
        getSettings(),
        sendToTab({ type: MSG.GET_STATE }),
        activeTab(),
      ])
      if (cancelled) return

      setSettings(loaded)
      if (tabState?.reason === 'no-content-script') setError("CleanRead can't run on this page.")
      else if (tabState) setState(tabState)

      if (tab?.url) {
        const existing = await findArticleByUrl(tab.url)
        if (!cancelled) setSavedId(existing?.id ?? null)
      }
      await refreshList()
    })()
    return () => {
      cancelled = true
    }
  }, [refreshList])

  const update = useCallback(async (patch) => {
    const next = await saveSettings(patch)
    setSettings(next)
    await sendToTab({ type: MSG.APPLY_SETTINGS, settings: next })
  }, [])

  const toggleReader = useCallback(async () => {
    setBusy(true)
    setError('')
    const result = await sendToTab({ type: state.active ? MSG.RESTORE_PAGE : MSG.CLEAN_PAGE })
    setBusy(false)

    if (!result?.ok) {
      setError(
        result?.reason === 'no-article'
          ? "Couldn't find an article on this page."
          : "CleanRead can't run on this page.",
      )
      return
    }
    setState((prev) => ({ ...prev, active: !prev.active, article: result.title ? result : prev.article }))
  }, [state.active])

  const toggleSaved = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      if (savedId) {
        await deleteArticle(savedId)
        setSavedId(null)
      } else {
        const result = await sendToTab({ type: MSG.GET_ARTICLE })
        if (!result?.ok) {
          setError(
            result?.reason === 'no-article'
              ? "Couldn't find an article to save."
              : "CleanRead can't run on this page.",
          )
          return
        }
        setSavedId(await saveArticle(result.article))
      }
      await refreshList()
    } finally {
      setBusy(false)
    }
  }, [savedId, refreshList])

  const exportMarkdown = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const result = await sendToTab({ type: MSG.GET_ARTICLE })
      if (!result?.ok) {
        setError("Couldn't find an article to export.")
        return
      }
      downloadText(markdownFilename(result.article), toMarkdown(result.article))
    } finally {
      setBusy(false)
    }
  }, [])

  const exportPdfFile = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const result = await sendToTab({ type: MSG.GET_ARTICLE })
      if (!result?.ok) {
        setError("Couldn't find an article to export.")
        return
      }
      await exportPdf(result.article)
    } finally {
      setBusy(false)
    }
  }, [])

  // Print produces a PDF with selectable text, unlike the rasterised export.
  const printPage = useCallback(async () => {
    setError('')
    const result = await sendToTab({ type: MSG.PRINT_PAGE })
    if (!result?.ok) {
      setError(
        result?.reason === 'not-cleaned'
          ? 'Clean the page first, then print.'
          : "CleanRead can't run on this page.",
      )
    }
  }, [])

  const openSaved = useCallback(async (id) => {
    await browser.tabs.create({ url: browser.runtime.getURL(`src/reader/index.html?id=${id}`) })
    window.close()
  }, [])

  const removeSaved = useCallback(
    async (id) => {
      await deleteArticle(id)
      setSavedId((cur) => (cur === id ? null : cur))
      await refreshList()
    },
    [refreshList],
  )

  return (
    <div className="popup" data-theme={settings.theme}>
      <header className="popup__header">
        <h1 className="popup__brand">CleanRead</h1>
        {state.article?.readingTimeMinutes ? (
          <span className="popup__badge">{state.article.readingTimeMinutes} min read</span>
        ) : null}
      </header>

      {/* Extraction can take a few seconds on a page whose charts have to be
          switched through one by one, so say so rather than look frozen. */}
      <button className="popup__primary" onClick={toggleReader} disabled={busy}>
        {busy ? 'Cleaning...' : state.active ? 'Restore original page' : 'Clean this page'}
      </button>

      <button className="popup__ghost popup__save" onClick={toggleSaved} disabled={busy}>
        {savedId ? 'Remove from reading list' : 'Save for later'}
      </button>

      <button className="popup__ghost popup__print" onClick={printPage} disabled={busy}>
        Print / Save as PDF
      </button>

      <button className="popup__ghost popup__export" onClick={exportMarkdown} disabled={busy}>
        Export Markdown
      </button>

      <button className="popup__ghost popup__pdf" onClick={exportPdfFile} disabled={busy}>
        {busy ? 'Working...' : 'Export PDF'}
      </button>

      {error ? <p className="popup__error">{error}</p> : null}

      <fieldset className="popup__group" disabled={!state.active}>
        <legend>Reading controls</legend>

        <label className="popup__row">
          <span>Font size</span>
          <input
            type="range"
            min="14"
            max="26"
            step="1"
            value={settings.fontSize}
            onChange={(e) => update({ fontSize: Number(e.target.value) })}
          />
          <output>{settings.fontSize}px</output>
        </label>

        <label className="popup__row">
          <span>Line spacing</span>
          <input
            type="range"
            min="1.2"
            max="2.2"
            step="0.1"
            value={settings.lineHeight}
            onChange={(e) => update({ lineHeight: Number(e.target.value) })}
          />
          <output>{settings.lineHeight.toFixed(1)}</output>
        </label>

        <label className="popup__row">
          <span>Width</span>
          <input
            type="range"
            min="520"
            max="900"
            step="20"
            value={settings.contentWidth}
            onChange={(e) => update({ contentWidth: Number(e.target.value) })}
          />
          <output>{settings.contentWidth}px</output>
        </label>
      </fieldset>

      <button
        className="popup__ghost"
        onClick={() => update({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
      >
        {settings.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
      </button>

      <section className="popup__saved">
        <h2 className="popup__section">Reading list{list.length ? ` (${list.length})` : ''}</h2>

        {list.length === 0 ? (
          <p className="popup__empty">Nothing saved yet.</p>
        ) : (
          <ul className="popup__list">
            {list.map((item) => (
              <li key={item.id} className="popup__item">
                <button
                  className="popup__item-open"
                  onClick={() => openSaved(item.id)}
                  title={item.title}
                >
                  <span className="popup__item-title">{item.title}</span>
                  <span className="popup__item-meta">
                    {[item.siteName, `${item.readingTimeMinutes} min`, relativeDay(item.savedAt)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
                <button
                  className="popup__item-remove"
                  onClick={() => removeSaved(item.id)}
                  aria-label={`Remove ${item.title}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
