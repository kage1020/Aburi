---
"@aburi/lang-typescript": minor
---

A function's parameter defaults are walked with its body

`function f(x = g()) {}` and `const a = (y = k()) => l()` reported no call to `g` or `k` anywhere,
because a Symbol's walk covered its body and not its parameter list. A method's defaults were
kept, but on the class rather than the method. Every function-like Symbol — a function, an arrow,
a method, a field holding a function, an inline handler — now walks its parameter defaults ahead
of its body, and the class skips a member's parameter list as it skips the member's body, so
nothing is reported twice. A constructor's defaults stay on the class too, as its body does.
Decorators, a parameter's included, stay on the class, because they run when the class is
defined. `fingerprint.logic` moves on a Symbol whose defaults hold a rule or an effect, and on a
class that carried one of its members'.
