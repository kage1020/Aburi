---
"@aburi/lang-typescript": minor
---

Read a decorator wherever the grammar parents it, order them by source position, and let a JSDoc block reach past one

**This changes what a Symbol carries, and the first scan after upgrading will report
`modified` Symbols that no source change explains.** Decorators feed
`mergeFrameworkClassification`, so a class that had no `extKind` can now have one; `signature`
moves with the JSDoc change; and both feed the api and logic fingerprint axes. The drift is the
point of the fix rather than a side effect — the Symbols were wrong before — but it lands as
diff noise exactly once.

## Where the decorator is written no longer changes whether it is read

A decorator always belongs to the declaration it precedes. Tree-sitter parents it beside that
declaration when nothing separates the two, and inside it when the `export_statement` rule
(`decorator* 'export' ['default'] declaration`) has nowhere to put it — so it is the position
relative to the keyword that decides, not whether a wrapper exists. Only the first was read:

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
class with no boundary owning routes that had one.

Every row is legal TypeScript except the last, which `tsc` rejects as TS8038 — decorators may
not appear on both sides of `export`. The grammar accepts it, so it still reaches the extractor
from a half-edited file, and reading the union rather than one side means such a file loses no
decorator on the way to being reported.

`readDecorators` now returns the union of the preceding-sibling run and the declaration's own
`decorator:` field children. The two cannot overlap — a node has one parent, so a preceding
sibling of the declaration is never also its child — which is why the union needs no
deduplication. A **parameter** decorator (`m(@P() x)`) stays out of both: it is a child of the
parameter, and the method does not field-tag it.

## Decorators are ordered by source position

`framework-nestjs` resolves a class carrying several recognised decorators by taking the first
in source order, so the order is a contract. It was a line sort with an alphabetical tiebreak,
and `Decorator` has no column — so two decorators on one line came out in name order:

```ts
@Injectable() @Catch(HttpException) class F {}   // was framework:nestjs:filter
@Injectable()
@Catch(HttpException)
class F {}                                       // was framework:nestjs:provider
```

A newline decided the classification, and `mergeFrameworkClassification` stamped the result
`confidence: "high"` either way. Ordering on the node's byte offset settles it: total, agrees
with the line ordering integrity invariant #11 checks, and needs no tiebreak.

## A JSDoc block reaches past a decorator, and only JSDoc counts

`readLeadingJsDoc` stopped at a decorator, so `/** @throws E */ @Get() handler() {}` discarded
the block and every `@throws` tag in it. A decorator is now stepped over — it belongs to the
member rather than separating anything from it.

That opens the space *between* decorators, which is where `// biome-ignore`, ticket references
and commented-out decorators are written. So the run now collects only `/**` blocks, which is
what the function always claimed to read: an ordinary `/* … */` and a `//` line are prose, and
the one consumer (`readThrows`, scanning the joined text for `@throws`) cannot tell prose from
a declaration once both are in it. **A `@throws` written in a `//` or `/* */` comment therefore
stops counting**, which it should never have done.

An anonymous token still ends the run, which is what keeps a stray `;` from handing a member
someone else's documentation.

## Also

`@/* why */ Foo()` parses, and the decorator was being named after the comment rather than
after `Foo`.
