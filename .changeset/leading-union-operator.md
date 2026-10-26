---
"@aburi/lang-typescript": minor
---

A type in a signature is now recorded as it reads on one line. A formatter that breaks a long type over lines adds line breaks, a trailing comma before a closing bracket and a `|` before a union's first member, and, set to write semicolons only where needed, it drops the `;` between an object type's members. It undoes each of these when it joins the type again. The plugin kept all of them in `signature.inputs[].type`, `outputs` and `typeParameters`. So joining `provider:` / `| ClassProvider` / `| FactoryProvider` onto `provider: ClassProvider | FactoryProvider` moved the `api` fingerprint, and the Symbol showed up under ⚠ API changes with a row whose two sides differed only by that `|`. Joining a union broken inside brackets (`parts: Array<` / `| A` / `| B` / `>`), a function type's broken parameter list (`(` / `request: Request,` / `) => void`) or a broken object type (`{` / `a: A` / `b: B` / `}`) did the same. The canonical string collapses each line break to a space, but it keeps the space left inside `<`, the trailing comma and the missing `;`. A Symbol in the report for another reason also got a `signature.inputs modified` row, and the rename pairing scored the two spellings as different types.

The text is now rebuilt from the syntax tree's tokens:

- Each run of whitespace becomes one space, and none is kept just inside `<` `(` `[` or before `>` `)` `]`.
- A comment and a `,` before a closing bracket are left out.
- An object type's members are separated by `; `, a `,` included, with none after the last.
- The `|` or `&` written before a union's or an intersection's first member is left out, at any depth.
- A string literal type and a template literal type are kept as written, so a `|` or `,` inside one stays.

A comment written between the `:` and the type was recorded as the type: `x: /* c */ A | B` recorded `/* c */`, so editing the comment moved `api` and editing the type did not. It now records `A | B`.

This moves the `api` fingerprint of every Symbol whose signature holds such a type, once, so an IR scanned before this release, compared with one scanned after, reports those Symbols as API changes and trips `--fail-on api-changed` or `changed`. On this repository, scanning one tree with both versions moves the `api` of 20 Symbols, 19 for an object type written over lines and one for a function type's parameter list with a trailing comma, and changes nothing else. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.

Joining a union in a method's parameter, or in a bodiless overload, still changes the `syntax` fingerprint of the class or function that holds it, because the syntax string keeps a union's leading `|`. The method's own fingerprints stay put, and the class shows up as a syntax-only change.
