---
"@aburi/lang-typescript": patch
---

Calls in a `catch` block, and everything in a `finally` block, are now part of the enclosing Symbol. Neither block was walked, so a database write, an HTTP call or an event publish added in either one reached no `calls[]` or `effects[]`, and `aburi diff` reported the edit as a syntax-only change. The `finally` block is walked like the `try` block, since it runs on every path; the `catch` block still contributes no rules, as `ir-schema.md` §8.1 specifies, only its calls.
