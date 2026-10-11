---
"@aburi/lang-typescript": patch
---

Two namespace imports of one module on one line, or a side-effect import beside a namespace import of the same module, no longer collapse into one import edge, so calls through the second namespace resolve. The plugin manifest now declares the `call-statement`, `chained-call`, `path-literal` and `argument-names` rationale prefixes its registration Symbols already emitted.
