---
"@aburi/core": patch
---

`.gitignore` is now matched by Aburi's own port of git's rules rather than the `ignore` package, so discovery keeps and drops the same files git does. A deeper `.gitignore` that re-includes a directory (`!ourlib/` under a root `third_party/*`) brings its files back; they used to be missing from the IR, `stats.totalFiles` and `stats.skippedFiles` alike. `src/**/` matches directories only, a lone `!` no longer undoes the rules before it, and POSIX classes, `\?` and a leading `]` in a bracket now match. Rule length is measured in bytes, and a rule git can never match, such as one with an unterminated bracket, now matches nothing instead of failing the scan.

Only a workspace whose `.gitignore` holds one of these shapes sees a difference. There, an IR scanned before this release, compared with one scanned after, reports the Symbols of each file that changed sides as added or removed, once, and a component's `languages` is counted over the same files. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with this release and is unaffected.
