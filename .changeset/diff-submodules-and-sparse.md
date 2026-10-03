---
"@aburi/cli": patch
---

`aburi diff <base>..<head>` leaves submodules out of the file scans and refuses a sparse checkout

Submodules are now left out of both file scans, with the warning `Submodules detected: <list>. Submodule-aware diff is not yet supported, so their files are left out of both file scans. Component detection still walks them, so a workspace package inside one can still be reported as a Component added or removed.` The base worktree has no submodules checked out while the head working tree does, so every Symbol of an unchanged submodule used to be reported as added, tripping `--fail-on added` on every pull request from a clone with initialised submodules.

A sparse checkout (`core.sparseCheckout` set to `true`, `1`, `yes` or `on`) now stops the run with exit 1 and `Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable`, as `cli-spec.md` §6.4.1 already required, instead of diffing a partial tree whose missing files read as removed.
