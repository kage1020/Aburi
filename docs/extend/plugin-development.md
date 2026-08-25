# Plugin development

A plugin teaches Aburi something it does not already know: a language to parse,
a framework whose decorators mean something, or a library whose calls have
effects. There are three kinds, and they plug into different stages of
[the pipeline](/extend/architecture#the-pipeline).

| Kind | You implement | It produces |
|---|---|---|
| **Language** | `parseFile`, `extractSymbols`, `walkBody`, `normalizeAst` | Symbols, plus the rules and calls in their bodies |
| **Framework** | `classifySymbol` | A framework kind and boundary flags for a symbol |
| **Effects** | `classify` | An effect for a call: `db.write`, `network.rpc`, and so on |

Type signatures live in
[`@aburi/types`](https://github.com/kage1020/Aburi/blob/main/packages/types/src/plugins.ts);
the full contracts are in the [design docs](/design/overview).

::: tip Before writing one
A decorator-based framework often needs no code at all.
[`frameworkHints`](/guide/configuration#teach-it-your-in-house-framework) covers
it from config.
:::

## Manifest

Every plugin exports a `PluginManifest` and Aburi validates it against
`schema/aburi.plugin.v1.json`. The manifest is the *only* place a plugin
declares what vocabulary it owns. The runtime `VocabRegistry` reads that
declaration to enforce namespace ownership and reject cross-plugin collisions at
load time.

```ts
import type { FrameworkManifest } from "@aburi/types"

export const myFrameworkManifest: FrameworkManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "framework-mytool",
  version: "0.1.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [
      {
        id: "framework:mytool:widget",
        baseKind: "class",
        description: "MyTool widget class declared with @Widget().",
      },
    ],
    extKindPrefixes: ["framework:mytool"],
    derivedByPrefixes: ["framework:mytool"],
    frameworks: ["mytool"],
  },
}
```

Key rules:

- `extKinds[].id` must be namespaced under one of `extKindPrefixes`.
- `derivedByPrefixes` claims the tag prefixes your plugin will emit in
  `derivedBy`. Every `derivedBy` entry the plugin returns at runtime must fall
  under one of these prefixes.
- `frameworks` is used by `aburi init` autodetect to route framework names in
  `aburi.json` to your plugin.

Two plugins declaring the same `extKind` id make the registry throw at register
time. We chose a loud failure over a silent takeover.

## Language plugin

Parses a file, extracts Symbols, walks bodies to collect Rules + Calls, and
computes a normalised AST string for fingerprinting.

```ts
import type { LanguagePlugin, ParseResult, BodyExtraction } from "@aburi/types"

class MyLangPlugin implements LanguagePlugin {
  readonly manifest = myLangManifest
  // The LanguageId you stamp on every Symbol id, and what lands in
  // IR.workspace.languages. Must match `^[a-z][a-z0-9]*$`. The manifest name
  // ("lang-mylang") is a plugin ref and cannot be used here.
  readonly languageId = "my"
  readonly fileExtensions = [".my"] as const
  readonly capabilities = { /* boolean matrix */ }

  async init() {}

  async parseFile(file): Promise<ParseResult> {
    // Return { tree, errors, imports }. `tree` is opaque to the pipeline.
  }

  extractSymbols(tree, ctx) {
    // Return SymbolCandidate<Node>[]. Every id must start with `<language>:`.
  }

  walkBody(symbol, ctx): BodyExtraction {
    return { rules: [], calls: [] }
  }

  normalizeAst(symbol) {
    // Canonical AST string. Whitespace / comment insensitive. Identifiers preserved.
    return ""
  }

  symbolDropHint(symbol, ctx) {
    // Optional: language-specific drop candidates the shape-only core rules
    // cannot judge (e.g. `{}` empty body detection).
    return null
  }
}
```

Contracts to know:

- Every `SymbolCandidate.id` must begin with `<language>:` (the language prefix
  claimed by your manifest). The pipeline throws otherwise.
- `walkBody`'s `Rule` output is line-sorted by the pipeline before entering the
  IR, so you do not sort it yourself. Same for `calls`.
- `symbolDropHint` returns `{ reason, category: "B" | "C" }` or `null`. Category
  B drops keep the Symbol out of the IR, so use it for genuine boilerplate.
  Category C keeps the Symbol and prunes its calls.
- A syntax error is not a reason to give up: return the tree you built and add a
  `recoverable: true` error. The file is extracted as usual.
- Refuse a file by adding an error with `recoverable: false`, or by returning
  `tree: null`. The file is withdrawn and recorded as skipped, and the run still
  exits `0`. An unusable source file tells you about your repository, not about
  a failure.
- **Throw only when your plugin has a bug.** A throw withdraws the file *and*
  exits the scan `3`.

::: details The exact contract for refusing and throwing
`recoverable: false` must be the literal `false`; omitting the key means
recoverable. A refused file gets no Symbols, is left out of `stats.parsedFiles`,
and appears in `ScanResult.skipped` under `reason: "parse-failed"` with your
message. Set both the flag and `tree: null` when you have no tree; set only the
flag when you have one but refuse it, such as a wrong-dialect source or a
generated blob.

Refusals leave the exit code at `0` until they take the whole workspace: a scan
that parsed no file at all exits `3`, so a dialect check with its comparison
backwards is caught rather than shipped as an empty IR.

A throw is recorded as `reason: "extraction-failed"` along with what you threw.
The exception is an error whose `code` names a fault in the plugin set rather
than in the file, such as `scan-plugin-misconfigured`, `invalid-language-id`, or
`vocab-undeclared`. Those are re-thrown and end the run immediately, because
they would otherwise repeat for every file and report the workspace as broken
instead of the plugin.
:::

## Framework plugin

Classifies a `SymbolCandidate` into a framework-owned `extKind` and optionally
overrides decorator boundaries.

```ts
import { splitAliasedImportName } from "@aburi/core"
import { assertImportBinding, assertImportEdgeSource } from "@aburi/plugin-registry/plugin-input"
import type { Confidence, FrameworkClassifyContext, ImportEdge, SymbolClassification } from "@aburi/types"

/** Written identifier → the exported name it resolves to, and whether you own the module. */
function importedNames(imports: readonly ImportEdge[], filePath: string) {
  const origin = { plugin: "framework-mytool", filePath }
  const names = new Map<string, { imported: string; mine: boolean }>()
  for (const edge of imports) {
    // Validate every edge before answering, or the throw depends on import order.
    assertImportEdgeSource(edge, origin)
    if (edge.symbols === "*") continue
    const mine = edge.source.startsWith("@mytool/")
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      assertImportBinding(binding, raw, edge, origin)
      names.set(binding.local, { imported: binding.imported, mine })
    }
  }
  return names
}

class MyFrameworkPlugin implements FrameworkPlugin {
  readonly manifest = myFrameworkManifest

  async init() {}

  classifySymbol(candidate, ctx: FrameworkClassifyContext): SymbolClassification | null {
    const names = importedNames(ctx.imports, ctx.file.path)
    let confidence: Confidence = "high"
    const hit = candidate.decorators.find((d) => {
      const origin = names.get(d.name)
      // No edge mentions it: nothing to resolve, so the written name stands.
      if (origin === undefined) return d.name === "Widget"
      if (origin.imported !== "Widget") return false
      // Same name, someone else's module. Classify, but say you are less sure.
      confidence = origin.mine ? "high" : "medium"
      return true
    })
    // Return null to abstain; the next framework plugin gets a turn.
    if (hit === undefined) return null
    return {
      extKind: "framework:mytool:widget",
      derivedBy: "framework:mytool:widget",
      // Keyed on the name the source wrote, which is what the pipeline matches against
      // `Decorator.name`. Optional: flip boundary flag for specific decorators.
      decoratorBoundaries: { [hit.name]: true },
      // Omit the key for `high`: the pipeline reads an absent `confidence` as exactly that.
      ...(confidence === "high" ? {} : { confidence }),
    }
  }
}
```

`framework-nestjs` is the same shape with the duplicate-binding rule and the per-file
memo filled in; read [`packages/framework-nestjs/src/imports.ts`](https://github.com/kage1020/Aburi/tree/main/packages/framework-nestjs/src/imports.ts)
before shipping a plugin that matches names against a package's vocabulary.

Contracts:

- First non-null classification wins. Order matters, because the CLI walks
  frameworks in the order they appear in `aburi.json`.
- `derivedBy` may contain `;`-separated multi-signal reasons; the pipeline
  splits them into individual `derivedBy[]` entries.
- Any `extKind` or `derivedBy` you emit must be declared in your manifest's
  `extKindPrefixes` / `derivedByPrefixes`.
- Match a decorator on the name it was **imported** under, not the one the source
  wrote, and read `ImportEdge.source` for provenance. Matching the written name
  alone loses `import { Widget as W }` and claims a `@Widget` that came from some
  other library. When the edges attribute the name to a module you do not own,
  classify at `confidence: "medium"` rather than refusing, because a
  project-local re-export barrel looks like a foreign package. See
  the [language plugin spec](/design/lang-plugin#522-matching-a-decorator-against-the-import-edges).
- `ctx.imports` is the live array the pipeline reports as the file's imports, not a copy.
  Read it, memoize on its identity if you like, and never mutate it.

Decorator-free classification (name / shape / body signals) is also supported:
see [`packages/framework-react`](https://github.com/kage1020/Aburi/tree/main/packages/framework-react)
for a reference plugin that keys off PascalCase naming, `use[A-Z]` naming, JSX
return detection, and `createContext(...)` / `forwardRef(...)` / `memo(...)`
call-shape recognition, with no decorators involved.

## Effects plugin

Classifies a `CallCandidate` into a core effect vocabulary
(`db.read` / `db.write` / `db.transaction` / `event.publish` / `net.fetch` /
`fs.read` / `fs.write` / …).

```ts
import type { EffectPlugin, EffectClassification } from "@aburi/types"

class MyEffectsPlugin implements EffectPlugin {
  readonly manifest = myEffectsManifest

  async init() {}

  classify(call, ctx): EffectClassification | null {
    // Keep it pure: no I/O, no state, no async. The per-call budget is 50ms
    // by default and stateful classifiers are the reason it exists.
    if (!looksLikeMyEffect(call, ctx)) return null
    return {
      effectId: "net.fetch",
      confidence: "high",
      derivedBy: `effects-plugin:mytool:${call.target}`,
    }
  }

  // Optional: drop callees you know are pure-boilerplate (Category C).
  readonly dropCallees = ["mytool.helper.formatUrl"]
}
```

Contracts:

- First non-null classification wins across the effects plugin list.
- The classifier is called under a per-call timeout budget. Keep it pure so a
  slow classification is a bug, not a design decision.
- **Two-signal layered gate is strongly recommended**: check for both an
  import-time signal (does the file import the target library at all?) AND a
  call-site signal (does the target's segment shape match?). See
  `packages/effects-prisma` for the reference pattern. A random `foo.findMany()`
  in a file that never imports `@prisma/client` should return `null`, and so
  should `prisma.foo.bar()` in a file that never uses Prisma's method vocabulary.
- **Use the shared input guards, do not re-implement them.**
  `@aburi/plugin-registry/plugin-input` exports `assertNonEmptySegments` (splits
  a `CallCandidate.target` and rejects an empty target or empty segment) and
  `hasMatchingImport` (matches a module specifier after checking every
  `ImportEdge.source`). Both enforce the language plugin's normalized-output
  contract from the [language plugin spec](/design/lang-plugin), and both
  take a `{ plugin, filePath }` record so the thrown message names your plugin
  and the offending file:

  ```ts
  import { assertNonEmptySegments, hasMatchingImport } from "@aburi/plugin-registry/plugin-input"

  classify(call, ctx) {
    const origin = { plugin: "effects-mytool", filePath: ctx.file.path }

    // Run the fail-fast BEFORE the import gate. The other order lets an upstream
    // normalization bug surface only in files that import your library and stay
    // silent everywhere else.
    const { segments, last } = assertNonEmptySegments(call.target, origin)
    if (!hasMatchingImport(ctx.file.imports, origin, (source) => source === "mytool")) return null

    if (segments.length < 2 || !MY_VERBS.has(last)) return null
    return { effectId: "net.fetch", confidence: "high", derivedBy: `effects-plugin:mytool:${last}` }
  }
  ```

  Import the dedicated `/plugin-input` subpath rather than the package root,
  which would pull the manifest validator and its schema compilation into your
  classifier's startup path.

## Registering with the CLI

Once your manifest and plugin object are ready, the CLI's plugin-loader
discovers them by package name from `aburi.json`:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": ["framework-mytool"],
  "effects": ["effects-mytool"]
}
```

Each entry resolves to one specifier. There is no fallback chain:

| Written | Resolves to |
|---|---|
| `framework-mytool` | `@aburi/framework-mytool` |
| `@myorg/mypkg` | `@myorg/mypkg`, verbatim |
| `./plugins/mytool.mjs` | That path, relative to the workspace root |

No bucket prefix is inferred: `frameworks: ["mytool"]` resolves to
`@aburi/mytool`, not `@aburi/framework-mytool`. Publish under a scope and write
the full package name.

The list a plugin appears in must match its manifest `type`, or the loader fails
the run.

Your module must export the plugin as a default export, a `plugin` export, or
any top-level export whose value has a `manifest` field. The first hit wins.

## Testing

- Unit-test your plugin in isolation. See
  [`packages/framework-nestjs/test`](https://github.com/kage1020/Aburi/tree/main/packages/framework-nestjs/test)
  and
  [`packages/framework-react/test`](https://github.com/kage1020/Aburi/tree/main/packages/framework-react/test)
  for the pattern (fake `ExtractionContext`, hand-authored `SymbolCandidate`s;
  the React tests also drive the real `@aburi/lang-typescript` parser for
  JSX-body walkers).
- Snapshot-verify the manifest against `schema/aburi.plugin.v1.json`, reusing
  the schema validation helpers in `@aburi/plugin-registry`.
- Wire the plugin into `packages/e2e-integration` for an integration pass
  against a small handwritten fixture project.

## Publishing

- Namespace under `@aburi/*` if first-party. Third-party plugins can use any
  scope, or none at all. The loader accepts both.
- Follow the workspace tsdown / tsconfig config so the plugin ships ESM
  (`.mjs` + `.d.mts`).
- Include `manifest` in the top-level exports so the loader's fallback hunt
  finds it.
