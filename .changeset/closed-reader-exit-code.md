---
"@aburi/cli": patch
---

`aburi` now exits with its command's own code when the reader of its stdout or stderr stops early. `aburi diff main..HEAD | head -1` used to exit 1 on a clean diff and on a tripped gate alike, with `Error: write EPIPE` on stderr: Node reports the closed pipe as an `error` event on the stream, and the bin had no listener for it. Under `set -o pipefail`, which GitHub Actions uses for `shell: bash`, that failed the step. The same pipe now exits 0 or 3, as without it; `aburi scan 2>&1 | head -1` exits 0 on a workspace with recoverable parse errors, and `aburi explain` listing candidates into a closed pipe exits 2 rather than the 1 that means "not found". A run whose stderr reader has left no longer dies at its next warning either: for `aburi diff` that was the base scan's incident report, and the run ended there with the base worktree and its temporary checkout left behind. Any other failure to write a stream, such as stdout redirected to a full disk, still exits 1.

`runScan` no longer swallows an exception thrown by its `incidents.warn` sink. The catch was meant for a closed pipe, which never arrives as a throw from a stream's `write()`; all it could still catch was a sink that throws or a fault in the report itself, and it hid both. `runScan` now rejects with that exception.
