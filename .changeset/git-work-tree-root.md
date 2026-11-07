---
"@aburi/core": minor
"@aburi/cli": patch
---

The workspace-root walk now honours a working tree whose repository is kept elsewhere. `detectWorkspaceRoot` takes `env` (`GIT_DIR`, `GIT_WORK_TREE`) and stops at `GIT_WORK_TREE` the way it stops at a `.git`. With `GIT_DIR` set alone and no `.git` on the way up, it roots at the start directory, which git takes as the top of its working tree. The CLI passes its own environment. So `aburi diff <base>..<head>` under `GIT_DIR=… GIT_WORK_TREE=…`, with a workspace marker above the work tree, no longer roots the head above the base worktree and reports every Symbol as moved under the work tree's name.
