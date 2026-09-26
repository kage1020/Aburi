---
"@aburi/lang-typescript": minor
"@aburi/core": minor
"@aburi/diff": patch
---

An export of a namespace merged into a class is named as the class's static member, and a call through the class name reaches it

`class C { m() {} }` beside `namespace C { export function m() {} }` produced one Symbol, `C.m`,
carrying the method's range and both bodies' calls. The export is now `C::m`, the static member
TypeScript resolves it as, and the method keeps `C.m`. Ids of every such export change from `C.x`
to `C::x`, and so do the ids of everything declared under one (`C::Inner.g`). What the namespace
does not export keeps the dot (`C.local`).

Other effects visible in a Document or a diff against an older one:

- The instance member no longer folds with the export, so it loses `declaration-merged` and its
  `mergedDeclarations`. Its syntax fingerprint changes, and a diff against an older Document
  reports it as modified though nobody touched it.
- A namespace holding only types may be written before the class. There its `export type m`
  used to lead the fold, so the Symbol was a dropped `type` and the method's calls and effects
  went nowhere. They now appear on `C.m`, with `C::m` the dropped type.
- A `static m()` beside `export function m()` in the namespace is now one Symbol, `C::m`,
  where it was two (`C::m` and `C.m`). A `static m()` beside `export type m` folds the same
  way, as a value and a type of one name do elsewhere.
- In `@aburi/core`, file and import scope resolve `C.m()` to `C::m` when it exists: a class-name
  receiver reads the static side. A call to a real static method, which resolved to nothing,
  now gets an edge, and a call to a namespace export gets one again. Component and workspace
  scope still compare the target with `Symbol.name` verbatim. LSP enrichment now finds a
  static member's document symbol, which it looked up by the text after the last `.`.
- In `@aburi/diff`, rename matching reads the member after the last separator of either kind,
  so `C::Inner.g` is matched on `g` rather than `Inner.g`.
