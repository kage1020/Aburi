---
"@aburi/types": patch
"@aburi/core": patch
---

`@aburi/types` exports the `derivedBy` tokens a language plugin writes for how a declaration is exported: `EXPORT_KEYWORD_DERIVED_BY` (`export-keyword`), `EXPORT_DEFAULT_DERIVED_BY` (`export-default`) and `EXPORT_CLAUSE_DERIVED_BY_PREFIX` (`export-clause:`, followed by the name a clause exports the declaration under). `@aburi/lang-typescript` writes them, and `@aburi/framework-next` and `@aburi/core`'s call resolution read them, so each is spelled once. Nothing a scan writes changes.
