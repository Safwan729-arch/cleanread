# CleanRead — Claude Code Project Guide

This file is read by Claude Code at the start of every session. Follow it exactly — especially the "Obsidian workflow" section, which exists to save tokens.

## What this project is

CleanRead is a **Chrome** extension (Manifest V3) that turns any messy webpage into a clean, distraction-free reading page.

Firefox is **out of scope for now**. It may be revisited later, so source code stays
browser-agnostic — see `notes/decisions/firefox-deferred.md` for exactly what adding it back costs.

Core flow: user clicks "Clean this page" → content script extracts the real article → junk (ads, popups, cookie banners, nav clutter) is stripped → user gets a clean article view with reading controls.

**Feature list:**
- Remove distractions (ads, popups, cookie banners, menus)
- Adjust font size / line spacing
- Dark / light mode
- Reading time estimate
- Table of contents (auto-generated from headings)
- Highlight important paragraphs
- Save article (for later reading)
- Export to PDF / Markdown

## Tech stack — do not deviate without discussion

| Layer | Tool | Notes |
|---|---|---|
| Build tooling | Vite + CRXJS | Single Chrome target, output to `dist/` |
| UI framework | React — functional components + hooks only | Popup UI and any injected in-page toolbar |
| Extension API | **webextension-polyfill** | Always call `browser.*`. Never `chrome.*` in `src/`. Kept despite Chrome-only so a future Firefox port stays cheap. |
| Article extraction | Readability.js (Mozilla) | Does the "what is the real article" heavy lifting — don't reinvent this |
| Settings storage | `browser.storage.local` | Small key/value only: theme, font size, line spacing, etc. |
| Saved-article storage | IndexedDB via **Dexie.js** | Structured, larger records — full saved articles, tags, folders |
| Markdown export | Turndown.js | HTML → Markdown |
| PDF export | html2pdf.js, plus a print path | `Download PDF` rasterises; `Print` uses the browser and keeps text selectable — prefer print, see `notes/features/pdf-export.md` |
| Manifest | Manifest V3 | `manifest.json` at the repo root is the single source of truth |

## Repo structure

```
/cleanread
  /src
    /content-scripts     -- DOM cleaning logic (Readability.js lives here); entry: content.js
    /popup                -- React popup UI
    /reader               -- offline page for a saved article (not in the manifest; declared in vite.config.js)
    /background           -- service worker (entry: service-worker.js); owns IndexedDB
    /lib                   -- shared helpers (storage, export, polyfill wrapper)
  /public
  /notes                  -- Obsidian vault content (see workflow below)
    00-index.md            -- Map of Content, start here every session
    /architecture
    /decisions
    /features
    /sessions
  manifest.json
  CLAUDE.md
  package.json
```

The entire project directory is opened as an Obsidian vault, so any `.md` file anywhere in the repo is part of it — but keep planning/context notes inside `/notes/` to keep them separate from source code.

## Obsidian workflow — READ THIS EVERY SESSION

The project folder is also an Obsidian vault. This vault is the project's "second brain": it exists so Claude Code doesn't have to re-read the whole codebase from scratch every session, which burns tokens. Instead, Claude Code should navigate notes the way Obsidian does — via links — and only pull in the source files it actually needs for the task at hand.

**At the start of a session:**
1. Read `/notes/00-index.md` first. It's a Map of Content (MOC) — a short file that links out to every other note. It should never be more than a page.
2. From there, only open the specific linked notes relevant to the current task. Don't scan the whole `/notes/` folder or the whole `/src/` tree unless the index doesn't cover what's needed.
3. If a note references source files directly (e.g. "content-script cleaning logic lives in `src/content-scripts/clean.js`, see [[readability-integration]]"), trust the note before re-reading the file, unless there's reason to think the note is stale.

**While working:**
4. Before implementing something, grep `/notes/` for relevant keywords first — it's cheaper than re-deriving context from source.

**After meaningful work (a feature, a decision, a bug pattern worth remembering):**
5. Write or update a note in the right subfolder:
   - `/notes/architecture/` — how a system/module works
   - `/notes/decisions/` — why we chose X over Y (tech choices, trade-offs)
   - `/notes/features/` — one note per feature (e.g. `table-of-contents.md`, `pdf-export.md`)
   - `/notes/sessions/` — one short dated log per session (see below)
6. Link the new note from `00-index.md` so it's discoverable.
7. Link related notes to each other using `[[wikilink]]` syntax. This is the whole point — a well-linked vault means Claude Code can jump straight to relevant context instead of reading everything.
8. Keep notes **atomic**: one concept per note. A 500-line note defeats the purpose — it costs as many tokens to read as just re-deriving the answer. Split it and link the pieces instead.
9. Never duplicate information that's already written in another note — link to it instead of re-explaining it.

**Session logs (`/notes/sessions/YYYY-MM-DD.md`):**
Keep these short. Not a transcript — a few bullet points: what changed, why, and links to the feature/decision notes that have the real detail. Example:

```markdown
---
tags: [session]
---
## 2026-09-11
- Implemented reading-time estimate — see [[reading-time]]
- Decided to use Dexie.js over raw IndexedDB — see [[storage-decision]]
- TODO next: table of contents generation
```

**Note frontmatter convention:**
```markdown
---
tags: [feature, storage]
related: [[dexie-setup]], [[saved-articles-schema]]
---
```

## Coding conventions

- Always import from `webextension-polyfill`; never write `chrome.` in source
- Content scripts stay pure DOM logic — no React inside content scripts, only in the popup/injected toolbar UI if needed
- No browser-detection branches in app logic. Chrome is the only target; portability comes from calling `browser.*`, never from runtime checks
- One Dexie schema file (`src/lib/db.js`) — no ad-hoc IndexedDB calls elsewhere. Extension pages (popup, reader) may call it directly; **content scripts may not** (they run in the *page's* origin) and must go through the background worker
- Entry files must have distinct filenames — two entries named `index.js` silently mis-wire the service worker

## Chrome gotchas to remember

- Test in Chrome via `chrome://extensions` → Load unpacked
- `--load-extension` was removed in Chrome 137+; automated loading now goes through CDP `Extensions.loadUnpacked` — see `notes/architecture/running-the-extension.md`
- Some sites' Content Security Policy (CSP) may block content script injection or style changes — this is expected on a small percentage of sites, not a bug to chase forever

## Current feature status

Keep this list current — it's the cheapest way for Claude Code to know project state without opening every note.

Checked items are verified running in real Chrome via `npm run smoke:chrome` (121 checks).

- [x] Content script + Readability.js integration
- [x] Distraction removal
- [x] Font size / line spacing controls
- [x] Dark/light mode
- [x] Reading time estimate
- [x] Table of contents
- [x] Paragraph highlighting
- [x] Save article (Dexie/IndexedDB)
- [x] Export to Markdown (Turndown)
- [x] Export to PDF (html2pdf.js)
- [x] Chrome Web Store packaging

**Deferred (not in scope):** Firefox build target, Firefox Add-ons (AMO) packaging.
