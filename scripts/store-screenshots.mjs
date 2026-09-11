/**
 * Renders Chrome Web Store listing screenshots at the required 1280x800,
 * from the real extension running in real Chrome. Output: release/store-assets/.
 *
 * Run with `npm run shots:store` (after `npm run build`).
 * The extension-loading recipe is explained in notes/architecture/running-the-extension.md.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const EXT = path.join(ROOT, 'dist').replace(/\\/g, '/')
const OUT = path.join(ROOT, 'release', 'store-assets')
const PROFILE = path.join(ROOT, 'node_modules', '.cache', 'cleanread-store-profile')
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

// Store requirement: 1280x800 (or 640x400). Anything else is rejected.
const SIZE = { width: 1280, height: 800 }

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error('No build in dist/ — run "npm run build" first.')
  process.exit(1)
}
fs.mkdirSync(OUT, { recursive: true })

const fixture = fs.readFileSync(path.join(HERE, 'fixtures', 'messy-article.html'))
const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(fixture)
})
await new Promise((r) => server.listen(8788, '127.0.0.1', r))

fs.rmSync(PROFILE, { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  viewport: SIZE,
  args: ['--enable-unsafe-extension-debugging'],
  ignoreDefaultArgs: ['--disable-extensions'],
})

const cdp = await ctx.browser().newBrowserCDPSession()
const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT })

let sw
for (let i = 0; i < 100 && !sw; i++) {
  sw = ctx.serviceWorkers().find((w) => new URL(w.url()).host === extId)
  if (!sw) await new Promise((r) => setTimeout(r, 200))
}

const page = ctx.pages()[0]
await page.setViewportSize(SIZE)
const send = (msg) =>
  sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return chrome.tabs.sendMessage(tab.id, m)
  }, msg)

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name) })
  console.log(`  ${name}`)
}

console.log(`Rendering ${SIZE.width}x${SIZE.height} listing screenshots\n`)

await page.goto('http://127.0.0.1:8788/article', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)

// 1. the messy original -- the "before" that makes the pitch
await shot('01-before-cluttered-page.png')

// 2. cleaned, light, with the contents rail
await send({ type: 'cleanread/clean-page' })
await page.waitForTimeout(600)
await shot('02-clean-reading-view.png')

// 3. highlighted paragraphs
await page.locator('#cleanread-root .cr-content p[data-cr-hash]').first().click()
await page.waitForTimeout(500)
await shot('03-highlight-paragraphs.png')

// 4. dark mode at a larger type size
await send({
  type: 'cleanread/apply-settings',
  settings: { theme: 'dark', fontSize: 20, lineHeight: 1.7, contentWidth: 700 },
})
await page.waitForTimeout(600)
await shot('04-dark-mode.png')

// 5. the offline saved-article page
await send({ type: 'cleanread/apply-settings', settings: { theme: 'light', fontSize: 18, lineHeight: 1.6, contentWidth: 680 } })
const article = await send({ type: 'cleanread/get-article' })
const savedId = await sw.evaluate(
  (a) =>
    new Promise((res) => {
      const r = indexedDB.open('cleanread')
      r.onsuccess = () => {
        const tx = r.result.transaction('articles', 'readwrite')
        const q = tx.objectStore('articles').add({ ...a, savedAt: Date.now() })
        q.onsuccess = () => res(q.result)
        q.onerror = () => res(null)
      }
    }),
  article.article,
)
if (savedId) {
  await page.goto(`chrome-extension://${extId}/src/reader/index.html?id=${savedId}`)
  await page.waitForTimeout(1000)
  await shot('05-saved-offline.png')
}

await ctx.close()
server.close()
console.log(`\nWritten to ${path.relative(ROOT, OUT)} — upload these in the store dashboard.`)
