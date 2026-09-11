---
tags: [feature, packaging, release]
related: [[build-pipeline]], [[extension-icons]], [[running-the-extension]], [[content-script-lifecycle]]
---
# Chrome Web Store packaging

```
npm run package      # build -> validate -> release/cleanread-<version>.zip
npm run shots:store  # release/store-assets/*.png at the required 1280x800
```

`scripts/package.mjs` refuses to zip if anything the store enforces is wrong, so a bad
upload fails on this machine rather than in review. It checks: MV3, version format, name
≤45 and description ≤132 chars, a 128px icon, no `key`/`update_url`, every manifest-
referenced file present, each PNG actually the size it claims (read from the IHDR header),
no source maps, no `<all_urls>`, no unexpected permissions, and host permissions no wider than
the content scripts.

## Permissions, and how to justify them

| Permission | Why | What to write in the dashboard |
|---|---|---|
| `storage` | reading preferences (theme, font size, spacing, width) | "Stores the user's reading preferences locally." |
| `activeTab` | the popup reads the current tab's URL to tell whether it is already saved, and messages the content script | "Reads the current tab's URL only while the user has the popup open, to clean or save that page." |
| `scripting` | re-injects the content script into tabs that were already open when the extension updated — see [[content-script-lifecycle]] | "Re-inserts the extension's own reading script into pages that were already open when the extension updated, so the user does not have to reload them." |
| `host_permissions` (`http`/`https`) | `scripting.executeScript` needs host access, and `activeTab` only grants it on a toolbar click — the service worker cannot use it | "Needed to insert the extension's own reading script. The same pages are already covered by the content script declaration; no data is read from them." |

`scripting` **was** removed once, as an unused permission. It came back with a caller: an
extension reload orphans open tabs, and repairing them needs both `scripting` and host
access. The host pattern is deliberately the *same pair* the content scripts already
match, so the install-time warning the user sees does not change; `package.mjs` asserts
host permissions never go wider than the content scripts.

**Content scripts match `http://*/*` and `https://*/*`, not `<all_urls>`.** The narrower
pair is accurate (the extension cannot work on `file://` without a permission the user must
grant by hand) and `<all_urls>` invites extra scrutiny.

There is **no remote code** — everything, html2pdf included, is bundled. That matters:
remote code is an outright policy violation, not a warning.

## Privacy disclosures
Nothing leaves the machine. Articles, highlights and settings are in `storage.local` and
IndexedDB on the user's own device ([[storage-layers]]); there is no server, no analytics,
no network call the extension makes on its own. In the dashboard that is "does not collect"
across every category, and the single purpose is: *render the current page as a clean,
readable article.*

## Listing assets
`npm run shots:store` drives the real extension and writes five 1280x800 PNGs: the
cluttered "before", the clean reading view, highlighting, dark mode, and the offline saved
article. They use our own fixture rather than a real site, so the listing never shows
someone else's content.

`npm run icons` also writes `release/store-assets/promo-tile-440x280.png`, the small promo
tile the listing requires.

The only step left that a person must do: **publish `PRIVACY.md` at a public URL** and
paste that URL into the dashboard. Everything else below is drafted and ready to paste.

## Listing copy (draft — paste into the dashboard)

**Name:** CleanRead
**Short description** (matches `manifest.description`, 67/132 chars):
> Turn any messy webpage into a clean, distraction-free reading page.

**Category:** Functionality & UI is the closest fit; Accessibility is defensible too.
The store's category list has changed before — pick from what the dashboard offers.

**Detailed description:**
> CleanRead turns a cluttered article page into something you can actually read.
>
> One click strips the ads, cookie banners, sticky menus and newsletter pop-ups, and
> lays the article out as clean text you control: font size, line spacing, column
> width, and a light or dark theme.
>
> - A contents rail, built from the article's own headings, that follows you as you read
> - Highlight the paragraphs that matter; they are still there when you come back
> - Save articles to a reading list and read them later, offline
> - Export to Markdown, or print to a PDF with real, selectable text
>
> Nothing is collected. CleanRead has no account, no server and no analytics; your
> preferences, highlights and saved articles stay on your own device.

**Privacy policy:** publish `PRIVACY.md` (repo root) at a public URL and link it there.

## Gotchas
- The zip must contain the extension at its **root** — `manifest.json` at the top level,
  not nested in a folder. The script zips the contents of `dist/`, not `dist/` itself.
- Bump `version` in `manifest.json` for every upload; the store rejects a re-used version.
- `minimum_chrome_version: 116` is enforced by `build.target: 'chrome116'` in
  `vite.config.js`, so the emitted syntax really does compile down to that floor, and
  `npm run package` fails if the two ever disagree. Note what this does and does not
  claim: the floor bounds the **syntax**, not the runtime. The extension has only been
  *run* on current Chrome.
