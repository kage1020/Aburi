---
"@aburi/types": minor
"@aburi/lang-typescript": minor
"@aburi/core": minor
"@aburi/framework-nestjs": minor
---

Carry the receiver a decorator was written through, and read it against namespace imports

`@nest.Controller()` and `@tsed.Controller()` were indistinguishable by the time a framework
plugin saw them. `readDecorator` reduced a qualified decorator to its leaf identifier, so
`Decorator` said `Controller` and nothing said which module it came from — and
`readImportedNames` skipped `symbols: "*"` edges outright, so even a recorded
`namespaceBinding` was never indexed. Both halves had to be wrong for the bug to hold, and
both were.

The consequence was the provenance table in `lang-plugin.md` §5.2.2 being out of order in its
last row. A namespace import from a competing library landed in "not named on any edge" and
came back `high`, while the *named* import of the same decorator from the same library came
back `medium`. The file that disclosed more was trusted less.

`Decorator` now carries `qualifier`: the receiver verbatim, `nest` for `@nest.Controller()`
and `a.b` for `@a.b.C()`. It is Class B per `ir-schema.md` §1.1 — a bare decorator omits the
key entirely — so a document written before this change reads exactly as it did, and `raw`
still quotes the whole written form. `@aburi/framework-nestjs` indexes namespace edges by
their binding and resolves a qualified decorator through the receiver's first segment, which
is the only part that can name something in scope, landing it in the same three tiers as a
bare name.

A qualified decorator deliberately does **not** fall back to the named-import index. The leaf
is a property of a module object, not an identifier in the file's scope, so a file that
imports `Controller` by name from NestJS while writing `@tsed.Controller()` no longer reports
the second as though it were the first.

What changes for a caller: a NestJS Symbol classified from a namespace import of a competing
library now reports `confidence: "medium"` where it reported `high`. Nothing changes for the
`api` fingerprint — `canonicalizeDecorators` names the fields it takes, and `raw` already
carried the receiver, so no previously computed hash moves.
