---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

A call through `this` or `super` carries `thisBinding`, what `this` is where the call is written: the class in a static block or a static member, an instance in an instance member. The LSP pass looks a `this.m()` hint's member up on that side, so the class Symbol's own calls no longer guess: a static block's or static field's `this.create()` resolves to `static create()` and an instance field's to the instance `create()` when a class declares both, and an instance field's `this.find(q)` beside a `static find()` and a `find` field with no Symbol is left unresolved instead of pointing at the static.
