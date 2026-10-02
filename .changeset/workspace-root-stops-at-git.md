---
"@aburi/core": patch
"@aburi/cli": patch
---

The workspace-root walk now stops at the first `.git`.

That is a `.git` directory, or a `.git` file opening with `gitdir:`, which is what a linked worktree or a submodule has; any other file of that name is passed over. So `aburi scan` and `aburi diff` root at the repository they run in rather than at an outer marker above it. `aburi diff` scanned the base revision in a worktree of the repository and the head from the outermost marker, so in a worktree kept inside the main checkout, in a nested repository or submodule, and with `TMPDIR` inside the repository, the two sides covered different trees (`component-detect.md` §11.1). A base scan that roots anywhere but its worktree now ends the diff as a bug in Aburi rather than being compared.

A monorepo whose root holds its `.git` is unaffected. Config discovery still climbs past the workspace root, so a repository nested under a directory with an `aburi.json` keeps reading that config, and its relative paths now resolve against the inner repository.
