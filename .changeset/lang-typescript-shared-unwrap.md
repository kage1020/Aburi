---
"@aburi/lang-typescript": patch
---

Values are read through `@aburi/core`'s `unwrapValue` in place of the plugin's own copy of it, the reader framework plugins classify a `const` with, so a Symbol's name and its framework role cannot read different wrappers. No Symbol, name or fingerprint changes.
