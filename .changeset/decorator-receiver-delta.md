---
"@aburi/diff": patch
"@aburi/markdown-projection": patch
---

A decorator whose receiver changed is reported as modified

`@nest.Post("/x")` → `@tsed.Post("/x")` reported the decorator list as unchanged while the
api fingerprint moved, because `decoratorsEqual` compared only the name and arguments. It
compares `qualifier` now, and the Markdown names a modified decorator with its receiver
(`@tsed.Post`). A Document written before `qualifier` existed reports nothing new.
