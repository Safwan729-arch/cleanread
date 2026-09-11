/**
 * Single entry point for the extension API.
 * CLAUDE.md rule: always `browser.*`, never `chrome.*` anywhere in src/.
 * Import from here so there is exactly one place the polyfill is pulled in.
 */
import browser from 'webextension-polyfill'

export default browser
