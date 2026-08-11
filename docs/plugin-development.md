# Plugin development

Aburi has three plugin types. They share a manifest contract but do very
different things:

| Type | Contract | Emits |
|---|---|---|
| **Language** | `parseFile`, `extractSymbols`, `walkBody`, `normalizeAst`, optional `symbolDropHint` | `SymbolCandidate`s + `BodyExtraction` (rules + calls) |
| **Framework** | `classifySymbol` | `SymbolClassification` (`extKind`, `derivedBy`, decorator boundaries) |
| **Effects** | `classify` | `EffectClassification` (`effectId`, `derivedBy`, `confidence`) |

The full type signatures live in
[`@aburi/types`](https://github.com/kage1020/Aburi/blob/main/packages/types/src/plugins.ts)
and the design contracts in the [language plugin spec](/design/lang-plugin),
the [extension vocabulary spec](/design/extension-vocab) (framework
classification lives inside the language plugin spec §5.2 — there is no
separate framework-plugin spec today), and the
[effect plugin spec](/design/effect-plugin).

This document is the operator-facing walkthrough.

## Manifest

Every plugin exports a `PluginManifest` and Aburi validates it against
`schema/aburi.plugin.v1.json`. The manifest is the *only* place a plugin
declares what vocabulary it owns — the runtime `VocabRegistry` uses the
declaration to enforce namespace ownership and reject cross-plugin collisions
at load time.

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

Two plugins declaring the same `extKind` id → the registry throws at register
time. This is intentional — we prefer a loud fail over a silent takeover.

## Language plugin

Parses a file, extracts Symbols, walks bodies to collect Rules + Calls, and
computes a normalised AST string for fingerprinting.

```ts
import type { LanguagePlugin, ParseResult, BodyExtraction } from "@aburi/types"

class MyLangPlugin implements LanguagePlugin {
  readonly manifest = myLangManifest
  // The LanguageId you stamp on every Symbol id, and what lands in
  // IR.workspace.languages. Must match `^[a-z][a-z0-9]*$` — the manifest name
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
  IR — you do not need to sort it yourself. Same for `calls`.
- `symbolDropHint` returns `{ reason, category: "B" | "C" }` or `null`. Category
  B drops mean "the Symbol never makes it into the IR" — use this for genuine
  boilerplate. Category C means "the Symbol is kept but its calls are pruned".
- Errors from `parseFile` are recoverable — return the tree you built and add
  the errors to `ParseResult.errors`. A `terminalParseFailure` (thrown) skips
  the file entirely and surfaces in the CLI's `parseErrorCount`.

## Framework plugin

Classifies a `SymbolCandidate` into a framework-owned `extKind` and optionally
overrides decorator boundaries.

```ts
import { splitAliasedImportName } from "@aburi/core"
import type { FrameworkClassifyContext, ImportEdge, SymbolClassification } from "@aburi/types"

/** Written identifier → the name its module exports it under, from the file's imports. */
function importedNames(imports: readonly ImportEdge[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const edge of imports) {
    if (edge.symbols === "*") continue
    for (const raw of edge.symbols) {
      const { imported, local } = splitAliasedImportName(raw)
      names.set(local, imported)
    }
  }
  return names
}

class MyFrameworkPlugin implements FrameworkPlugin {
  readonly manifest = myFrameworkManifest

  async init() {}

  classifySymbol(candidate, ctx: FrameworkClassifyContext): SymbolClassification | null {
    const names = importedNames(ctx.imports)
    const hit = candidate.decorators.find((d) => (names.get(d.name) ?? d.name) === "Widget")
    // Return null to abstain; the next framework plugin gets a turn.
    if (hit === undefined) return null
    return {
      extKind: "framework:mytool:widget",
      derivedBy: "framework:mytool:widget",
      // Keyed on the name the source wrote — that is what the pipeline matches against
      // `Decorator.name`. Optional: flip boundary flag for specific decorators.
      decoratorBoundaries: { [hit.name]: true },
    }
  }
}
```

Contracts:

- First non-null classification wins. Order matters — the CLI walks frameworks
  in the order they appear in `aburi.json`.
- `derivedBy` may contain `;`-separated multi-signal reasons; the pipeline
  splits them into individual `derivedBy[]` entries.
- Any `extKind` or `derivedBy` you emit must be declared in your manifest's
  `extKindPrefixes` / `derivedByPrefixes`.
- Match a decorator on the name it was **imported** under, not the one the source
  wrote, and read `ImportEdge.source` for provenance. Matching the written name
  alone loses `import { Widget as W }` and claims a `@Widget` that came from some
  other library. When the edges attribute the name to a module you do not own,
  classify at `confidence: "medium"` rather than refusing — a project-local
  re-export barrel looks exactly like a foreign package. See
  [`lang-plugin.md` §5.2.2](./design/lang-plugin.md) and
  [`packages/framework-nestjs/src/imports.ts`](https://github.com/kage1020/Aburi/tree/main/packages/framework-nestjs/src/imports.ts).

Decorator-free classification (name / shape / body signals) is also supported:
see [`packages/framework-react`](https://github.com/kage1020/Aburi/tree/main/packages/framework-react)
for a reference plugin that keys off PascalCase naming, `use[A-Z]` naming, JSX
return detection, and `createContext(...)` / `forwardRef(...)` / `memo(...)`
call-shape recognition — no decorators involved.

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
    // Pure — no I/O, no state, no async. The per-call timeout budget is 50ms
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
  `packages/effects-prisma` for the reference pattern — a random `foo.findMany()`
  in a file that never imports `@prisma/client` should return `null`, and so
  should `prisma.foo.bar()` in a file that never uses Prisma's method vocabulary.
- **Use the shared input guards, do not re-implement them.**
  `@aburi/plugin-registry/plugin-input` exports `assertNonEmptySegments` (splits
  a `CallCandidate.target` and rejects an empty target or empty segment) and
  `hasMatchingImport` (matches a module specifier after checking every
  `ImportEdge.source`). Both enforce the language plugin's normalized-output
  contract from [`design/lang-plugin.md`](design/lang-plugin.md) §4.4, and both
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

  It is the dedicated `/plugin-input` subpath on purpose — importing the package
  root would pull the manifest validator and its schema compilation into your
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

The loader resolves each ref as follows (`packages/cli/src/plugin-loader.ts:84-90`):

- Bare name with no `@` and no `/` → prefixed with `@aburi/` verbatim.
  `"lang-typescript"` → `@aburi/lang-typescript`, `"framework-mytool"` → `@aburi/framework-mytool`.
  The loader does **not** infer a bucket prefix — a config entry `frameworks: ["mytool"]`
  resolves to `@aburi/mytool`, NOT `@aburi/framework-mytool`. Third-party plugin
  authors should write the full package name (`framework-mytool` for a first-party
  bucket-prefixed name, or `@myorg/mypkg` for a scoped package) in `aburi.json`.
- Scoped or slash-containing (`@myorg/pkg`, `some-pkg/subpath`) → verbatim.
- Relative path (`./plugins/mytool.mjs`) → resolved against the workspace root
  as a `file:` URL.

Bucket assignment (`languages` / `frameworks` / `effects` in `aburi.json`) is
still enforced at load time: if the loaded manifest's `type` does not match the
bucket it was listed under, the loader throws with a `plugin-error`
(`CliError` → `EXIT.GATE`).

Your module must export the plugin as a default export, a `plugin` export, or
any top-level export whose value has a `manifest` field. The first hit wins.

## Testing

- Unit-test your plugin in isolation — see
  [`packages/framework-nestjs/test`](https://github.com/kage1020/Aburi/tree/main/packages/framework-nestjs/test)
  and
  [`packages/framework-react/test`](https://github.com/kage1020/Aburi/tree/main/packages/framework-react/test)
  for the pattern (fake `ExtractionContext`, hand-authored `SymbolCandidate`s;
  the React tests additionally exercise the real `@aburi/lang-typescript`
  parser for JSX-body walkers).
- Snapshot-verify the manifest against `schema/aburi.plugin.v1.json` — reuse the
  existing schema validation helpers in `@aburi/plugin-registry`.
- Wire the plugin into `packages/e2e-integration` for an integration pass
  against a small handwritten fixture project.

## Publishing

- Namespace under `@aburi/*` if first-party. Third-party plugins can use any
  scope (or unscoped) — the loader accepts both.
- Follow the workspace tsdown / tsconfig config so the plugin ships ESM
  (`.mjs` + `.d.mts`).
- Include `manifest` in the top-level exports so the loader's fallback hunt
  finds it.
