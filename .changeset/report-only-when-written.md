---
"@aburi/cli": patch
"@aburi/github-action": patch
---

`aburi diff` now removes the `diff.json` and `diff.md` an earlier run left in the output directory before it compares anything, as it already did `diff.full.md`. A run that stops first — a plugin that fails to load, a strict scan's undeclared value — leaves no report behind, instead of one describing some other diff.

The GitHub Action sets `diff-json-path` and `diff-md-path` only for a file this run wrote, and as absolute paths. The comment step used to run on every exit 3, including a plugin error's, and then failed on a missing `diff.md` or posted the one an earlier run left; it also prefixed the path with `working-directory`, so an absolute `output-dir` failed the upsert with ENOENT on a diff that had succeeded.
