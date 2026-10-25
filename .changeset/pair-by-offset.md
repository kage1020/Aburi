---
"@aburi/diff": patch
---

An edited rule, call or decorator is paired with its predecessor by its line within the Symbol rather than its line in the file, so an edit in a Symbol that moved down its file reads as `modified` where it read as one `removed` and one `added`.
