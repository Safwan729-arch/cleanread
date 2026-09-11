---
tags: [architecture, storage]
related: [[reader-view]], [[00-index]]
---
# Storage layers

Two stores, strictly separated. Picking the wrong one is the mistake to avoid.

### `browser.storage.local` — `src/lib/settings.js`
Small key/value reading preferences only, under a single `settings` key:
`theme`, `fontSize`, `lineHeight`, `contentWidth`. `getSettings()` always merges over
`DEFAULT_SETTINGS`, so a newly added key is safe to read immediately after adding it.
`onSettingsChanged()` returns its own unsubscribe function.

### IndexedDB via Dexie — `src/lib/db.js`
Structured, larger records: saved articles, folders, tags, highlights. **This is the only
file allowed to touch IndexedDB** (CLAUDE.md).

```
v1  articles:   '++id, &url, title, savedAt, folder, *tags'
v2  highlights: 'url, updatedAt'
```

**Any extension context may call these — the popup and the saved-article page do.**
The one place that must NOT is a **content script**: it runs in the page's origin, so
Dexie there writes to the *website's* IndexedDB, not CleanRead's. Content scripts ask the
background worker over [[message-contract]] instead. See [[paragraph-highlighting]].

`pageKey()` canonicalises urls for both tables: `#fragment` stripped, query kept.

`&url` is unique, so `saveArticle()` updates an existing row rather than duplicating a
re-saved page. `*tags` is multi-entry for tag filtering.

Both tables are live — see [[paragraph-highlighting]] and [[save-article]].
Bump `db.version(n)` rather than editing a shipped version.
