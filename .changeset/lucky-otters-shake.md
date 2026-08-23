---
"@aburi/cli": minor
---

Look for the IR where a scan would have written it, from the working directory upward

`aburi scan` writes its artefacts under the directory it was run from. `aburi explain` looked
for them under the detected workspace root. Those are the same directory in a single-package
repository and different in a monorepo package, so a scan in `pkgs/app` wrote
`pkgs/app/out/aburi.ir.json` and the lookup read `mono/out/aburi.ir.json`, found nothing, and
rescanned — correct but slow, and silent about why.

Anchoring the lookup to the working directory instead would have traded one broken flow for a
commoner one: scanning at the repository root and asking from inside a package is ordinary. Both
documents describe the same tree, because a scan covers the whole workspace wherever it was
started. So the lookup now walks up from the working directory to the workspace root and takes
the nearest `out/aburi.ir.json`. Upward and nearest-first is what config discovery does; the
difference is that this stops at the workspace root, because an `out/` above it holds a document
about a different tree, while a config above it may deliberately be shared across repositories.

**A visible change of answer source.** From a package directory, `aburi explain` now reads the
IR a scan wrote there rather than rescanning every time, so an edit made since that scan is not
reflected until `aburi scan` runs again. That is what an on-disk IR means everywhere else in the
CLI; the previous behaviour was a miss that happened to look like freshness.

`--ir` is unchanged and still resolves against the working directory. `--no-rescan` now names
the nearest candidate — where a scan run here would have put it — and the root it searched up
to.

The artefact names `aburi.ir.json`, `workspace.md`, `components` and the default output
directory moved into the module that already holds `diff.json` and `diff.md` for this reason,
and one function resolves the output directory for `scan`, `diff` and `explain` alike.
