---
"@aburi/diff": patch
"@aburi/markdown-projection": minor
---

A decorator whose receiver changed is reported as modified

`@nest.Post("/x")` → `@tsed.Post("/x")` reported the decorator list as unchanged while the
api fingerprint moved, because `decoratorsEqual` compared only the name and arguments. It
compares `qualifier` now, and the Markdown names a modified decorator with its receiver
(`@tsed.Post`). Two Documents written before `qualifier` existed report nothing new; a base
stored by such a producer and passed with `--base` against a newer head reports each qualified
decorator as modified, once.
