---
"@aburi/cli": patch
---

`aburi diff <base>..<head>` now leaves submodules out of both scans and warns `Submodules detected: <paths>. Submodule-aware diff is not yet supported, so their files are left out of both sides.` The base worktree has no submodules checked out while the head working tree does, so every Symbol of an unchanged submodule used to be reported as added, tripping `--fail-on added` on every pull request from a clone with initialised submodules. A sparse checkout (`core.sparseCheckout=true`) now stops the run with exit 1 and `Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable`, as the spec already required, instead of diffing a partial tree.
