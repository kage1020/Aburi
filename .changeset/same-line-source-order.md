---
"@aburi/core": minor
---

Effects and calls that share a line now keep the order the language plugin wrote them in, which is source order, as the IR schema states. Before, they were sorted by target. Swapping two effects on one line (`await a.save(); await b.log()` becoming `await b.log(); await a.save()`) now moves the `logic` fingerprint. Renaming one of the targets no longer reorders them. A Symbol with two or more effects on one line, whose targets were not already in that order, gets a new `logic` fingerprint. So the first diff against an IR scanned before this release reports such Symbols as logic-changed.
