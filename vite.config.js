import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'

/**
 * Chrome-only build (Manifest V3).
 *
 * Firefox is deliberately out of scope for now -- see
 * notes/decisions/firefox-deferred.md for what it would take to add back.
 * Source code stays browser-agnostic (always `browser.*` via webextension-polyfill),
 * so that decision is reversible without touching app logic.
 */
const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'))

export default defineConfig({
  plugins: [react(), crx({ manifest, browser: 'chrome' })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Must match manifest.json's minimum_chrome_version -- this is what makes
    // that floor real rather than a guess. scripts/package.mjs asserts they agree.
    target: 'chrome116',
    rollupOptions: {
      // Standalone extension page -- not referenced from the manifest, so CRXJS
      // would not discover it on its own.
      input: { reader: 'src/reader/index.html' },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
