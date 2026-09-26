# @aburi/cli

The `aburi` command-line entry — wires
[`@aburi/config`](../config) +
[`@aburi/core`](../core) +
[`@aburi/diff`](../diff) +
[`@aburi/markdown-projection`](../markdown-projection) into the four subcommands
defined in [`docs/design/cli-spec.md`](../../docs/design/cli-spec.md).

## Subcommands

- **`aburi init`** — autodetect the workspace, write `aburi.json` with the
  detected languages / frameworks / components. `--force` overwrites,
  `--with-suggestions` appends `pnpm add -D @aburi/framework-<x>` JSONC
  comments for detected first-party plugins,
  `--respect-gitignore` / `--no-respect-gitignore` decides whether the
  language census reads `.gitignore` (honoured by default).
- **`aburi scan`** — load config, resolve plugins, run `@aburi/core` scan,
  emit IR JSON + workspace / component Markdown. `--format json|md|both`,
  `--ignore <glob>` (repeatable),
  `--respect-gitignore` / `--no-respect-gitignore`, `--compact`,
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

## `--max-bytes`

`aburi diff --max-bytes <n>` caps `diff.md` at n UTF-8 bytes, least-important-first: sections are
kept most important first at their smallest — a section of whole symbols as one name-and-location
line per symbol — and one is dropped only when it cannot fit even beside every more important one
cut that far; the lists then get their full entries back from the top as the budget allows. A
note under the Summary names both kinds — a byte cut would leave a `<details>` block or a code
fence open. It exists because a GitHub comment body cannot exceed
65536 bytes and the report is written to be pasted into one: at roughly 210 bytes per symbol, a
few hundred added symbols is enough to be refused. `diff.json` is never capped, and when the cap
changed the report the uncapped Markdown is written beside it as `diff.full.md`.

## `--fail-on` grammar

Comma-separated clauses. Every clause supports an optional `:>N` count
threshold. Empty `--fail-on ""` is rejected (silent gate = green pipeline = bug), and so is
an empty clause (`added,`, `added,,removed`).

- Status tokens: `added`, `removed`, `changed`, `moved`, `moved+changed`, `dropped-toggled`.
- Directional subtypes: `dropped-toggled:to-dropped`, `dropped-toggled:to-kept`.
- Delta axes: `api-changed`, `logic-changed`, `syntax-changed`, `confidence-changed`.

Examples: `--fail-on removed`, `--fail-on changed:>5`, `--fail-on dropped-toggled:to-dropped:>10`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` `SUCCESS` | Command finished, no gate tripped. |
| `1` `RUNTIME` | Unexpected runtime failure (IO, unhandled exception). |
| `2` `INPUT_ERROR` | Bad argv, missing / malformed input, ambiguous explain target, `--fail-on` grammar error. |
| `3` `GATE` | `--fail-on` clause tripped, a plugin failed to load, a scan the command ran did not exit clean, or the answer would not be safe — `aburi explain` against an IR that names the file in question as one it never analysed. |

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

- [`docs/reference/cli.md`](../../docs/reference/cli.md) — per-subcommand flags and examples.
- [`docs/design/cli-spec.md`](../../docs/design/cli-spec.md) — CLI contract.
- [`packages/github-action`](../github-action) — GH Action wrapper.
