---
tags: [feature, content-script]
related: [[reader-view]], [[markdown-export]], [[media-preservation]], [[reader-overlay-vs-dom-rewrite]]
---
# Distraction removal

Two separate jobs, often confused:

1. **On the live page** — `neutraliseOverlays()` hides `fixed`/`sticky` elements so cookie
   bars and sticky nav cannot paint over the reader, restoring their previous `display` on
   exit. `silencePage()` pauses playing media.
2. **In the extracted content** — `scrubJunk()` removes junk Readability kept *inside* the
   article. This is the one that leaks if you get it wrong, because it ends up in the
   reader, in saved copies, and in exports.

Junk tokens are split by strength, and the weaker ones spare anything carrying a real
picture — see [[media-preservation]]. Without that split the scrub deleted hero images.

## Three signals, because one is not enough

**Class/id tokens** (`ad`, `promo`, `newsletter`, `cookie`, `taboola`, …), matched per
hyphen/underscore token so `header-ad` hits but `badge` does not.

This requires `new Readability(clone, { keepClasses: true })` — Readability strips class
attributes by default, which would leave nothing to match on. Classes are removed again by
`stripClasses()` once the scrub has used them, so stored content stays lean.

**Live overlay text.** Before extraction, `overlayTexts()` collects the normalised text of
every `fixed`/`sticky` element on the real page. Any extracted block whose text matches is
furniture. This is the signal that catches banners Readability has **unwrapped** — it
rewrites `<div class="cookie-bar">` into a bare `<p>` with no class, so tokens can never
match it. Read from the live document; a clone has no computed styles.

**Self-announcing text** — blocks under 200 chars starting with "Advertisement",
"Sponsored", "Promoted".

## How the gap was found
Every check passed and the reader *looked* right, because the screenshots only showed the
top of the article. Reading the exported Markdown end to end showed
`🍪 COOKIE BANNER — We value your privacy.` as the final line. It had been in the reader
view all along, below the fold.

The smoke test now asserts the fixture's cookie-banner, newsletter and sticky-nav text
appear in neither the reader nor the export.

## Accepted risks
- An article genuinely about advertising with a class like `ad-analysis` loses that block.
- A page whose real article text is inside a `sticky` element would be over-scrubbed.
  Sticky *article* bodies are rare; sticky *furniture* is not.
- CSP blocks injection outright on a small share of sites. Expected, per CLAUDE.md.
