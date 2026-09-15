---
tags: [feature, content-script, rendering]
related: [[chart-preservation]], [[media-preservation]], [[reader-view]]
---
# Keeping embedded players

[[media-preservation]] covers pictures and [[chart-preservation]] covers SVG charts.
This is the third way an article loses its illustrations: **video**.

Measured on a live article: **6 embedded players on the page, 0 in the reader** —
while every paragraph of text came through perfectly.

## Why they vanished

Readability's `_prepArticle` runs `this._clean(articleContent, "iframe")`. That
deletes every iframe **except** ones whose attributes match `_allowedVideoRegex`:

```
//(www.)?((dailymotion|youtube|youtube-nocookie|player.vimeo|v.qq).com
  |(archive|upload.wikimedia).org|player.twitch.tv)
```

A hardcoded list of five hosts. Any site that serves video from its own player —
which is most large publishers now — loses every clip in the article. There is no
scoring involved and nothing to tune: the embed is simply not on the list.

## The fix

The same stand-in trick as [[chart-preservation]]: `standInForEmbeds()` replaces
each content-sized `<iframe>` and `<video>` in the clone with an `<img>`
placeholder carrying its real dimensions, which Readability counts as media and
keeps. `restoreEmbeds()` puts the real element back after extraction.

- **Ads are still dropped.** An iframe whose `src` matches `AD_HOST`
  (doubleclick, googlesyndication, taboola, criteo, …) never gets a placeholder,
  and the wrapper scrub in [[distraction-removal]] still applies.
- **Shape is kept as a ratio**, not pixels. The player was sized for the site's
  column, not the reader's, so `width`/`height` are dropped and
  `aspect-ratio` is set inline. Without that the frame collapses to nothing.
- `loading="lazy"` is added, so a page of clips does not fetch them all at once.

## What this does not do
- The embed is the **live remote player**, so it makes the same network requests
  it would on the original page. That is what makes it play at all, but it means
  the reader is not fully offline for these figures.
- A saved article keeps the iframe markup, so an offline reading list entry shows
  the player frame but cannot load the video without a connection.
- Markdown export has no representation for a player; only the caption survives.

Covered by `scripts/fixtures/media-article.html`, which carries a self-hosted
iframe, a native `<video>`, and an advertising iframe that must still be dropped.
