---
"@aburi/types": minor
"@aburi/plugin-registry": minor
"@aburi/lang-typescript": minor
"@aburi/core": minor
"@aburi/framework-nestjs": minor
---

Carry the receiver a decorator was written through, and read it against the file's imports

`@nest.Controller()` and `@tsed.Controller()` were indistinguishable by the time a framework
plugin saw them. `readDecorator` reduced a qualified decorator to its leaf identifier, so
`Decorator` said `Controller` and nothing said which module it came from — and
`readImportedNames` skipped `symbols: "*"` edges outright, so even a recorded
`namespaceBinding` was never indexed. Both halves had to be wrong for the bug to hold, and
both were.

The consequence was the provenance table in `lang-plugin.md` §5.2.2 being out of order in its
last row. A decorator written through a module object landed in "no edge binds it" and came
back `high`, while the *named* import of the same decorator from the same library came back
`medium`. The file that disclosed more was trusted less.

`Decorator` now carries `qualifier`: the receiver verbatim, `nest` for `@nest.Controller()`
and `a.b` for `@a.b.C()`. It is Class B per `ir-schema.md` §1.1 — a bare decorator omits the
key entirely — so a document written before this change reads exactly as it did, and `raw`
still quotes the whole written form. `@aburi/framework-nestjs` resolves a qualified decorator
through the receiver's first segment, which is the only part that can name something in
scope, and looks that segment up in **both** binding indexes: `import * as nest` binds the
module object under `namespaceBinding`, `import nest from` binds it as a named symbol, and a
decorator written through either has disclosed the same thing.

A qualified decorator deliberately does **not** resolve its *leaf* through the named-import
index. The leaf is a property of a module object, not an identifier in the file's scope, so a
file that imports `Controller` by name from NestJS while writing `@tsed.Controller()` no
longer reports the second as though it were the first.

**What changes for a caller**

- A NestJS Symbol classified from a module object of a competing library now reports
  `confidence: "medium"` where it reported `high`, whether the module was bound by
  `import * as` or by a default import.
- `SymbolClassification.decoratorBoundaries` is keyed on the decorator as the source **wrote**
  it, receiver included: `nest.Controller`, not `Controller`. The contract always said
  "written name"; before `qualifier` existed the leaf *was* that name. The leaf alone is not a
  usable key, because two decorators on one Symbol can share it while resolving to different
  vocabulary, and a shared key flags both — putting `boundary: true` on a decorator that was
  never classified, which `drop-b` then reads.
- `@aburi/framework-nestjs` renames the exported `ImportedNames` to `ImportedBindings`, now an
  interface of two maps rather than one map, and `resolveDecoratorName` takes the decorator
  (`Pick<Decorator, "name" | "qualifier">`) instead of a bare name. Both are in the published
  types.
- `@aburi/plugin-registry` adds `assertNamespaceBinding`, the namespace-edge counterpart to
  `assertImportBinding`: a `namespaceBinding` that is present but empty is an upstream fault
  rather than an edge to skip.

Most `api` fingerprints do not move: `canonicalizeDecorators` names the fields it takes and
`qualifier` is not among them, while `raw` already carried the receiver. The exception is a
decorator whose classification changes, since `ApiInput` includes `extKind` and
`decorators[].boundary` — a decorator that used to resolve its leaf through a named import and
now resolves its receiver can stop matching the vocabulary, and its Symbol's api hash moves
with it. That movement is the fix working.
