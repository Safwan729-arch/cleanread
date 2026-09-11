---
tags: [feature, content-script, storage]
related: [[reader-view]], [[storage-layers]], [[message-contract]], [[entry-filenames-must-differ]]
---
# Paragraph highlighting

Click a paragraph in the reader view to highlight it; click again to clear. Highlights
persist per page. Lives in `src/content-scripts/clean.js` (`hashText`,
`markHighlightable`, `attachHighlighting`) with storage in `src/lib/db.js`.

### Interaction
Plain click, no affordance button. Two guards keep it from being annoying:
- `e.target.closest('a')` — a link is still a link.
- a collapsed-selection check — never fires while text is selected, so copying still works.

Selection is read from the **shadow root**, not the document (`root.getSelection()`);
`document.getSelection()` does not see inside a shadow tree in Chrome.

Every markable block carries the same padding whether highlighted or not, so toggling
changes colour only and never reflows the column.

### Identity: content, not position
A highlight is stored as an FNV-1a hash of the paragraph's normalised text, so it survives
re-extraction and page edits elsewhere in the article. Position-based ids would break the
moment anything above shifted. Hash collisions just mean two identical paragraphs
highlight together — harmless.

### Storage, and the trap that shapes it
Highlights live in IndexedDB via Dexie (schema v2, `highlights: 'url, updatedAt'`) — but
**a content script cannot write them directly**. A content script runs in the *page's*
origin, so Dexie there would write into each website's own IndexedDB: invisible across
sites, readable by the site, and wiped when the user clears site data.

So the content script messages the background worker, which owns IndexedDB:
`GET_HIGHLIGHTS` / `SET_HIGHLIGHTS` in [[message-contract]].

### The URL key drops the fragment
`pageKey()` strips `#fragment` before reading or writing. A fragment points *within*
the same document, so following an in-page anchor must not orphan highlights — found when
the smoke test clicked a link and the reload then restored nothing. Query strings are
**kept**, since `?id=123` often does select a different article.

### Known gaps
- Whole blocks only (`p`, `blockquote`); no sub-sentence ranges.
- No highlight list or jump-to-highlight UI, and no export of highlights.
- Nothing prunes storage for pages never revisited.
