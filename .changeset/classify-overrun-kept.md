---
"@aburi/core": minor
"@aburi/types": patch
"@aburi/cli": patch
---

An effect classification that runs past `classifyTimeoutMs` is now kept rather than dropped. `classify()` is synchronous, so its answer has already been computed by the time the clock is read. Dropping it saved no time and made the IR depend on how busy the machine was: the first classification in a process, on a loaded runner, could lose a real `db.write`, and with it the `logic` of its Symbol and of every caller it propagates to. The call is now classified, or handed to the next plugin when the answer was `null`, exactly as a fast call would be. The overrun is still recorded in `stats.effectClassifyTimeouts`, and the scan's warning now reads `N effect classification(s) ran past the per-call budget; their results were kept.` An overrun now changes that record and nothing else in the IR.

An IR whose stats list no overrun keeps every fingerprint. One that lists overruns gains the effect of each one no later plugin claimed, so those Symbols and their callers get a new `logic` value once. For a plugin that overran on every call, that means effects it never contributed before. An IR scanned before this release, compared with one scanned after, reports those Symbols as logic changes, and there is no `grammarRevision` counterpart for `logic` to warn you that a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed version and is unaffected.

A kept classification also meets the vocabulary check, which a dropped one skipped. With `strict` on (the default), an effects plugin that emits an effect id its manifest does not declare now fails the scan with `vocab-undeclared` even when that call overran, and with `strict: false` the id is listed in `aburi-vocab-discovered.json`. Before, a slow enough call let such a scan pass. Core effect ids such as `db.write` are exempt, so only plugins with their own vocabulary can meet this.
