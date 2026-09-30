---
"@aburi/cli": patch
---

`aburi diff` run from a commit hook no longer changes the commit being made

Inside a commit hook git exports `GIT_INDEX_FILE`, and `aburi diff <base>..<head>` passed it to
`git worktree add`, which then checked the base revision out into that index. From `git commit
-a` or `git commit <paths>` the commit silently recorded the base revision's tree instead of the
staged change; from a plain `git commit` the worktree step failed and the hook exited 1. The git
commands `aburi diff` runs no longer inherit `GIT_INDEX_FILE`, `GIT_WORK_TREE`,
`GIT_IMPLICIT_WORK_TREE` or `GIT_PREFIX`, which describe the caller's working tree; `GIT_DIR` and
the caller's `-c` settings are still passed on.
