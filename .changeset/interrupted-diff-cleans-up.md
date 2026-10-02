---
"@aburi/cli": patch
---

Interrupting `aburi diff` with Ctrl-C, a cancelled CI job or a closed terminal (`SIGINT`, `SIGTERM`, `SIGHUP`) now removes the base worktree and its temporary checkout before the process exits. It used to end without running that cleanup, so every interrupted run left a `(detached HEAD)` entry in `git worktree list` and a full checkout of the base revision under the temp directory. The run still ends with the signal's own 128+N status.
