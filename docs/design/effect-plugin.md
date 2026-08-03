# Effect Plugin Interface

Definition of the plugin interface for classifying call_expressions as side effects (effects).
One effect plugin is responsible for one library/framework domain (e.g. Prisma / NestJS / Stripe / Redis).

References:
- [`ir-schema.md`](./ir-schema.md) §9 — Effect structure
- [`extension-vocab.md`](./extension-vocab.md) — Effect ids (`x-<plugin>:<action>`) and the manifest
- [`lang-plugin.md`](./lang-plugin.md) §5.1 — cooperation points with language plugins
- [`drop-list.md`](./drop-list.md) §5.2 — when an effect plugin adds loggers etc. to the drop targets

---

## 1. Purpose

From the textual form of a call_expression (`prisma.invoice.create`) and its surrounding context, determine what effect the call represents (`db.write` / `x-stripe:charge`, etc.).

The language plugin only provides "what was called" at the string level. The effect plugin determines "what it means" in a language-independent way.

## 2. Plugin Responsibilities

### 2.1 In scope

- Declare effect ids (individual / prefix) in the manifest
- Receive a `CallCandidate` and determine whether it is an effect this plugin recognizes
- If recognized, return an `EffectClassification` (effectId / confidence / derivedBy)
- If not recognized, return `null`
- Optionally, add calls this plugin recognizes to drop-list category C (logger-oriented effect plugins only)

### 2.2 Out of scope

