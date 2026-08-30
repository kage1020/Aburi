---
"@aburi/lang-typescript": minor
---

A class body is what defining and constructing the class runs

A class Symbol's `bodyNode` is the whole `class_body`, and `walkBody` descended into every
member — so each method's calls and rules were recorded a second time on the class. That is
not only duplication in the IR: `new C()` resolves to the class Symbol (`call-resolution.md`
CR15), so effect propagation carried the duplicates up into callers that touch nothing. A
factory whose whole body is `return new UserService(prisma)` was reported as writing to the
database.

A class Symbol's body is now what **defining and constructing** the class runs: field
initialisers, static blocks, and the constructor. A method body belongs to the method's own
Symbol.

The constructor stays for the same reason the rest goes. `new C()` runs it, and the Symbol
the instantiation resolves to is the class — drop it and a `constructor() { prisma.user.create(...) }`
becomes invisible to every caller that instantiates the class. It is recorded on
`#C.constructor` too, and propagates nowhere twice, because nothing resolves a call to a
constructor.

Only the *body* is skipped, and only for a member that has a Symbol of its own. Both halves
are load-bearing:

- A parameter default (`m(x = f())`) sits outside the member's own `bodyNode`, which is its
  `statement_block`. Skipping the whole member would lose it.
- A computed member (`[Symbol.iterator]() {}`) and a member of an anonymous default class are
  not Symbols at all, so their bodies have nowhere else to be recorded and stay on the class.

Which member has a Symbol is now one predicate, `memberHasOwnSymbol`, that extraction and the
walk both read — and both ask about the same node. The walk reads the class off the body it is
walking rather than off the Symbol, because a folded Symbol's `fullNode` is its **leading**
declaration: `const C = 1` written above `class C { m() {} }` heads the Symbol with a
`lexical_declaration`, and asking that node whether the class has member Symbols answered no.

`static constructor()` is not the construction path. `new C()` never runs a static member, and
the check now says so — it used to put the static member's body on the class and give it the
instance qualified name, where it collided with the real constructor's. `tsc` refuses the
source; this plugin also parses `.js`, where it is legal.

The skip reaches the Symbol's own body nodes and no others: a class written inside a function
or a method is not extracted, so every call in it still belongs to the Symbol whose body
encloses it.

Class Symbols' `calls`, `rules`, `effects` and `fingerprint.logic` move as a result, and so do
the callers those effects reached. `fingerprint.api` and `fingerprint.syntax` do not: the
normalized AST still covers the whole class body.

**Scope.** A member written as a field holding an arrow — `create = async (d) => { ... }` — is
not a `method_definition`, so it has no Symbol of its own and its body stays on the class, where
it propagates to callers that construct the class. Constructing the class creates the closure and
does not run it, so the heading above does not describe that shape; nothing here changes it, and
it is a common way to write a service.
