---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/plugin-registry": patch
---

`@aburi/types` exports `ImportBinding`, an `ImportEdge.symbols` entry split into the name the module exports and the local it binds. `@aburi/core`'s `ImportBinding` is now that type, so its fields are read-only, and `ImportBindingHalves` from `@aburi/plugin-registry/plugin-input` is an alias of it.
