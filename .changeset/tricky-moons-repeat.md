---
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

Keep a file that names things legally

Three shapes fed something that is not a name into the Symbol-id builder, which threw — and
the throw cost the file every Symbol it had, not the one declaration:

| source | before | now |
|---|---|---|
| `export const { GET, POST } = handlers` | file skipped | `#GET`, `#POST` |
| `export const [a, b] = pair` | file skipped | `#a`, `#b` |
| `export function ユーザー取得() {}` | file skipped | `#ユーザー取得` |
| `export function café() {}` | file skipped | `#café` |
| `export class A { [Symbol.iterator]() {} m() {} }` | file skipped | `#A`, `#A.m` |

The last row states it sharpest: one member nobody can name cost the class and every sibling.

**The qualified-name grammar is ECMAScript's IdentifierName.** `[A-Za-z_$][A-Za-z0-9_$]*`
becomes `[$_\p{ID_Start}][$\p{ID_Continue}]*`. Only `$` and `_` are named:
`$` is in neither property, `_` is in `ID_Continue` and not `ID_Start`, and ZWNJ and ZWJ —
which ECMAScript names separately — are already inside `ID_Continue` here, measured. `schema/aburi.ir.v1.json#/$defs/SymbolId` already accepted every
one of these, so this closes a gap between the two rather than opening one. What it still
refuses is what is not a name — a pattern's text, a computed member's brackets.

**A destructuring declaration produces one Symbol per binding.** `{ a: b }` binds `b`, not the
key `a`; `{ a = fallback }` binds `a` and reads `fallback`, which is a name from another file
and not a declaration here. Each binding is a `const` carrying `destructured-binding` in
`derivedBy`, which is what explains several Symbols sharing one source range.

**A class member with a computed name produces no Symbol, and no diagnostic.** Mangling the
brackets into a segment would invent a name the source does not contain, and two different
computed keys can collapse onto one segment. A computed name is not a name static analysis can
record — the position `lang-plugin.md` LP26e takes on a computed module specifier.

**One integrity consequence.** `symbols[].name` was excluded from invariant #19 (Unicode NFC)
because the qualified-name grammar was ASCII and NFC leaves ASCII alone. Measured, that no
longer holds — `isQualifiedName("cafe" + U+0301)` is `true` now — so the field moves onto #19's
list, which is what the exclusion said should happen if the grammar widened. `symbols[].id`
stays excluded on a reason that does still hold: `symbolIdViolation` checks NFC in its own
right rather than as a side effect of an ASCII grammar.

No existing Symbol id changes: measured by scanning the `nestjs-billing` fixture before and
after and diffing the id sets — 38 ids, identical.
