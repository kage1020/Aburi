---
"@aburi/framework-express": minor
---

Whether a file imports `express`, which decides `high` or `medium` confidence for every Symbol framework-express classifies, is now read from the file's parsed import edges instead of regular expressions over its text. A named import wrapped over several lines, as Prettier writes it, no longer drops every Express Symbol in the file to `medium`, so reformatting an import is no longer reported as confidence changes; a commented-out `import express from "express"` no longer raises a non-Express file to `high`. An import of an `express/…` subpath and a re-export from `express` count too. CommonJS `require("express")`, which produces no import edge, is still read from the source, now with comments removed.

`classifyExpressSymbol`, `hasExpressImport` and `ExpressFrameworkPlugin.classifySymbol` now take the `FrameworkClassifyContext` the scan already passed instead of `ExtractionContext`, so a caller that builds the context itself has to add the file's `imports`. `requiresExpress` is exported.

No fingerprint reads confidence, so no fingerprint moves. An IR scanned before this release, compared with one scanned after, reports a confidence change on every Symbol framework-express classifies in a file whose answer changed: one with a wrapped import, an import or `require` left in a comment, an `express/…` subpath, or a re-export from `express`. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
