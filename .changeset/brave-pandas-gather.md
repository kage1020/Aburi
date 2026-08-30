---
"@aburi/lang-typescript": minor
"@aburi/types": minor
"@aburi/core": patch
---

One Symbol per declared entity, however many declarations wrote it

A getter beside its setter, an overload beside its implementation, and a reopened namespace or
interface each made `extractSymbols` emit two SymbolCandidates under one id. Integrity invariant 1
(`ir-schema.md` §14) refuses that, and it is checked once over the finished document rather than
per file — so `class Box { get value() {} set value(n) {} }` did not cost its own file, it ended
the run and took every other file's Symbols with it.

TypeScript models all three the same way: one entity, several declarations. So does extraction
now. The first declaration claims the Symbol and every scalar on it; later declarations of the
same id contribute their `derivedBy` and their body instead of becoming a second Symbol. First
wins because legal source already orders them — TypeScript requires the class or function to
precede the namespace merged into it, and requires a merge's declarations to agree on whether
they are exported.

Two constructs are handled before that rule rather than by it, because it would answer them
wrongly:

- **An overload declaration is skipped.** A `method_signature` in a class body declares nothing
  the implementation beside it does not, and it is written *first* — so folding it as the leading
  declaration would report the member as body-less and give it the overload's parameter types.
  Top-level overloads have always behaved this way (`function_signature` is not in the statement
  switch); a class matches now, so the same source does not answer differently depending on where
  it is written.
- **An accessor pair is led by the getter.** A property's type is what reading it answers, so
  taking the setter's signature would report the member as `(n) => void`.

`SymbolCandidate` gains `mergedDeclarations?: MergedDeclaration<TNode>[]`: the further
declarations, in source order, each carrying both its `bodyNode` and its `fullNode`. Without the
field, folding a pair would drop the setter's body — a `set password(v)` that hashes the value has
effects. Without `fullNode` on the entry, a reopened `enum E {}` would fingerprint as though the
second declaration had never been written, because an enum candidate has no body at all. Only the
bodies reach `walkBody`, which is what keeps a merged namespace from being walked twice. The key is
absent, never empty, on a Symbol with one declaration, so the single-declaration path is untouched
and no existing fingerprint moves.

`derivedBy` and `decorators` join the same way. A lost `boundary` decorator is not cosmetic:
`interface P {}` written above `@Controller() class P {}` is legal, so the declaration that claims
the Symbol is the one carrying none.

Two drop rules were reading one declaration where they should read all of them, and one was reading
decorators nowhere. `classifySymbolDropHint` now honours a boundary decorator for every kind rather
than only for classes — core's `decideSymbolDrop` answers `null` on a boundary and then defers to
this hint, so an unguarded arm here is the one that decides. `classifyClassBody` reads class bodies
only, so a merged `interface C {}` does not contribute members the class does not have.

Two namespace fixes come with it, because folding a reopened namespace requires reaching one.

An unexported `namespace` at statement position is parented under an `expression_statement`, which
the statement switch never looked through — so every unexported namespace lost its own Symbol
*and* everything declared inside it.

And a dotted `namespace A.B {}` is sugar for `namespace A { namespace B {} }`. Reading the dotted
text as one qualified-name segment is what the id builder refuses, and the throw cost the file every
Symbol it had; it declares one Symbol per segment now, with the body under all of them.
