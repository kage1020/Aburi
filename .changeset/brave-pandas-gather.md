---
"@aburi/lang-typescript": minor
"@aburi/types": minor
"@aburi/core": patch
---

One Symbol per declared entity, however many declarations wrote it

A getter beside its setter, an overload beside its implementation, and a reopened namespace or
interface each made `extractSymbols` emit two SymbolCandidates under one id. Integrity invariant
#1 refuses that, and it is checked once over the finished document rather than per file — so
`class Box { get value() {} set value(n) {} }` did not cost its own file, it ended the run and
took every other file's Symbols with it.

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

`SymbolCandidate` gains `mergedBodyNodes?: TNode[]`: the bodies of the further declarations, in
source order. Without it, folding a pair would drop the setter's body — a `set password(v)` that
hashes the value has effects, and losing them silently is worse than the duplicate it replaces.
`walkBody`, `normalizeAst` and both empty-body drop rules read every body now. The field is absent
on a Symbol with one declaration, so the single-declaration path is untouched and no existing
fingerprint moves.

Separately, an unexported `namespace` at statement position is parented under an
`expression_statement`, which the statement switch never looked through — so every unexported
namespace lost its own Symbol *and* everything declared inside it. Reading through the wrapper is
what lets a reopened namespace's members be merged at all.
