---
"@aburi/core": minor
"@aburi/types": patch
"@aburi/cli": patch
---

An effect classification that runs past `classifyTimeoutMs` is now kept rather than dropped. `classify()` is synchronous, so its answer has already been computed by the time the clock is read. Dropping it saved no time and made the IR depend on how busy the machine was: the first classification in a process, on a loaded runner, could lose a real `db.write`, and with it the `logic` of its Symbol and of every caller it propagates to. The call is now classified, or handed to the next plugin when the answer was `null`, exactly as a fast call would be. The overrun is still recorded in `stats.effectClassifyTimeouts`, and the scan's warning now reads `N effect classification(s) ran past the per-call budget; their results were kept.` Effects, calls and fingerprints no longer depend on the machine's speed; only that record does.

An IR whose stats list no overrun keeps every fingerprint. One that lists overruns gains the effect of each one no later plugin claimed, so those Symbols and their callers get a new `logic` value once. For a plugin that overran on every call, that means effects it never contributed before. An IR scanned before this release, compared with one scanned after, reports those Symbols as logic changes, and there is no `grammarRevision` counterpart for `logic` to warn you that a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed version and is unaffected.
