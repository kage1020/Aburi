---
"@aburi/cli": patch
---

A write that stdout or stderr refuses for any reason but a reader that left (a descriptor opened read-only, a full disk) no longer ends `aburi` at the write with Node's stack. The run finishes and cleans up, so `aburi diff` removes its base worktree and temporary directory, then exits 1 with one line on the other stream naming the stream and the error, such as `aburi: could not write to stderr: EBADF`.
