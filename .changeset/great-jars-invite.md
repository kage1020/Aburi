---
"@aburi/lang-typescript": minor
---

Read a decorator wherever the grammar parents it, and let a JSDoc block reach past one

**This changes what a Symbol carries, and the first scan after upgrading will report
`modified` Symbols that no source change explains.** Both halves widen the extraction:
decorators feed `mergeFrameworkClassification`, so a class that had no `extKind` can now have
one, and `signature.throws` feeds the api and logic fingerprint axes. That drift is the point
of the fix rather than a side effect — the Symbols were wrong before — but it lands as diff
noise exactly once.

A decorator always belongs to the declaration it precedes. Tree-sitter parents it in one of two
places depending on whether anything else owns that declaration, and only one was being read:

| source | where the decorator sits | read before |
|---|---|---|
| `class C { @A() m() {} }` | preceding sibling in the class body | yes |
| `@A() export class C {}` | preceding sibling in the `export_statement` | yes |
| `@A() class C {}` | child of `class_declaration` | no |
| `export @A() class C {}` | child of `class_declaration` | no |
| `export default @A() class C {}` | child of `class_declaration` | no |
| `@A() abstract class C {}` | child of `abstract_class_declaration` | no |
| `@A() export @B() class C {}` | one of each | only `A` |

The symptom was an IR that contradicted itself: `export @Controller("x") class A {}` produced a
class with no boundary owning routes that had one. Every form in the table is legal TypeScript,
and the decorator-after-`export` spelling is what TypeScript 5.0 added.

`readDecorators` now returns the union of the preceding-sibling run and the declaration's own
`decorator:` field children. The two sources are disjoint by construction, so the union needs no
deduplication, and the existing line sort puts a declaration decorated on both sides back into
source order. A **parameter** decorator (`m(@P() x)`) stays out of both: it is a child of the
parameter, and the method does not field-tag it.

The mirror, in the same file: `readLeadingJsDoc` stopped at a decorator, so
`/** @throws E */ @Get() handler() {}` discarded the block and every `@throws` tag in it. A
decorator is now stepped over the way a comment is stepped over on the decorator side — it
belongs to the member rather than separating anything from it. An anonymous token still ends
the run, which is what keeps a stray `;` from handing a member someone else's documentation.
