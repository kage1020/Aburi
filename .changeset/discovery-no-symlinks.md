---
"@aburi/core": patch
---

Discovery no longer follows symlinks. A linked directory such as `shared -> src` used to list every file under it a second time, giving each a second Symbol id and doubling every change `aburi diff` counted. A link out of the workspace put that machine's files into the Document, and a cyclic link was expanded once. No link, to a file or a directory, is a candidate now, which is how git treats one. Component detection's language census and the nx detector's search for `project.json` make the same decision.

Only a workspace that holds symlinks sees a difference. There, an IR scanned before this release, compared with one scanned after, reports the Symbols that were reached only through a link as removed, once, and a component's `languages` no longer counts files only a link reaches. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with this release and is unaffected.
