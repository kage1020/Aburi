---
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

Give what a file does when it is imported a Symbol, `<module>`

A top-level statement that declares nothing (`await prisma.user.deleteMany({})`, `doThing()`, `process.on("SIGTERM", () => shutdown())`, a top-level `for` or `try`) was in no Symbol, so a file that empties a table when it is imported reported no effect anywhere.

- **IR.** A file with such statements gets one Symbol for them, `<module>`, with `kind: "module"`, visibility `internal` and `derivedBy: ["module-scope"]`. It holds them in source order, along with the statements of the file's namespace bodies. A callback written in one of them is absorbed into it, as into any parent. Declarations, imports and exports, registrations that have a Symbol of their own, and directives (`"use client"`) stay out. A file with none of them has no `<module>`.
- **Qualified names.** `<module>` is the second reserved name beside `<default>`, and `@aburi/core` exports it as `MODULE_SCOPE_QNAME`.
- **Effects.** `<module>` carries the effects of the calls it makes, and by propagation those of the functions it calls. Nothing calls it and an import is not a call, so a file that imports it inherits none of them.
- **Consts.** A const initialised by an immediately invoked function (`export const h = (() => { q() })()`) has that function as its body, with `derivedBy` carrying `invoked-function`. It was a `const` with no body before, and `q` was in no Symbol.

**Test files get a `<module>`.** Their `describe` and `it` blocks are their top-level code. Scanning this repository goes from 9,120 calls to 36,220, and the IR grows by about 60%. `"ignore": ["**/*.test.ts"]` leaves tests out of the scan.

**Older readers.** An Aburi released before this one refuses a stored IR that holds a `<module>` Symbol, because its qualified-name check does not know the name. `aburi diff <base>..<head>` scans both sides with the running version and is unaffected.
