---
"@aburi/lang-typescript": patch
"@aburi/core": patch
"@aburi/framework-nestjs": patch
"@aburi/types": patch
---

A call through a default import now resolves to the module's default export. `import connect from "./client"` was read as a named import of `connect`, so `connect()` linked at `high` confidence to the module's named `connect` (and took its effects) when the default export was another function, and a default export that was anonymous (`export default () => …`) or imported under another name than its declaration's was never reached. The language plugin now reports a default binding as `default as <local>`, as `{ default as x }` already was, and call resolution looks it up as the file's `<default>` Symbol or the declaration carrying `export-default`, including a member reached through it (`Svc.run()`). The NestJS plugin keeps reading a default-imported decorator by the name the file gave it.