- Parsing sources (the language plugin's job)
- Walking the AST
- Creating or modifying Symbols themselves
- Overriding results classified by other plugins
- Writing directly to `Symbol.derivedBy[]` (only returns a per-effect `derivedBy`)
- Applying config.suppress / keep (the core)

The responsibility is confined to a pure function "callee → effect classification". As a result:
- Effect plugins reduce to almost purely declarative pattern matching
- Unit testing is easy (feed a callee string and assert the expected effectId)
- They are reusable across languages (the same Prisma plugin is expected to work for TS and Python alike)

## 3. Lifecycle

```
1. The registry validates the manifest and loads the plugin
2. plugin.init() is called with ctx (registry/config)
3. Each time a language plugin extracts CallCandidate[] in walkBody:
     for each call, the enabled effect plugins are invoked in config order
       plugin.classify(call, ctx) → EffectClassification | null
     the result of the first plugin to return non-null is adopted (§5)
4. After all files, plugin.cleanup?() is called
```

## 4. Interface

The actual types are defined in the `types` package of `@aburi/core`. This document shows the signatures of the contract surface.

### 4.1 `EffectPlugin`

```ts
interface EffectPlugin {
  manifest: PluginManifest                   // type: "effects"
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  // effect classification (ideally implemented as a pure function)
  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null

  // optional: additions to drop-list category C (implemented by logger-oriented plugins only)
  dropCallees?: string[]                     // identifier path prefixes (e.g. "pino", "winston")
}
```

### 4.2 `CallCandidate` (from the language plugin)

Normatively defined in [`lang-plugin.md`](./lang-plugin.md) §4.4. This document only references the same type.
Summary: the 6 fields `{ target, line, argumentCount, inAwait, inNew, literalArgs }`. `literalArgs` covers cases such as wanting to inspect the contents of an SQL string (non-literals are `null`).

`target` is contract-guaranteed non-empty with no empty segments (lang-plugin.md §4.4, "Normalized-callee contract"). Effect plugins enforce that contract instead of coding around it: `assertNonEmptySegments` from `@aburi/plugin-registry/plugin-input` splits the target and throws on a violation, and `hasMatchingImport` does the same for `ImportEdge.source`. Both live in the registry rather than in each plugin so the next effect plugin inherits identical messages and identical fail-fast ordering. The guards ship as a dedicated subpath so importing them does not pull the registry's manifest validator (and its schema compilation) into a classifier's startup path.

A violation raised by these guards is **not** a classification outcome, so it is exempt from the EP3 degradation in §10: a classifier that throws while deciding is a plugin bug the run can absorb by treating the call as unclassified, whereas an unnormalized callee means every downstream classification of that file was computed from a value the pipeline promised could not exist. Degrading it to `null` would turn an upstream parser bug into a quietly under-populated IR — the one outcome the guards exist to prevent. See EP3a.

### 4.3 `ClassifyContext`

```ts
interface ClassifyContext {
  owner: OwnerSummary                        // summary of the Symbol containing the call
  file: FileSummary                          // file information (including imports)
  language: string                           // "ts" / "py" / "rs" etc.
  registry: VocabRegistry
  config: AburiConfig
}

interface OwnerSummary {
  id: string                                 // id of the owning Symbol
  kind: SymbolKind
  name: string
  extKind: string | null                     // value already determined by the framework plugin
  decorators: { name: string; boundary: boolean }[]
  component: string | null
}

interface FileSummary {
  path: string
  imports: ImportEdge[]                      // all imports extracted by the language plugin
}
```

Providing `imports` lets the effect plugin distinguish whether "the identifier `prisma` comes from `@prisma/client` or is a local homegrown variable".

### 4.4 `EffectClassification`

```ts
interface EffectClassification {
  effectId: string                           // a core id from ir-schema §9.1 or x-<plugin>:<action>
  confidence: 'high' | 'medium' | 'low'      // ir-schema §5.4
  derivedBy: string                          // e.g. "effects-plugin:prisma:create"
}
```

The returned `effectId` must fall under **the manifest's `provides.effects[].id` or `provides.effectPrefixes[]`**. The registry detects violations at extraction time and raises an error.

## 5. Classification Algorithm

### 5.1 first-match-wins

```
for each call in symbol.calls:
  for each effect_plugin in config-order:
    result = effect_plugin.classify(call, ctx)
    if result !== null:
      assign call to effects[] with result
      break    # subsequent plugins are not invoked
  else:
    leave call in calls[]
```

Plugins earlier in config order take priority. Placing a project-specific plugin above the standard plugins lets it take precedence.

### 5.1.1 Timeout for classify()

The core sets a **per-call timeout** on each plugin's `classify(call, ctx)` invocation. Default 50ms.

- Override: `config.classifyTimeoutMs` (default `50`, min `10`, max `5000`)
  - For plugins containing an SQL parser, raising it to 200-500ms is realistic
  - No per-plugin override (a single config value shared by all plugins)
- Timeout exceeded → treated as if `null` were returned; the call flows to the next plugin
- **Non-determinism recording**: each timeout occurrence (plugin, target, file:line) is recorded in `stats.effectClassifyTimeouts[]`
  - This makes non-determinism detectable from the IR: "the same input classifies successfully in run 1 but times out in run 2 and stays in calls[]"
  - CI can compare `effectClassifyTimeouts` across runs to spot plugin performance regressions
- warning log: `Plugin <name> classify() timed out for <target> at <file>:<line>`
- Plugin implementations should be synchronous (not return a Promise). If asynchrony is needed, the plugin itself should implement the timeout

This prevents a slow plugin from stalling the whole double loop of thousands of AST symbols × dozens of calls × number of plugins.

A timeout degrades to `null` while an input-contract violation (§4.2) fails the run, and the split is deliberate: a slow classifier still received a well-formed callee, so the worst case is one call left unclassified in a run that is otherwise sound — and `stats.effectClassifyTimeouts[]` records exactly which. A violated input contract has no such record and no such bound: the value was never one the pipeline could produce, so nothing downstream of it is trustworthy. Degrade what you can account for; fail on what you cannot.

### 5.2 Why multiple classification is disallowed

There is a temptation to record `prisma.invoice.create` as both `db.write` (core) and `x-prisma:invoice.create` (Prisma detail), but currently:

- The IR's `Symbol.effects[]` grows complex (differing ids side by side for the same target/line)
- The diff report's ordering conventions break down (which one is canonical?)
- The comprehension load on consumers rises

A single effectId is adopted via first-match-wins. Multiple classification remains an option for a future release via a separate field (`Effect.aliases?: string[]`) — see the [roadmap](../roadmap.md).

### 5.3 Expressing "do not classify" in a higher-priority plugin

Priority control such as "the Prisma plugin should return `x-prisma:create` instead of `db.write`, so place it above the generic plugin that returns core db.*" is done via config order.

Conversely, when a higher-priority plugin wants to defer specific calls to lower ones, it simply returns `null` and the call flows down.

## 6. Cooperation with Language Plugins

### 6.1 Information reaching the effect plugin

Once the language plugin's `walkBody` returns a `CallCandidate`, the core routes it to each effect plugin. Effect plugins never access the AST.

### 6.2 Invocation relative to owner Symbol determination

Some effect plugins make decisions that depend on the owner's `extKind` (already determined by the framework plugin) — e.g. NestJS lifecycle is only meaningful inside `framework:nestjs:provider`.

Therefore the extraction order is (see [`lang-plugin.md`](./lang-plugin.md) §5.3):

```
extractSymbols → framework.classifySymbol → walkBody → effects.classify
```

By the time an effect plugin is invoked, owner.extKind has been determined.

### 6.3 The same call never has multiple owners

A call_expression belongs to a single owning Symbol (nested anonymous functions are absorbed into the parent, [`ir-schema.md`](./ir-schema.md) §3.3). Effect plugins never face ambiguity in identifying the owner.

## 7. Drop Additions by Logger-Oriented Plugins

Providing `dropCallees: string[]` in the manifest adds the given callee prefixes to the core's drop-list category C ([`drop-list.md`](./drop-list.md) §5.2).

Example: if the `effects-pino` plugin declares `["pino", "child"]`, then `pino.info(...)` / `child.info(...)` are excluded from effects/calls.

Writing a drop-only plugin is also possible (`provides.effects: []` but declaring `dropCallees` only).

## 8. Official Effect Plugins (planned)

| plugin | example recognized callees | main effect ids |
|---|---|---|
| `@aburi/effects-nest` | NestJS lifecycle hooks | `x-nest:lifecycle.on-module-init` etc. |
| `@aburi/effects-prisma` | `prisma.*.{find*,create,update,upsert,delete}` | `db.read` / `db.write` |
| `@aburi/effects-drizzle` | `db.select().from(...)` / `db.insert(...)` | `db.read` / `db.write` |
| `@aburi/effects-trpc` | `trpc.*.{query,mutation}` | `network.rpc` |
| `@aburi/effects-axios` | `axios.{get,post,put,patch,delete}` | `network.http` |
| `@aburi/effects-fetch` | `fetch(...)` (global) | `network.http` |
| `@aburi/effects-bullmq` | `queue.add(...)` / worker | `queue.publish` / `queue.consume` |
| `@aburi/effects-redis` | `client.{get,set,del}` | `x-redis:read` / `x-redis:write` (core `state.*` is in-process only, so Redis is expressed via plugin extension) |
| `@aburi/effects-pino` | `pino.*` / `child.*` | dropCallees only (logger exclusion) |
| `@aburi/effects-winston` | `winston.*` | same as above |
| `@aburi/effects-otel` | `tracer.*` / `metrics.*` / `span.*` | same as above |

Implementation details of each plugin live in their respective READMEs. Today NestJS + Prisma are implemented as the minimum; the rest are planned — see the [roadmap](../roadmap.md).

## 9. Pattern-Matching Implementation Examples

### 9.1 Prisma effect plugin (pseudocode)

```ts
import { assertNonEmptySegments } from '@aburi/plugin-registry/plugin-input'

const READ_METHODS = /^(findUnique|findFirst|findMany|count|aggregate|groupBy)$/
const WRITE_METHODS = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/
const TX_METHODS = /^\$transaction$/

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-prisma.json */ },

  async init(ctx) {
    // We want to look at imports to judge whether the Prisma client is imported from `@prisma/client`
  },

  classify(call, ctx) {
    // decompose the identifier chain: "prisma.invoice.create" → ["prisma", "invoice", "create"]
    // The shared guard rejects an unnormalized callee instead of splitting it silently.
    const { segments: parts, last: method } = assertNonEmptySegments(call.target, {
      plugin: 'effects-prisma',
      filePath: ctx.file.path,
    })
    if (parts.length < 3) return null

    // `method` comes from the guard already typed as `string`. The receiver segments still
    // need an index, so read them defensively — `slice(-3)` alone would hand back
    // `string | undefined` under noUncheckedIndexedAccess.
    const root = parts[parts.length - 3]

    // check whether root looks like prisma
    if (!isPrismaIdentifier(root, ctx.file.imports)) return null

    if (READ_METHODS.test(method)) {
      return { effectId: 'db.read', confidence: 'high', derivedBy: 'effects-plugin:prisma:read' }
    }
    if (WRITE_METHODS.test(method)) {
      return { effectId: 'db.write', confidence: 'high', derivedBy: 'effects-plugin:prisma:write' }
    }
    if (TX_METHODS.test('$' + method)) {
      return { effectId: 'db.transaction', confidence: 'high', derivedBy: 'effects-plugin:prisma:tx' }
    }
    return null
  }
}

function isPrismaIdentifier(name, imports) {
  // imports contains '@prisma/client' and name looks like an instance of PrismaClient from there
  // currently a heuristic on the level of "if '@prisma/client' is imported, trust prisma-looking identifiers"
  return imports.some(i => i.source === '@prisma/client')
}
```

### 9.2 NestJS lifecycle effect plugin (pseudocode)

```ts
const LIFECYCLE_METHODS = {
  onModuleInit: 'x-nest:lifecycle.on-module-init',
  onApplicationBootstrap: 'x-nest:lifecycle.on-application-bootstrap',
  onModuleDestroy: 'x-nest:lifecycle.on-module-destroy',
  onApplicationShutdown: 'x-nest:lifecycle.on-application-shutdown',
}

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-nest.json */ },
  classify(call, ctx) {
    // If we design effect propagation for "calls to other symbols inside a lifecycle hook body", that is a separate consideration
    // currently "the invocation of the lifecycle hook itself" is not treated as an effect (the framework plugin handles that via extKind)
    return null
  },
  dropCallees: []  // NestJS passes loggers via DI rather than a separate module, so nothing is dropped here
}
```

(NestJS lifecycle does not appear as calls; it is determined by method name and framework boundary, so it is the framework plugin's responsibility, not the effect plugin's.)

### 9.3 Stripe effect plugin (pseudocode)

```ts
import { assertNonEmptySegments, hasMatchingImport } from '@aburi/plugin-registry/plugin-input'

const ACTIONS = {
  charges: 'x-stripe:charge',
  customers: 'x-stripe:customer.create',  // when method is create
  webhooks: 'x-stripe:webhook.deliver',
}

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-stripe.json */ },
  classify(call, ctx) {
    const origin = { plugin: 'effects-stripe', filePath: ctx.file.path }
    const { segments: parts, last: method } = assertNonEmptySegments(call.target, origin)
    if (parts.length < 3) return null
    const resource = parts[parts.length - 2]

    if (!hasMatchingImport(ctx.file.imports, origin, source => source === 'stripe')) return null

    if (resource === 'charges' && method === 'create') {
      return { effectId: 'x-stripe:charge', confidence: 'high', derivedBy: 'effects-plugin:stripe:charge' }
    }
    // ... and so on
    return null
  }
}
```

## 10. Verifiable Properties (Test Criteria)

| ID | Input | Expected |
|---|---|---|
| EP1 | returning an effectId not in the manifest | extraction-time error (detected by the registry) |
| EP2 | classify returns the same output for the same input | purity (no side effects, no held state) |
| EP3 | classify throws from its own classification logic | warning log, treated as null |
| EP3a | classify throws an input-contract violation (§4.2) | propagates; the scan fails rather than degrading to an unclassified call |
| EP4 | 2 plugins classify the same call | the first in config order wins (first-match-wins) |
| EP5 | classify returns null | the call stays in `Symbol.calls[]` |
| EP6 | classify returns an EffectClassification | the call moves to `Symbol.effects[]` and does not stay in `Symbol.calls[]` |
| EP7 | plugin declaring `dropCallees` | matching callees are excluded from effects/calls, same as drop-list §5.2 |
| EP8 | logger-only plugin with `effects: []` and `dropCallees: ["pino"]` | classify keeps returning null, but pino.* is dropped |
| EP9 | returning any id under `effectPrefixes: ["x-stripe"]` | OK (no individual declaration needed) |
| EP10 | classify returns `confidence: 'low'` | Symbol.effects[].confidence = "low" goes into the IR as-is |

## 11. Design Decisions

### 11.1 Why effect plugins center on pure functions

The `classify(call, ctx) → result` shape:

- Makes unit testing easy (no stateful test harness needed)
- Is parallelizable (future performance improvements)
- Never touches the AST directly, so it is unaffected by internal implementation changes in language plugins

To preserve the responsibility split of the whole extraction pipeline, effects stick strictly to "classification".

### 11.2 Choosing first-match-wins

Config order is a deterministic priority control: behavior is controlled with a single setting. Neither "complex consensus schemes" nor "weighted voting" needs to be introduced today.

If a user wants Prisma's `db.write` emitted as `x-prisma:create`, they place the Prisma plugin first.

### 11.3 Why effect plugins cannot write Symbol.derivedBy directly

`Symbol.derivedBy[]` is the evidence set for "why this Symbol appears in the IR in this form". An effect determination is evidence for a specific call, not for the Symbol as a whole, so the per-effect `Effect.derivedBy` (a single value) suffices.

For the use case of searching "Symbols that use Prisma" at the Symbol level, looking at `Symbol.effects[]` is enough.

### 11.4 Cross-language reuse

Prisma is used from TS and from Python alike (`prisma-client-py`). Because effect plugins are language-independent by design, a single plugin can recognize Prisma calls in both languages.

`ClassifyContext.language` is provided, so per-language behavior switches are also possible.

### 11.5 Why using owner.extKind is allowed

It enables context-dependent determinations such as "treat `this.eventBus.publish(...)` as `event.publish` only inside `framework:nestjs:provider`". owner.extKind has already been determined by the framework plugin (extraction order per lang-plugin §5.3).

### 11.6 Why literal analysis of SQL strings is included from the start

String-based ORMs like `db.query("SELECT * FROM users WHERE id = ?")` are common in real projects. Including `literalArgs` in CallCandidate makes analysis of string contents possible in a plugin, combined with an SQL parser library. The constraint of never accessing the AST stays intact; only the necessary information is added.
