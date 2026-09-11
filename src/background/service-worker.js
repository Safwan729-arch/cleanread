/**
 * Background service worker (Chrome MV3).
 * Calls go through `browser.*` so this stays portable -- see
 * notes/decisions/firefox-deferred.md.
 *
 * It owns IndexedDB. Content scripts run in the page's origin, so they must
 * ask the worker to read/write highlights rather than touching Dexie directly.
 */
import browser from '../lib/browser.js'
import { MSG } from '../lib/messages.js'
import { DEFAULT_SETTINGS, getSettings } from '../lib/settings.js'
import { getHighlights, setHighlights } from '../lib/db.js'

/**
 * Put the content script back into tabs that are already open.
 *
 * Manifest content scripts are injected when a page *loads*. Installing or
 * updating the extension therefore leaves every tab the user already had open
 * without one, and Chrome does not re-inject it -- the popup could only report
 * "CleanRead can't run on this page" until the user reloaded by hand. Healing
 * the tabs here makes an update invisible instead.
 *
 * Built filenames are hashed, so read them from the manifest.
 */
async function reinjectOpenTabs() {
  const files = browser.runtime.getManifest().content_scripts?.[0]?.js ?? []
  if (!files.length) return
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  await Promise.all(
    tabs.map((tab) =>
      browser.scripting
        .executeScript({ target: { tabId: tab.id }, files })
        // discarded tabs and hosts we may not touch simply stay as they were
        .catch(() => {}),
    ),
  )
}

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Seed defaults so the popup never renders against empty storage.
    await browser.storage.local.set({ settings: DEFAULT_SETTINGS })
  } else {
    // On update, re-save the merged object so newly added keys get defaults.
    await browser.storage.local.set({ settings: await getSettings() })
  }
  await reinjectOpenTabs()
})

browser.runtime.onMessage.addListener(async (message) => {
  switch (message?.type) {
    case MSG.GET_HIGHLIGHTS:
      return { ok: true, hashes: await getHighlights(message.url) }

    case MSG.SET_HIGHLIGHTS:
      return { ok: true, hashes: await setHighlights(message.url, message.hashes ?? []) }

    default:
      return undefined
  }
})
