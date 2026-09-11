/**
 * Small key/value reading preferences in browser.storage.local.
 * Anything structured or large (saved articles) belongs in Dexie -- see db.js.
 */
import browser from './browser.js'

const KEY = 'settings'

export const DEFAULT_SETTINGS = {
  theme: 'light', // 'light' | 'dark'
  fontSize: 18, // px
  lineHeight: 1.6, // unitless
  contentWidth: 680, // px
}

export async function getSettings() {
  const stored = await browser.storage.local.get(KEY)
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] ?? {}) }
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch }
  await browser.storage.local.set({ [KEY]: next })
  return next
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[KEY]) callback(changes[KEY].newValue)
  }
  browser.storage.onChanged.addListener(listener)
  return () => browser.storage.onChanged.removeListener(listener)
}
