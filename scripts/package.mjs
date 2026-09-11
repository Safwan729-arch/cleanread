/**
 * Builds a Chrome Web Store upload: validates dist/ against the store's rules,
 * then zips it to release/cleanread-<version>.zip.
 *
 * Run with `npm run package` (which builds first).
 * Submission checklist: notes/features/store-packaging.md
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DIST = path.join(ROOT, 'dist')
const RELEASE = path.join(ROOT, 'release')

let failures = 0
const ok = (name, detail = '') => console.log(`  ok    ${name}${detail ? ` -- ${detail}` : ''}`)
const bad = (name, detail = '') => {
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
  failures++
}
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail))

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('No build in dist/ — run "npm run build" first.')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'))

console.log('Validating dist/ against Chrome Web Store requirements\n')

// --- manifest rules the store actually enforces
check(manifest.manifest_version === 3, 'manifest_version is 3', String(manifest.manifest_version))
check(/^\d+(\.\d+){0,3}$/.test(manifest.version), 'version is 1-4 dot-separated integers', manifest.version)
check(manifest.name?.length > 0 && manifest.name.length <= 45, 'name within 45 chars', `${manifest.name?.length} chars`)
check(
  manifest.description?.length > 0 && manifest.description.length <= 132,
  'description within 132 chars',
  `${manifest.description?.length} chars`,
)
check(Boolean(manifest.icons?.['128']), 'declares a 128px icon (required for the listing)')

// The declared floor is only meaningful if the bundler actually compiled to it.
const viteConfig = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8')
const buildTarget = viteConfig.match(/target:\s*'chrome(\d+)'/)?.[1]
check(
  buildTarget !== undefined && buildTarget === manifest.minimum_chrome_version,
  'minimum_chrome_version matches vite build.target',
  `manifest ${manifest.minimum_chrome_version ?? 'unset'} vs build target ${buildTarget ?? 'unset'}`,
)
check(!('key' in manifest), 'no "key" field (dev-only, must not ship)')
check(!('update_url' in manifest), 'no "update_url" (the store sets this)')

// --- every referenced file must exist in the package
const referenced = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
].filter(Boolean)

const missing = referenced.filter((rel) => !fs.existsSync(path.join(DIST, rel)))
check(missing.length === 0, 'every file the manifest references exists', missing.join(', ') || `${referenced.length} files`)

// --- icons must be square and the size they claim
function pngSize(file) {
  const buf = fs.readFileSync(file)
  // IHDR width/height are big-endian uint32 at byte 16 and 20
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
for (const [declared, rel] of Object.entries(manifest.icons ?? {})) {
  const { width, height } = pngSize(path.join(DIST, rel))
  check(width === Number(declared) && height === Number(declared), `icon ${declared} is ${declared}x${declared}`, `${width}x${height}`)
}

// --- things that get a submission rejected or delayed
const KNOWN_PERMISSIONS = new Set(['storage', 'activeTab', 'scripting'])
const unexpected = (manifest.permissions ?? []).filter((p) => !KNOWN_PERMISSIONS.has(p))
check(unexpected.length === 0, 'no unjustified permissions', unexpected.join(', ') || (manifest.permissions ?? []).join(', '))

const matches = (manifest.content_scripts ?? []).flatMap((cs) => cs.matches ?? [])
check(!matches.includes('<all_urls>'), 'content scripts avoid <all_urls>', matches.join(', '))

// Host access re-injects the content script into tabs that were already open when the
// extension updated -- see notes/architecture/content-script-lifecycle.md. It must stay
// exactly as broad as the content scripts already are, and no broader.
const hosts = manifest.host_permissions ?? []
check(hosts.every((h) => matches.includes(h)), 'host permissions go no wider than the content scripts', hosts.join(', '))
check(!hosts.includes('<all_urls>'), 'host permissions avoid <all_urls>')

// --- package hygiene: nothing but the extension itself
const walk = (dir, base = '') =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel]
  })

const files = walk(DIST)
const maps = files.filter((f) => f.endsWith('.map'))
check(maps.length === 0, 'no source maps in the package', maps.join(', ') || 'none')

const totalBytes = files.reduce((n, f) => n + fs.statSync(path.join(DIST, f)).size, 0)
ok('package contents', `${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)}MB unzipped`)

if (failures) {
  console.log(`\n${failures} problem(s) — not packaging.`)
  process.exit(1)
}

// --- zip it
const zip = new JSZip()
for (const rel of files) zip.file(rel, fs.readFileSync(path.join(DIST, rel)))

fs.mkdirSync(RELEASE, { recursive: true })
const out = path.join(RELEASE, `cleanread-${manifest.version}.zip`)
const buf = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
})
fs.writeFileSync(out, buf)

console.log(`\nAll checks passed.`)
console.log(`Upload: ${path.relative(ROOT, out)} (${(buf.length / 1024 / 1024).toFixed(2)}MB)`)
console.log('Listing assets and permission justifications: notes/features/store-packaging.md')
