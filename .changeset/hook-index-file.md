---
"@aburi/cli": patch
---

`aburi diff` run from a commit hook no longer changes the commit being made

Inside a commit hook git exports `GIT_INDEX_FILE`, and `aburi diff <base>..<head>` passed it to
`git worktree add`, which then checked the base revision out into that index. Where the path is
absolute, the commit silently recorded the base revision's tree instead of the staged change:
`git commit -a` and `git commit <paths>` export one in the main worktree, and every commit,
plain `git commit` included, exports one in a linked worktree. From a plain `git commit` in the
main worktree the worktree step failed and the hook exited 1. The git commands `aburi diff` runs
no longer inherit `GIT_INDEX_FILE` or `GIT_PREFIX`; `GIT_DIR`, `GIT_WORK_TREE` and the caller's
`-c` settings are still passed on.
