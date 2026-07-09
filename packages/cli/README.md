# @aburi/cli

The `aburi` command-line entry — wires
[`@aburi/config`](../config) +
[`@aburi/core`](../core) +
[`@aburi/diff`](../diff) +
[`@aburi/markdown-projection`](../markdown-projection) into the four subcommands
defined in [`design/details/cli-spec.md`](../../design/details/cli-spec.md).

## Subcommands

- **`aburi init`** — autodetect the workspace, write `aburi.json` with the
  detected languages / frameworks / components. `--force` overwrites,
  `--with-suggestions` appends `pnpm add -D @aburi/framework-<x>` JSONC
  comments for detected first-party plugins.
- **`aburi scan`** — load config, resolve plugins, run `@aburi/core` scan,
  emit IR JSON + workspace / component Markdown. `--format json|md|both`,
  `--ignore <glob>` (repeatable), `--no-respect-gitignore`, `--compact`,
  `--no-timestamp`.
- **`aburi diff`** — two dispatch paths:
  - `<base>..<head>` — `git rev-parse --verify` on both refs, shallow-repo
    guard, `git worktree add --detach` to materialise base, scan both sides,
    diff. Rename collection failures warn on stderr rather than silently
    degrading `moved` to `removed + added`.
  - `--base <ir.json> --head <ir.json>` — file mode, skips git entirely.
  `--fail-on <spec>` supports the full grammar (see below) and returns
  `EXIT.GATE = 3` when a clause trips.
- **`aburi explain`** — three-arm dispatch: full Symbol id (`ts:src/foo.ts#Foo.bar`),
  file path (all Symbols in the file, workspace-root-relative), or case-sensitive
  substring on `Symbol.name`. Ambiguous substring hits exit 2 with the candidate
  list.

## `--fail-on` grammar

Comma-separated clauses. Every clause supports an optional `:>N` count
threshold. Empty `--fail-on ""` is rejected (silent gate = green pipeline = bug).

- Status tokens: `added`, `removed`, `changed`, `moved`, `moved+changed`, `dropped-toggled`.
- Directional subtypes: `dropped-toggled:to-dropped`, `dropped-toggled:to-kept`.
- Delta axes: `api-changed`, `logic-changed`, `syntax-changed`.

Examples: `--fail-on removed`, `--fail-on changed:>5`, `--fail-on dropped-toggled:to-dropped:>10`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` `SUCCESS` | Command finished, no gate tripped. |
| `1` `RUNTIME` | Unexpected runtime failure (IO, unhandled exception). |
| `2` `INPUT_ERROR` | Bad argv, missing / malformed input, ambiguous explain target, `--fail-on` grammar error. |
| `3` `GATE` | `--fail-on` clause tripped, or a plugin failed to load. |

## Install

```bash
pnpm add -D @aburi/cli
pnpm exec aburi --version
```

`@aburi/cli` also exports the same command handlers programmatically
(`runInit`, `runScan`, `runDiff`, `runExplain`, `runCli`, `parseFailOn`,
`evaluateFailOn`, `DIFF_JSON_FILENAME`, `DIFF_MD_FILENAME`, …) so integration
tests can drive the CLI without spawning a subprocess.

`runCli({ argv, stdout, stderr, env, cwd })` returns the exit code and never
calls `process.exit` itself — the caller decides whether to `process.exit(code)`,
assign `process.exitCode`, or ignore it entirely. That is what lets the
integration suite drive the CLI with captured streams and assert on the exit
code without terminating the test process.

## See also

- [`docs/cli-reference.md`](../../docs/cli-reference.md) — per-subcommand flags and examples.
- [`design/details/cli-spec.md`](../../design/details/cli-spec.md) — CLI contract.
- [`packages/github-action`](../github-action) — GH Action wrapper.
