/**
 * Generates the extension icons into public/icons/ from one SVG definition.
 * Run with `npm run icons`. Rendered through Chrome so the rounded corners and
 * bar edges get real antialiasing.
 *
 * The mark: an ink tile holding a title bar and two body lines -- the article,
 * reduced to what CleanRead leaves behind. Deliberately only three shapes so it
 * still reads at 16px.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'public', 'icons')
const PROMO_OUT = path.join(HERE, '..', 'release', 'store-assets')
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SIZES = [16, 32, 48, 128]

const INK = '#17171b'
const CREAM = '#fbfaf8'
const ACCENT = '#5b9bff'

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
  <rect x="0" y="0" width="32" height="32" rx="7" fill="${INK}"/>
  <rect x="8" y="9" width="16" height="4" rx="2" fill="${ACCENT}"/>
  <rect x="8" y="16" width="16" height="2.5" rx="1.25" fill="${CREAM}" opacity="0.92"/>
  <rect x="8" y="21.5" width="10" height="2.5" rx="1.25" fill="${CREAM}" opacity="0.55"/>
</svg>`

fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage()

for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}
     #i{width:${size}px;height:${size}px;display:block}</style>
     <div id="i">${svg}</div>`,
  )
  const file = path.join(OUT, `${size}.png`)
  await page.locator('#i').screenshot({ path: file, omitBackground: true })
  console.log(`wrote ${path.relative(path.join(HERE, '..'), file)} (${size}x${size})`)
}

// --- 440x280 small promo tile for the store listing (same mark, room to breathe)
const promo = `
  <div style=\"width:440px;height:280px;box-sizing:border-box;background:#0e0e11;
    display:flex;align-items:center;gap:26px;padding:0 40px;\">
    <div style=\"flex:none;width:96px;height:96px;border-radius:21px;box-shadow:0 0 0 1px rgba(255,255,255,0.12);\">${svg}</div>
    <div style=\"font-family:Georgia,'Times New Roman',serif;color:${CREAM};\">
      <div style=\"font-size:38px;font-weight:700;letter-spacing:-0.5px;\">CleanRead</div>
      <div style=\"font-size:16px;line-height:1.45;margin-top:8px;color:#a9a59a;
        font-family:system-ui,-apple-system,'Segoe UI',sans-serif;\">Any messy page,<br>as a clean article.</div>
    </div>
  </div>`

fs.mkdirSync(PROMO_OUT, { recursive: true })
await page.setViewportSize({ width: 440, height: 280 })
await page.setContent(`<style>html,body{margin:0;padding:0}</style>${promo}`)
const promoFile = path.join(PROMO_OUT, 'promo-tile-440x280.png')
await page.locator('div').first().screenshot({ path: promoFile })
console.log(`wrote ${path.relative(path.join(HERE, '..'), promoFile)} (440x280)`)

await browser.close()
