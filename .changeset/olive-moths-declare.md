---
"@aburi/lang-typescript": minor
---

Extract the declarations that are written without a body

Two statement shapes never reached the extractor, and both of them declare an entity the source
has no other place to say. A member written `abstract doIt(): void` arrives as an
`abstract_method_signature`, which the class-body switch did not admit — so `abstract class A {
abstract doIt(): void; run() {} }` reported `A` and `A.run`, and the member the class actually
promises its subclasses was missing from the IR. And `declare` is a modifier tree-sitter spells
as a wrapper node around the declaration, which the statement switch did not read through — so
`declare function f(): void`, `export declare class C { m(): void }` and `declare namespace N {
… }` produced no Symbols at all. `.d.ts` files are dropped before extraction on purpose, but
these forms are written in ordinary `.ts` files and were not.

An abstract member is now a `method` with a null `bodyNode` and `abstract-declaration` on
`derivedBy`; a declaration under a `declare` gets the SymbolCandidate it would get written
without the keyword, plus `ambient-declaration`, and the members and nested declarations under
it come with it. Reading the wrapper *through* rather than matching on it is what makes each
form reach the arm it belongs in — and what fixes `export declare class C {}` reporting itself
`internal`, its export having been one node further up than the reader looked.

A signature with no body is a Symbol only under a `declare`. Written outside one it is an
overload declaration and the implementation beside it is the entity, which is how a top-level
`function f(): void` has always behaved and how a class body's `m(): void` still behaves; an
ambient context has no implementations to defer to, so there the signature is the whole
declaration. `declare global { … }` and `declare module "express" { … }` stay silent: each
augments a scope that is not this module, and the only qualified name available for what is
inside would claim that name for this file.
