---
"@aburi/lang-typescript": minor
---

The `syntax` fingerprint now reads a union written with a leading `|`, or an intersection with a leading `&`, as the same type written without it. A formatter writes that `|` when it breaks a union over lines and drops it when it joins the union again, and the parser gives the leading form an extra level, so joining `provider:` / `| ClassProvider` / `| ValueProvider` onto one line changed the `syntax` fingerprint of whatever serialized it: the class holding a method with that parameter, a function with a bodiless overload taking it, and, now that a function's parameter list reaches its `syntax` fingerprint, the function itself. That edit is now no change to `api` or `syntax`, wherever the union is written.

This moves the `syntax` fingerprint, once, of every Symbol whose normalized string holds such a union, so an IR scanned before this release, compared with one scanned after, reports those Symbols as syntax-only changes and trips `--fail-on changed` or `syntax-changed`. On this repository no kept Symbol holds one and nothing moves; on the `nest` repository 53 of 5404 Symbols move (21 classes, 13 functions, 12 methods, 6 constructors and a const), and no `api` or `logic` fingerprint. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
