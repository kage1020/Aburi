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

What the throw costs is the **file**, not the run: the core's per-file boundary (lang-plugin.md §7.2) withdraws it, names it in `ScanResult.skipped` and `ScanResult.extractionFailures`, logs a warning, and makes `aburi scan` exit non-zero. That is not the degradation this section rules out — a degraded call is silent and a withdrawn file is counted, named, and quoted back with what the guard said.

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

### 5.4 Receiver identification and confidence

A method name is not a library. `delete`, `create`, `update` and `select` are shared vocabulary across `Map`, `Set`, the DOM, RxJS stores and every HTTP router, so a classifier that recognizes a call by its terminal alone will attribute other libraries' calls to its own.

The file-level import gate does not settle this. It answers "does this file use the library", which a file is free to answer yes to while most of its calls belong to something else — an Express router beside its Drizzle queries, a `Map` cache beside a Prisma client. A gate that a mixed file passes wholesale cannot be the last word for the individual calls inside it.

A plugin that matches on shared vocabulary therefore weighs three more things before it commits:

1. **Argument shape.** The library's own signatures rule out collisions for free: no Prisma delegate method and no Drizzle query-builder root takes a bare literal, which is exactly what `router.delete("/users/:id", handler)` opens with. A first argument the library's API could never take is `null`, not a low-confidence effect. `hasLiteralFirstArgument` from `@aburi/plugin-registry/plugin-input` is the shared reader for it.

2. **Receiver name.** The segment holding the client (`prisma` in `this.prisma.user.create`, `db` in `db.select`) is matched word-wise against the plugin's own vocabulary of client binding names — `identifierWords` / `identifierMentions` in the same module, so `prismaClient` and `readReplicaDb` match while `feedback` does not match `db`. Keep the vocabulary to words that actually separate a client from everything else sharing the verbs: `client` matches `apiClient` and `httpClient`, whose `<client>.<resource>.<verb>` shape is a Prisma delegate's exactly, so an entry like that hands the collision the top tier instead of catching it.

3. **Argument count.** Read the arity off the library's own vocabulary table rather than flattening it to a constant — Postgres' `selectDistinctOn(columns, projection)` and `transaction(callback, config)` take two — and treat an overflow as evidence, not proof. `CallCandidate.argumentCount` is a syntactic count, and a classifier reading it as a signature is reading it for more than it promises; a miscount that drops the call erases a real effect and logs nothing, which is the one failure mode with no trace.

The last two set the **tier**, they do not gate the classification:

| signal | outcome |
|---|---|
| receiver names a client binding, arity fits | `confidence: "high"` |
| receiver is a name the plugin cannot place | `confidence: "medium"` |
| `dynamicReceiver` (a collapsed expression) | `confidence: "medium"`, whatever it is spelled |
| more arguments than the method takes | `confidence: "medium"` |

`medium` rather than `null` because the two cases behind an unrecognized name — a client under a house naming convention, and an unrelated object of the same shape — are not separable from the callee string, and effect plugins never see the AST (§11.1) where the binding that would separate them lives. Dropping the first is as wrong as claiming the second at the tier a hand-annotated effect gets, so the uncertainty is recorded instead of resolved by guessing. This is the same tier `@aburi/framework-express` assigns a route that matches the shape without an import anchor.

A plugin whose vocabulary is its own — a `@Controller` decorator resolved back to the framework's package — has nothing to disambiguate and stays at `high` on shape alone. A `$`-prefixed name the library owns outright is close to that, but not the same thing: the receiver still decides whose `$transaction` it is.

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
import {
  assertNonEmptySegments,
  hasLiteralFirstArgument,
  hasMatchingImport,
  identifierMentions,
} from '@aburi/plugin-registry/plugin-input'

const READ_METHODS = /^(findUnique|findFirst|findMany|count|aggregate|groupBy)$/
const WRITE_METHODS = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/
const TX_METHOD = '$transaction'

