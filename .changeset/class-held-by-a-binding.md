---
"@aburi/lang-typescript": minor
---

A class expression a binding holds is now read as the class it declares. `export const Registry = class { … }` was a `const` with no body, so the class's methods had no Symbol and its methods, field initialisers and static blocks were walked on no Symbol, which left their calls and effects out of the IR. It is now `kind: "class"`, named by the binding, with its members as `class Registry { … }` gives them (`Registry.reset`, `Registry::make`) and `derivedBy` carrying `variable-assigned-class`. It is read through parentheses, `as`, `satisfies` and `!`, and with `let` and `var`. `const Registry = class Inner { … }` is named `Registry`, since `Inner` is in scope only inside the class body. A class handed to a call (`const A = mixin(class { … })`) stays a `const`.

Being a class, it takes a class's drop hints: a class of fields alone is now dropped as a `pure DTO`, and one of `static readonly` literals as `pure constants`, where the `const` was kept. An IR scanned before this release, compared with one scanned after, reports each such binding's Symbol as changed in kind and its members as added. Rescan the base rather than comparing against a stored IR; `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
