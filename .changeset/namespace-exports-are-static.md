---
"@aburi/lang-typescript": minor
---

An export of a namespace merged into a class is named as the class's static member

`class C { m() {} }` beside `namespace C { export function m() {} }` produced one Symbol, `C.m`,
carrying the method's range and both bodies' calls. The export is now `C::m`, the static member
TypeScript resolves it as, and the method keeps `C.m`. Ids of every such export change from `C.x`
to `C::x`, and so do the ids of everything declared under one (`C::Inner.g`).
