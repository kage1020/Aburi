---
"@aburi/cli": patch
---

`aburi diff <base>..<head>` now warns when `core.symlinks` is false and the base ref holds symbolic links. Under that setting, which is what a Windows machine that cannot create links gets, git checks each link out in the base worktree as a plain file holding its target, and the base scan then reads it as source. The warning names the links under the workspace root and how to keep them as links. Previously the spec listed this check, but nothing ran it.
