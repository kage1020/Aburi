---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/diff": minor
"@aburi/markdown-projection": minor
"@aburi/framework-express": minor
---

Report a registration's middleware as logic, by name

Removing a middleware from an Express route (`router.get("/users", requireAdmin, h)` → `router.get("/users", h)`) was reported as a syntax-only change: the middleware is an argument, which is neither a rule nor an effect, so the only fingerprint it moved was `syntax`, and a route that lost its authorization check read in the report like a reformat. `--fail-on logic-changed` could not stop it.

- **IR.** A Symbol carries an optional `middleware`: what a framework registration runs before its handler, by name, in order. It is omitted when the Symbol names none, never `[]`, so every other Symbol is written as before.
- **Plugins.** `SymbolClassification` takes an optional `middleware`. The scan drops empty names, writes the rest in Unicode NFC, and keeps none on a dropped Symbol.
- **Fingerprint.** The `logic` fingerprint reads `middleware` when it is present, in order, so adding, removing, reordering or renaming one is a logic change. A Symbol without it hashes to the value it had.
- **Diff.** A changed Symbol's delta carries `middleware: { added, removed, reordered }` when either side names any, the lists compared as multisets of names, and the report writes ``- middleware removed: `requireAdmin` `` (and `added`, and `reordered: before → after`) under Logic changes. The component page and `aburi explain` show a **Middleware** line.
- **`@aburi/framework-express`** names a route's middleware as every handler argument but the last, and a `use`'s as every argument after the path, through arrays, spreads of arrays and every registration of a chain. Names are read off the syntax tree, so line breaks and comments do not reach them: `requireAdmin`, `auth.required`, `requireRole("admin")`, `rateLimit(…)` for an argument that is not a name or a literal, `...guards`, and `<computed>` for anything no name spells. An inline function is left out, its body being the registration's own.

**Logic values change once** for a route or `use` registration with a path that names middleware: an IR scanned before this release, compared with one scanned after, reports each as a logic change. Rescan the base rather than comparing against a stored IR; `aburi diff <base>..<head>` scans both sides and is unaffected.
