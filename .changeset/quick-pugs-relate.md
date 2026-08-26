---
"@aburi/core": minor
---

Resolve a declared package against its manifest, so `packages: ['.']` names the workspace root

A pnpm or npm workspace pattern names a directory that holds a `package.json`, and is now
matched as `<pattern>/package.json` — the directory holding each match is the candidate. That
is what both managers mean by their patterns, measured with `pnpm ls -r`, and it is the rule
the nx detector already followed with `project.json`.

Matched as directories instead, two patterns meant something else entirely:

- `'.'` is a glob that reaches every directory in the workspace. A two-package workspace holding
  `src/` and `a/b/c/d/` produced seven components — six of them named after incidental
  directories — and the workspace root, the one directory `'.'` names, was not among them.
- A literal path swallowed its own subtree: `'tools/build'` also produced `tools/build/nested`.

Four further changes fall out of the rule:

- A matched directory with no manifest is no longer a component, because it is not a package to
  the manager that declared the pattern. Where *no* matched directory holds one, detection falls
  through to the single-project fallback and the whole repository becomes one component.
- Only `package.json` is recognized. pnpm also accepts `package.yaml` and `package.json5`; a
  package declared in either was a manifest-less candidate before and is not detected now.
- `WorkspaceCandidate.manifestPath` is no longer nullable, since a candidate is now found by
  finding its manifest.
- A `**` pattern reaches ten directory levels rather than eleven, which is the ceiling the glob
  conventions always documented.

Which of the resolved directories become components is unchanged and is Aburi's own rule: the
workspace root is a component when a pattern names it, where to pnpm the root is a workspace
project whether or not one does.
