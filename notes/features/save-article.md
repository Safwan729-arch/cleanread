---
tags: [feature, storage, popup]
related: [[storage-layers]], [[message-contract]], [[reader-view]], [[paragraph-highlighting]]
---
# Save article

"Save for later" in the popup stores the **cleaned** article — not a bookmark — so it can
be read offline with the original site out of the picture.

### The pieces
- `src/popup/App.jsx` — save/remove button and the reading list
- `src/reader/index.html` + `main.js` — the offline view
- `src/lib/db.js` — `saveArticle`, `listArticles`, `deleteArticle`, `findArticleByUrl`

### Flow
1. Popup sends `GET_ARTICLE` to the content script, which **extracts on demand** if the
   page hasn't been cleaned — so saving works without opening the reader first.
2. Popup writes it to Dexie itself. The popup is an extension page, so this is the
   extension's own IndexedDB — see the origin rule in [[storage-layers]].
3. The reading list opens `src/reader/index.html?id=N` in a new tab.

### Why the reader page renders into a shadow root
It is our own page with no hostile CSS, so isolation is not the reason — reuse is.
`reader.css` is written against `:host`, so rendering into a shadow root lets the offline
page share one stylesheet with the in-page reader instead of forking it.

### Storage key
`saveArticle` canonicalises through `pageKey()`, the same helper highlights use: the
`#fragment` is stripped, the query string kept. Without it, saving from `…/article#intro`
and checking from `…/article` would disagree about whether a page is already saved.

### Build note
The reader page is **not referenced from the manifest**, so CRXJS does not discover it.
It is declared explicitly in `vite.config.js` as `build.rollupOptions.input`. Adding an
input rewrites chunk names, so re-check the worker wiring after touching it —
[[entry-filenames-must-differ]] explains what that failure looks like.

### Known gaps
- No folders or tags, though the schema indexes both.
- No search or sort; the list is newest-first and lives only in the popup.
- Saving stores a snapshot — revisiting and re-saving overwrites it, with no version history.
- Highlights are keyed by page url, not by saved-article id, so a saved copy shows them
  only when read at its original url — the offline page does not restore them yet.
