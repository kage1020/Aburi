---
"@aburi/lang-typescript": patch
---

A file of many namespaces no longer reads the statement list around each one again to find a class of the same name; the class names of each list are read once. A generated client of a few thousand namespaces is now extracted in well under a second instead of being skipped as `parse-timeout`, at the top level or inside one outer namespace. Such a file's Symbols reach the IR for the first time, so an IR scanned before this release, compared with one scanned after, reports them as added, once.
