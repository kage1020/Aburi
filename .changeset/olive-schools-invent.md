---
"@aburi/core": minor
"@aburi/cli": patch
---

Read a component's identity from its package manifest, not from whichever detector arrived first

A directory two detectors claim is described by two manifests. It now keeps both — plus the
`package.json` under its root whether or not a detector reported it — and they are read in the
order `component-detect.md` §4.1 gives, by filename, so the order the detectors ran in cannot
move a Component's id.

Before, the first candidate merged kept its manifest and the other was discarded. `nx` sorts
before `pnpm`, so in an nx workspace using pnpm the `project.json` won every directory that had
both, and the `package.json` beside it was dropped along with everything only it carries:

- `id` and `name` came from `project.json#name` — the nx project name — rather than from the
  published npm name the rest of the Document is written against.
- `frameworks` and `publicApi` were empty, because `dependencies` and `exports` are npm fields
  and an nx project file has neither.

In an nx workspace with no `pnpm-workspace.yaml` and no `workspaces` key, no detector reported
those `package.json` files at all, so the same three fields were lost there whatever the merge
did. `buildComponent` reads the one under each candidate root now, which is also what makes the
fix independent of an unrelated file elsewhere in the workspace.

§4.1 and §4.2 name `project.json#name` as a source below `package.json#name`, which is what an
nx-only directory with no `package.json` has always used in practice: its id and name are
unchanged. Three things are new for it:

- `frameworks` and `publicApi` are read from the `package.json` alone, so a `project.json` with
  a `dependencies`- or `exports`-shaped key — an nx target option may be any JSON — no longer
  produces either.
- A `package.json` beside the `project.json` supplies all five fields, as above.
- A manifest that is present and cannot be read — bad JSON, or an IO failure that is not "no
  such file" — aborts detection with `workspace-manifest-malformed` naming the file, rather
  than being silently skipped. `aburi scan` reports that code as a config error and exits 2,
  which `detectPnpm`'s existing throw of the same code was not doing either.

A `name` that is not a string is passed over rather than crashing the run, and a `name` that
yields no id — `@scope/` — no longer stops §4.1's search at the directory name.
