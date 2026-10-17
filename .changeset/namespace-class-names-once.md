---
"@aburi/lang-typescript": patch
---

A file of many namespaces no longer reads the statement list around each one again to find a class of the same name: each list's class names are read once, so the number of children read grows with the file rather than with its square, at the top level or inside one outer namespace. A file that timed out on the repeated reads, such as a generated client of a few thousand namespaces, is now extracted instead of being skipped as `parse-timeout`. Such a file's Symbols reach the IR for the first time, so a diff against an IR scanned before this release reports them as `unknown` (`absentFrom: "base"`, `reason: "parse-timeout"`) until the base is rescanned.
