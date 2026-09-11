---
tags: [decision, build, gotcha]
related: [[build-pipeline]], [[running-the-extension]]
---
# Entry files must not share a filename

**Decision:** entry points are `src/background/service-worker.js` and
`src/content-scripts/content.js`. Never two entries both called `index.js`.

**Why — this shipped broken and nothing noticed.** Both entries were originally
`index.js`. The build emitted `assets/index.js-DL6WdQvF.js` (background) and
`assets/index.js-DNVH2vgX.js` (content script), and `service-worker-loader.js`
imported **the content script**:

```
service-worker-loader.js -> import './assets/index.js-DNVH2vgX.js'   // Readability!
```

So the service worker ran the content script bundle. The real background — Dexie,
`onInstalled` — never executed in any build, including every one that passed the smoke
test.

## Why it hid for so long
The background only seeded default settings on install, and `getSettings()` merges over
`DEFAULT_SETTINGS` anyway, so nothing visibly broke. It surfaced only when
[[paragraph-highlighting]] needed the worker to answer messages.

The symptom was maximally misleading: `runtime.sendMessage` returned **`null` instead of
throwing**. A missing listener throws "Could not establish connection"; here the content
script bundle — running as the worker — registered its own `onMessage` and returned
`undefined` for message types it didn't know. So the call looked wired up and simply
did nothing.

## How to catch it
`dist/service-worker-loader.js` is one line naming the chunk it loads. Check that chunk is
the background:

```bash
cat dist/service-worker-loader.js
grep -l "onInstalled" dist/assets/*.js   # must be the same file
```

The smoke test now asserts this indirectly: highlights only round-trip if the real
background is running.