// Words a Prisma client binding is spelled with. `client` is deliberately absent: it
// matches `apiClient` / `httpClient`, whose `<client>.<resource>.<verb>` shape is a
// delegate call's shape exactly (§5.4).
const PRISMA_CLIENT_WORDS = new Set(['prisma', 'db', 'database', 'orm', 'tx', 'trx'])

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-prisma.json */ },

  async init(ctx) {},

  classify(call, ctx) {
    const origin = { plugin: 'effects-prisma', filePath: ctx.file.path }

    // decompose the identifier chain: "prisma.invoice.create" → ["prisma", "invoice", "create"]
    // The shared guard rejects an unnormalized callee instead of splitting it silently, and
    // runs before the import gate so an upstream bug is not narrowed to Prisma files.
    const { segments: parts, last: method } = assertNonEmptySegments(call.target, origin)

    // Does this file use Prisma at all? Necessary, never sufficient (§5.4).
    if (!hasMatchingImport(ctx.file.imports, origin, (source) => source === '@prisma/client')) {
      return null
    }

    // No Prisma method takes a bare literal, so that shape is not a Prisma call at all.
    if (hasLiteralFirstArgument(call)) return null

    // `<client>.$transaction(...)` is 2 segments, and its callback form takes a second
    // options argument — so it is dispatched before the 3-segment delegate shape and
    // carries its own arity.
    if (method === TX_METHOD) {
      if (parts.length < 2) return null
      return {
        effectId: 'db.transaction',
        confidence: tier(parts[parts.length - 2], call, 2),
        derivedBy: 'effects-plugin:prisma:tx',
      }
    }

    // A delegate call is `<client>.<model>.<verb>`; the client segment is what stops a
    // two-segment `router.create(...)` from matching.
    if (parts.length < 3) return null
    const confidence = tier(parts[parts.length - 3], call, 1)

    if (READ_METHODS.test(method)) {
      return { effectId: 'db.read', confidence, derivedBy: 'effects-plugin:prisma:read' }
    }
    if (WRITE_METHODS.test(method)) {
      return { effectId: 'db.write', confidence, derivedBy: 'effects-plugin:prisma:write' }
    }
    return null
  }
}

// The receiver and the argument count set the tier; neither gates the classification (§5.4).
function tier(receiver, call, maxArguments) {
  if (call.dynamicReceiver) return 'medium'
  if (call.argumentCount > maxArguments) return 'medium'
  // Word-wise against the client vocabulary, so `prismaClient` / `readReplicaDb` match and
  // `cache` / `router` do not — see `namesPrismaClient` in @aburi/effects-prisma.
  return identifierMentions(receiver ?? '', PRISMA_CLIENT_WORDS) ? 'high' : 'medium'
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
| EP3 | classify throws from its own classification logic | **not implemented.** Nothing between the classifier and the core's per-file boundary catches a throw, and the boundary cannot tell a classification bug from the EP3a violation below — both arrive as a plain `Error` — so this behaves as EP3a and withdraws the file. Degrading it instead needs the two to be distinguishable, which means a coded error from the guards |
| EP3a | classify throws an input-contract violation (§4.2) | propagates out of classification rather than degrading to an unclassified call; the core's per-file boundary (lang-plugin.md §7.2) then withdraws the file, names it in `skipped` / `extractionFailures`, and `aburi scan` exits non-zero |
| EP4 | 2 plugins classify the same call | the first in config order wins (first-match-wins) |
| EP5 | classify returns null | the call stays in `Symbol.calls[]` |
| EP6 | classify returns an EffectClassification | the call moves to `Symbol.effects[]` and does not stay in `Symbol.calls[]` |
| EP7 | plugin declaring `dropCallees` | matching callees are excluded from effects/calls, same as drop-list §5.2 |
| EP8 | logger-only plugin with `effects: []` and `dropCallees: ["pino"]` | classify keeps returning null, but pino.* is dropped |
| EP9 | returning any id under `effectPrefixes: ["x-stripe"]` | OK (no individual declaration needed) |
| EP10 | classify returns `confidence: 'low'` | Symbol.effects[].confidence = "low" goes into the IR as-is |
| EP11 | a call matching a plugin's shared-vocabulary shape on a receiver the plugin cannot identify (§5.4) | the effect is still recorded, at `confidence: "medium"` — not `high`, and not dropped |

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
