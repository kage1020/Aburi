---
"@aburi/types": minor
"@aburi/diff": patch
---

`representativeSymbol` is a new export: the head's Symbol of a pair, and the one Symbol of any other change. The report files a change under it and `--fail-on-scope` judges the change by it, and `@aburi/diff` reads it from here in place of its own copy, so the three cannot drift apart. No output changes.
