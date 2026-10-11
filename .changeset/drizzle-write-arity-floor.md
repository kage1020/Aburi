---
"@aburi/effects-drizzle": minor
---

A zero-argument `insert`, `update` or `delete` is no longer recorded as `db.write`. Drizzle's own `insert(table)`, `update(table)` and `delete(table)` all take a table, so a class's own `this.update()` or a form's `form.delete()` in a file that imports `drizzle-orm` used to add a phantom write to the function's effects, at `medium`, and `db.delete()` one at `high`. Such a call now stays in `calls[]`, as a zero-argument `transaction` or `batch` already did. The floor is read from the method table in `src/methods.ts`, beside the maximum.

A Symbol that held such a write loses it, and so do the callers it propagated to, so their `logic` fingerprint moves once: an IR scanned before this release, compared with one scanned after, reports them as logic changes. Scanning the drizzle-orm repository with both versions changes nothing: 927 `db.write` effects before and after, and no fingerprint of its 8,641 Symbols moves. This repository has no Drizzle code. There is no `grammarRevision` counterpart for `logic` to warn you that a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
