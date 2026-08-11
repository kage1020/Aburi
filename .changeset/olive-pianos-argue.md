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

A plugin that has no use for the edges needs no change: declaring the parameter as the narrower
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
namespace binding.

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

`derivedBy` now carries the imported name (`framework:nestjs:route:Get` for a `@Fetch()` that was
`import { Get as Fetch }`), because it is a closed vocabulary that filters and diffs read and a
rename changes nothing about the route. `Decorator.name` and `.raw` keep the spelling the source
used, and `decoratorBoundaries` stays keyed on it — that is what the core matches against when it
folds the classification back onto the Symbol.

## Supporting moves

`splitAliasedImportName` is exported from `@aburi/core`. It parses the `ImportEdge.symbols` wire
format, which now has two readers — the call-graph resolver and the framework plugins — so it is
no longer private to the resolver.

`assertImportEdgeSource` is exported from `@aburi/plugin-registry/plugin-input`, factored out of
`hasMatchingImport` so a plugin that walks the edge list itself rejects an empty module specifier
the same way and with the same message.
