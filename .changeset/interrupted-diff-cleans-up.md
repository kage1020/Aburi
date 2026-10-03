---
"@aburi/cli": patch
---

Interrupting `aburi diff` with Ctrl-C, a cancelled CI job or a closed terminal (`SIGINT`, `SIGTERM`, `SIGHUP`) now removes the base worktree and its temporary checkout before the process exits. It used to end without running that cleanup, so every interrupted run left a `(detached HEAD)` entry in `git worktree list` and a full checkout of the base revision under the temp directory. The run still ends on the signal rather than reporting success: on POSIX with the signal's own 128+N status, and on Windows with an exit code of that same 128+N. Collecting git renames now happens before the temporary directory is created, so a failure there no longer leaves that directory behind either.
