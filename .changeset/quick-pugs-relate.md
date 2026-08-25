---
"@aburi/core": minor
---

Resolve a declared package against its manifest, so `packages: ['.']` names the workspace root

A pnpm or npm workspace pattern names a directory that holds a `package.json`, and is now
matched as `<pattern>/package.json` — the directory holding each match is the candidate. That
is what both managers mean by their patterns, measured with `pnpm ls -r`, and it is the rule
the nx detector already followed with `project.json`.

Matched as directories instead, two patterns meant something else entirely:

- `'.'` — the documented way to say "the workspace root is a package too" — is a glob that
  reaches every directory in the workspace. A two-package workspace holding `src/` and
  `a/b/c/d/` produced seven components named after incidental directories, and not the root.
- A literal path swallowed its own subtree: `'tools/build'` also produced `tools/build/nested`.

Two further changes fall out of the rule. A matched directory with no manifest is no longer a
component, because it is not a package to the manager that declared the pattern; and
`WorkspaceCandidate.manifestPath` is no longer nullable, since a candidate is now found by
finding its manifest.
