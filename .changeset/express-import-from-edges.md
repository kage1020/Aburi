---
"@aburi/framework-express": minor
---

Whether a file imports `express`, which decides between `high` and `medium` for every kept Symbol whose confidence reads the import, is now read from the file's parsed import edges instead of regular expressions over its text. A named import wrapped over several lines, as a formatter writes it, no longer drops the file's routes, middleware and Routers to `medium`, so reformatting an import is no longer reported as confidence changes; a commented-out `import express from "express"` no longer raises a non-Express file to `high`. An import of an `express/…` subpath and a re-export from `express` count too.

Where no edge names `express`, the text is still read, now as tokens, with comments skipped and string, template and regular-expression literals stepped over. It answers for CommonJS `const express = require("express")`, which produces no edge, and for an import the edges miss although it is written: one the parser lost to merge-conflict markers or junk after it, or one inside a `declare module` block. An import or `require` that is only a comment, or only text inside a string, no longer counts; a `require` with its specifier in backticks does. JSX text holding a quote or a backtick can still mislead that reading on the lines it spans.

`classifyExpressSymbol`, `hasExpressImport` and `ExpressFrameworkPlugin.classifySymbol` now take the `FrameworkClassifyContext` the scan already passed instead of `ExtractionContext`, so a caller that builds the context itself has to add the file's `imports`.

No fingerprint reads confidence, so no fingerprint moves. An IR scanned before this release, compared with one scanned after, reports a confidence change on every kept Symbol whose confidence reads the import, in a file whose answer changed: one with a wrapped import, an import or `require` left in a comment or quoted in a string, a `require` in backticks, an `express/…` subpath, or a re-export from `express`. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
