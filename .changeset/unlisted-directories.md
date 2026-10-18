---
"@aburi/core": patch
"@aburi/cli": patch
---

A directory the scan cannot list now ends the run at exit 1 and names it, as a file the scan cannot open already did. The walk took a failed listing for an empty directory, so a permission, an exhausted descriptor table or failing storage removed every file under it from `symbols`, `stats.totalFiles` and `stats.skippedFiles` alike, and `aburi scan` exited 0: with `src/locked` unreadable beside `src/a.ts`, the IR held `src/a.ts` alone and nothing mentioned `src/locked/b.ts`. The same scan now stops with `Directory "<workspace>/src/locked" could not be listed: EACCES: permission denied, scandir …`. A directory that is gone by the time it is listed is still passed over, and so is one that `.gitignore` excludes while `.gitignore` is honoured: git never lists it and none of its files can reach the IR, so a data directory a container owns does not stop a scan. With `respectGitignore` off its files are scanned, and failing to list it ends the run too.

Component detection follows the same rule in its language census, in the nx detector's search for `project.json` and in the resolution of `pnpm-workspace.yaml` and `workspaces` patterns, where a directory that cannot be listed hides every package below it. `aburi init` reports it at exit 1 rather than 2, since no edit to a config fixes it. `detectManagers` takes `{ respectGitignore }`, which decides only whether a directory `.gitignore` excludes may go unlisted.

A workspace whose directories can all be listed scans as before: an IR scanned before this release, compared with one scanned after, is identical. An IR written before this release on a machine that could not list a directory lacks the Symbols under it, and `aburi diff` against it reports them as added; that machine's run now ends instead of writing it. Rescan the base there rather than comparing against the stored IR.
