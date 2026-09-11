---
tags: [decision, workflow]
related: [[00-index]]
---
# Obsidian vault root = repo root

**Context:** the repo arrived with the vault nested in a folder called `Extension 2/`
holding only Obsidian's default `Welcome.md`, while CLAUDE.md describes notes living at
`/notes/` in the repo root.

**Decision:** moved `.obsidian/` up to the repo root and deleted `Extension 2/`.

**Why:** CLAUDE.md's workflow depends on `/notes/00-index.md` resolving from the repo root,
and `[[wikilinks]]` only resolve inside the vault. With the vault nested one level down,
the notes folder would have sat outside it and every link would have broken. Vault root and
repo root being the same path is what makes "any `.md` anywhere in the repo is part of the
vault" true, as CLAUDE.md states.

Obsidian settings were preserved — only the vault root moved.
