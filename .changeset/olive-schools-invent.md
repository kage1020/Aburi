---
"@aburi/core": minor
---

Read a component's identity from its package manifest, not from whichever detector arrived first

A directory two detectors claim is described by two manifests. It now keeps both, and they are
read in the order `component-detect.md` §4.1 gives — by filename, so the order the detectors ran
in cannot move a Component's id.

Before, the first candidate merged kept its manifest and the other was discarded. `nx` sorts
before `pnpm`, so in an nx workspace using pnpm the `project.json` won every directory that had
both, and the `package.json` beside it was dropped along with everything only it carries:

- `id` and `name` came from `project.json#name` — the nx project name — rather than from the
  published npm name the rest of the Document is written against.
- `frameworks` and `publicApi` were empty, because `dependencies` and `exports` are npm fields
  and an nx project file has neither.

Both are read from the `package.json` now. §4.1 and §4.2 name `project.json#name` as a source
below `package.json#name`, which is what an nx-only directory has always used in practice: its
id and name are unchanged. What is new there is that `frameworks` and `publicApi` are read from
the `package.json` alone, so a `project.json` with a `dependencies`- or `exports`-shaped key —
an nx target option may be any JSON — no longer produces either.
