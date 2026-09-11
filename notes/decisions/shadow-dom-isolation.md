---
tags: [decision, content-script, css]
related: [[reader-overlay-vs-dom-rewrite]], [[reader-view]], [[running-the-extension]]
---
# Reader view lives in a shadow root

**Decision:** `#cleanread-root` is a bare host element carrying only inline positioning;
everything visible is rendered inside `host.attachShadow({ mode: 'open' })`.

**Why — found by actually running it, not by reasoning.** The first version scoped every
rule under `#cleanread-root` and rendered into the light DOM. On a test page whose CSS
said:

```css
article { max-width: 700px; background: #fff; padding: 28px; }
```

…that rule hit our `<article class="cr-content">`, because host page CSS matches by tag
name and does not care about our id scoping. The reader view rendered with a white slab
behind the text and the wrong content width. Scoping selectors protects the *page* from
*us*; it does nothing to protect *us* from the *page*.

Real sites style bare `article`, `h1`, `p`, `blockquote` constantly, so this would have
hit a large fraction of pages. A shadow root is the only boundary CSS genuinely cannot
cross (only inherited properties pass, and we set those ourselves).

## What this forces

- **The stylesheet is imported as a string**: `import readerCss from './reader.css?inline'`,
  injected as a `<style>` inside the shadow root. It is deliberately *not* injected via
  the manifest — `content_scripts[].css` lands in the page, which cannot reach inside the
  shadow root. The built manifest now has no `content_scripts[].css`, which is correct.
- **Selectors changed** from `#cleanread-root .x` to `:host` / `:host([data-theme="dark"])`
  plus plain class selectors.
- **Custom properties are set on the host** and inherit inward, so [[reader-view]]'s live
  font/spacing/theme controls still work with no re-render.
- **The shell is defended with inline `!important`** (`all: initial`, `position: fixed`,
  `inset: 0`, `z-index: 2147483647`) since the host element itself is still in light DOM
  and a page could otherwise target `div#cleanread-root`.
- **Tests must pierce the boundary** — see [[running-the-extension]].

`mode: 'open'` rather than `'closed'`: it costs nothing defensively here and keeps the
view debuggable from the console and drivable from tests.
