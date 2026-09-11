---
tags: [feature, export]
related: [[reader-view]], [[save-article]], [[distraction-removal]], [[pdf-export]]
---
# Markdown export

Turndown converts the already-cleaned article to Markdown. `src/lib/export-markdown.js`
(`toMarkdown`, `markdownFilename`), delivered by `src/lib/download.js`.

Available from two places: the popup ("Export Markdown", exports the current page) and the
saved-article page ("Download Markdown", exports the stored copy).

### Why there is no `downloads` permission
`downloadText()` builds a Blob, makes an object URL and clicks a synthetic `<a download>`.
That works from any extension **page**, so the extension never asks for the `downloads`
permission — one less thing to justify in store review.

It cannot run in the background worker: a service worker has no `URL.createObjectURL`.
That is the reason export lives in the popup and reader page rather than the worker.
The object URL is revoked on a timer, not immediately — revoking at once truncates the file.

### Output shape
```markdown
# Title

**By Author** · Site · 2 min read

[View original](https://…)

---

…body…
```
ATX headings, `-` bullets, fenced code, `_emphasis_`. One custom rule keeps `figcaption`
text as an italic caption instead of letting it run into the body as a stray sentence.

### Input is already clean
It converts `article.content`, which has been through Readability *and* the scrub, so the
exporter never reasons about page junk — see [[distraction-removal]]. The smoke test
asserts the output carries no raw HTML, no `class=` attributes, and none of the fixture's
ad or cookie-banner text.

### Maths
Equations export as LaTeX rather than as images of equations — see [[math-rendering]].

### Known gaps
- No YAML front matter option (some vaults want `---` metadata blocks).
- Images are referenced by their original absolute URLs; nothing is downloaded.
- No "export all saved articles" — one at a time.
