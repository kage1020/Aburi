---
"@aburi/cli": minor
---

Add the Aburi command-line entry — `@aburi/cli` — that wires `@aburi/config`, `@aburi/core`, `@aburi/diff`, and `@aburi/markdown-projection` into the commands defined in `design/details/cli-spec.md`. Ships with a `bin/aburi.mjs` shim and a testable `runCli(argv)` surface so integration tests can drive the CLI without spawning a subprocess.

### Commands

- **`aburi init`** — autodetect the workspace root and every JS/TS Component, write an `aburi.json` (or `--output <path>`) with the discovered `languages` / `frameworks` / `components`. Refuses to overwrite unless `--force`. `--with-suggestions` appends JSONC install comments (`pnpm add -D @aburi/framework-nestjs`) for every framework that has a first-party plugin.
- **`aburi scan`** — resolve config → load plugins → run `@aburi/core` `scan` → write `out/aburi.ir.json` + `out/workspace.md` + `out/components/*.md`. Respects `--format json|md|both`, `--no-json` / `--no-md` shortcuts, `--compact`, `--ignore <glob>` (repeatable), `--no-respect-gitignore`, `--no-timestamp`. Parse errors, effect-classify timeouts, and discovery-time skips surface on stderr so a scan that silently ate 50 broken files still leaves a visible signal.
- **`aburi diff`** — two dispatch paths (§6):
  - `<base>..<head>` — `git rev-parse --verify` is run against BOTH refs (a mistyped head no longer silently degrades to a "current tree vs base" diff), the shallow-repository guard fires, then `git worktree add --detach` materialises the base and `runScan` executes inside it. The head is always scanned from the working tree (the head ref label is used only for the report). Cleanup runs in `finally`, and every intermediate scan output lives under `mkdtemp` so the user's repo stays clean even if the run aborts. Rename collection failures warn on stderr instead of silently degrading `moved` results into `removed + added` pairs. A missing `git` binary produces a distinct install-git error instead of the "ref not found" false alarm.
  - `--base <ir.json> --head <ir.json>` — parses two IR files and jumps straight into `buildDiff`.
- **`aburi explain`** — three-arm dispatch (§7.2): full Symbol id (contains `#`) → direct lookup, file path (contains `/`, exists on disk) → all Symbols in the file, otherwise → case-sensitive substring match on `Symbol.name`. Ambiguous substring hits exit 2 with the candidate list on stdout.

### `--fail-on` CI gate

Comma-separated clause list supporting every taxonomy the design (§6.7) calls out:

- Status tokens: `added` / `removed` / `changed` / `moved` / `moved+changed` / `dropped-toggled`.
- Direction subtypes: `dropped-toggled:to-dropped` / `dropped-toggled:to-kept`.
- Delta axes: `api-changed` / `logic-changed` / `syntax-changed`.
- Optional threshold: `<token>:>N` fires only when observed count exceeds `N` (strict `>` semantics; other comparators reserved for a future extension).

The parser is exhaustive — unknown tokens, unsupported comparators, non-integer / negative thresholds, and an **empty** `--fail-on` value (from an unset shell variable) all throw `FailOnParseError`. A silently-empty gate would let regressions through with a green exit code, so `--fail-on ""` is treated as a configuration mistake, not "gate disabled". `FailOnParseError` maps to `EXIT.INPUT_ERROR` (not runtime) so a grammar typo does not masquerade as a runtime bug. Evaluation returns the first triggered clause so the CI log stays tight; a triggered clause maps to `EXIT.GATE`.

### Exit codes (§9)

`EXIT.SUCCESS (0)` / `EXIT.RUNTIME (1)` / `EXIT.INPUT_ERROR (2)` / `EXIT.GATE (3)`. `CliError` carries a code that the driver maps to one of these; `commander`'s help / version paths are pinned to `SUCCESS`. `runCli()` never calls `process.exit` — it returns the code so the test suite can drive it with captured streams.

### Plugin loader

`loadPlugins({config, workspaceRoot, importModule?, syntheticPlugins?})` resolves every `PluginRef` in `config.{languages,frameworks,effects}`:
- Bare manifest name (`effects-prisma`) → `@aburi/effects-prisma` package.
- Scope-prefixed (`@scope/pkg`) or path-like → verbatim package id.
- Relative (`./plugins/x.mjs`) → resolved against the workspace root as a `file:` URL.

Each imported module is scanned for a `default` export, then `plugin`, then any top-level export whose value has a `manifest` field with `name` + `type` strings. The routed plugin's declared `manifest.type` must match the bucket it was listed under; a mismatch throws a `CliError("plugin-error")`. Framework-hint synthetic manifests from `@aburi/config` are registered too so hint-declared vocab is available without a physical plugin package.

### Public API

`runCli`, `runInit`, `runScan`, `runDiff`, `runExplain`, `loadPlugins`, `parseFailOn`, `evaluateFailOn`, `evaluateClause`, `formatTriggered`, `readEnv`, `createLogger`, `CliError`, `EXIT`, plus supporting types.

### Tests

46 tests across `test/{env,fail-on,plugin-loader,run,init,diff-fs,explain}.test.ts` cover the CL1..CL18 verifiables reachable without a live plugin runtime: `--version` / `--help` / unknown command routing, argv validation for `aburi diff` (CL10), `--fail-on` grammar and all comparator + status-token combinations, plugin-loader routing / bucketing / mismatches, `init` file-handling (CL4 / CL5), `runDiff` file-mode + `--fail-on` gate → `EXIT.GATE`, `explain` ambiguous substring → `EXIT.INPUT_ERROR` (CL11).
