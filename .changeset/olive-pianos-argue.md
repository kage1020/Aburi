---
"@aburi/framework-nestjs": minor
"@aburi/plugin-registry": minor
"@aburi/types": minor
"@aburi/core": minor
---

Match a decorator on the name it was imported under, and read where it came from

`framework-nestjs` compared `Decorator.name` against four literal tables. The name a decorator
is written with is not evidence on its own, and matching it alone got the answer wrong in both
directions:

```ts
import { Controller as Ctrl, Get as Fetch } from "@nestjs/common"
@Ctrl("/b")
export class BController {          // was extKind: null — the boundary disappeared
  @Fetch("/list") list() {}         // was extKind: null
}
```

```ts
import { Controller } from "routing-controllers"
@Controller("/x")
export class XController {}         // was framework:nestjs:controller, confidence: "high"
```

The first is the reported bug: a renamed import takes the boundary off the class *and* off
every route it owns, and nothing in the IR records that anything was missed. The second is the
same missing evidence pointing the other way — a competing library's decorator claimed as
NestJS, at full confidence.

`ImportEdge` already carried what was needed. `symbols` records the recoverable form
(`"Controller as Ctrl"`) and `source` records the module. The framework plugins could not see
either: their context was `ExtractionContext`, which has no imports.

## Framework plugins now receive the file's import edges

`FrameworkPlugin.classifySymbol` takes a `FrameworkClassifyContext` — `ExtractionContext` plus
the file's `ImportEdge[]`, the same list `parseFile` produced. This mirrors what effect plugins
already get through `ClassifyContext.file.imports`.

A plugin that has no use for the edges needs no change: declaring the parameter as the supertype
`ExtractionContext` still satisfies the interface. `framework-express`, `framework-next` and
`framework-react` do no name matching against a package's vocabulary and are untouched.

## Three tiers of evidence

| What the file's edges say about the written name | Matched against | Confidence |
|---|---|---|
| imported from `@nestjs/*` | the imported name | `high` |
| imported from anything else | the imported name | `medium` |
| named on no edge | the written name | `high` |

The middle row downgrades rather than refuses, and that is the one judgement call here. A NestJS
monorepo conventionally re-exports `@nestjs/common` through a tsconfig path alias (`@app/common`),
which is indistinguishable from a foreign npm package without reading `tsconfig.json`. Refusing
would take the boundary off every controller in such a project — the same loss this change exists
to prevent, at a larger scale. `medium` is what `ir-schema.md` §5.4 calls an identifier match,
which is exactly what is left when provenance is unknown.

**So a `@Controller` from a competing library still classifies as NestJS**, now at `medium`
rather than `high`. Closing that properly needs tsconfig path resolution, which is filed
separately.

The last row is the status quo, and is what a decorator reached through a namespace import
(`import * as nest from "@nestjs/common"` → `@nest.Controller()`) falls into: the language plugin
hands over the leaf identifier and `Decorator` carries no qualifier to tie it back to the
namespace binding. That makes it the one row not ordered by how much the file disclosed — a
namespace import from a *competing* library also lands here, and is therefore trusted further
than the named import of the same decorator would be.

Two further shapes stay at `high` that the table above does not obviously cover, both because a
re-export names a symbol without binding it in local scope:

```ts
import { Controller } from "routing-controllers"   // the binding the file actually uses
export { Controller } from "@nestjs/common"        // binds nothing; re-publishes the name
@Controller() export class C {}                    // → nestjs:controller, high
```

The duplicate rule prefers the NestJS edge, so a non-binding edge displaces a real one and skips
the middle tier. And an aliased re-export (`export { X as Y } from './z'`) reaches the plugin as
`"X"` alone — the language plugin composes `" as "` on imports but not on re-exports — so the name
the file publishes is not the name that gets indexed. Both are pinned by tests rather than left to
be rediscovered.

Duplicate bindings resolve NestJS-over-foreign in either order; every other duplicate (two foreign
edges, or two NestJS edges disagreeing on the exported name) is settled by write order, which is
arbitrary rather than reasoned.

Provenance is tested against the `@nestjs/` scope rather than a package list — `@nestjs/common`,
`@nestjs/microservices` and `@nestjs/websockets` all supply vocabulary today and the set grows.

## What changes in the IR

A file that renames a NestJS decorator on import gains an `extKind` on the class and on each of
its routes, and `boundary: true` on the decorators, where it previously had none. A file that
takes matching vocabulary from a module outside the scope keeps its `extKind` and drops to
`Symbol.confidence: "medium"`.

One direction **loses** a classification. Because the match moved to the imported name, a
decorator whose local name only happens to spell vocabulary no longer counts as it:

```ts
import { Thing as Controller } from "./thing"
@Controller()
export class C {}                   // was framework:nestjs:controller; now null
```

That is the change working — the file states outright that `Controller` here is `Thing` — but it
is the one case where a Symbol drops its `extKind` and its decorator boundary flags with no source
change, so it lands as diff noise the same way the gains do.

The downgrade is a record rather than a signal: nothing downstream reads a Symbol's `confidence`
today. The diff compares it only on effects, and the Markdown projection's badge renders only on
effect rows, so a `medium` Symbol is visible in the IR document and nowhere else. That is why the
tier costs no diff churn, and equally why it cannot yet be acted on. The projection side is a
pre-existing gap against `ir-schema.md` §5.4 and is tracked separately.

`derivedBy` now carries the imported name (`framework:nestjs:route:Get` for a `@Fetch()` that was
`import { Get as Fetch }`), because it is a closed vocabulary that filters and diffs read and a
rename changes nothing about the route. `Decorator.name` and `.raw` keep the spelling the source
used, and `decoratorBoundaries` stays keyed on it — that is what the core matches against when it
folds the classification back onto the Symbol.

## Supporting moves

`splitAliasedImportName` is exported from `@aburi/core`. It parses the `ImportEdge.symbols` wire
format, which now has two readers — the call-graph resolver and the framework plugins — so it is
no longer private to the resolver.

Its unaliased branch now trims, which it did not while it was private to the resolver, so
`"  Controller  "` resolves where it previously matched nothing.

`assertImportEdgeSource` is exported from `@aburi/plugin-registry/plugin-input`, factored out of
`hasMatchingImport` so a plugin that walks the edge list itself rejects an empty module specifier
the same way and with the same message. `assertImportBinding` joins it for the other field of the
same edge: a `symbols` entry with an empty half (`" as Y"`, `"X as "`) names nothing, and a
consumer that looked it up in a vocabulary table would miss every entry and drop the
classification silently — with a decorator, taking the owning class's `extKind` with it.

`Decorator.name` is now NFC-normalized alongside the other strings this boundary collapses
(`scan/pipeline.ts`). `ImportEdge.symbols` was already normalized, so leaving the decorator alone
left the two halves of the new comparison in different spellings, and an alias silently failed to
resolve on a file that spells its identifiers decomposed. `Decorator.raw` is untouched — it is a
quotation of source.

`FrameworkClassifyContext.imports` is `readonly`. The pipeline hands over the live array, not a
copy: it is the same instance reported as the file's imports and read by call resolution, so a
plugin that sorted or spliced it would rewrite the IR from inside a classifier. `framework-nestjs`
memoizes its name index on that array's identity, which makes the index per file rather than per
decorated Symbol — the difference between linear and (declarations × import entries) on a large
controller.
