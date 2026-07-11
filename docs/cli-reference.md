# CLI reference

`aburi <subcommand> [flags]`. Global flags: `-v, --version` prints the CLI
version and exits `SUCCESS`; `-h, --help` prints usage and exits `SUCCESS`.

The authoritative contract lives in the [CLI spec](/design/cli-spec). This
document is the operator-facing reference.

## Exit codes

| Code | Constant | When it fires |
|---|---|---|
| `0` | `EXIT.SUCCESS` | Command finished; no `--fail-on` gate triggered. |
| `1` | `EXIT.RUNTIME` | Unexpected runtime failure (IO, unhandled exception). |
| `2` | `EXIT.INPUT_ERROR` | Bad argv, missing / malformed input file, unresolvable IR shape, ambiguous `aburi explain` target, `--fail-on` grammar mistake. |
| `3` | `EXIT.GATE` | `--fail-on` clause triggered, or a plugin failed to load. This is the code CI pipelines gate on. |

## Environment variables

| Variable | Purpose |
|---|---|
| `ABURI_CONFIG` | Alternate config file path. Overridden by the `--config` flag when present. |
| `ABURI_LOG_LEVEL` | Reserved for future logger wiring. The CLI currently reads the variable into `env.logLevel` but no code consumes it yet, so setting it has no runtime effect. |
| `NO_COLOR` | Suppress ANSI colour output. |
| `CI` | When set, `aburi scan` implicitly enables `--no-timestamp` for reproducible IR bytes. |

## Config discovery order (§11 precedence)

1. `--config <path>` if given.
2. `ABURI_CONFIG` env variable if set.
3. `aburi.jsonc` / `aburi.json` walking up from `cwd`.
4. On-disk defaults.

---

## `aburi init`

Autodetect the workspace and write `aburi.json`.

```
aburi init [--output <path>] [--force] [--with-suggestions]
```

| Flag | Effect |
|---|---|
| `--output <path>` | Write to a different path (default `./aburi.json`). |
| `--force` | Overwrite an existing output file. Without this, an existing file → `EXIT.INPUT_ERROR`. |
| `--with-suggestions` | Append `pnpm add -D @aburi/framework-<x>` JSONC banner comments for detected first-party plugins. |

**Examples:**

```bash
aburi init
aburi init --with-suggestions --output config/aburi.jsonc
aburi init --force
```

---

## `aburi scan`

Load config, resolve plugins, run the scan pipeline, emit IR JSON + Markdown.

```
aburi scan [--output-dir <dir>] [--format json|md|both]
           [--ignore <glob>] [--no-respect-gitignore]
           [--compact] [--no-timestamp]
           [--config <path>]
```

| Flag | Effect |
|---|---|
| `--output-dir <dir>` | Where to emit `aburi.ir.json` / `workspace.md` / `components/*.md`. Default `out`. |
| `--format <fmt>` | `json`, `md`, or `both` (default `both`). |
| `--no-md` / `--no-json` | Shortcuts for `--format json` and `--format md`. |
| `--ignore <glob>` | Additional ignore glob. Repeatable. |
| `--no-respect-gitignore` | Do not honour `.gitignore` during discovery. |
| `--compact` | Emit JSON without indentation. |
| `--no-timestamp` | Omit `generatedAt` from the IR. Implicit when `CI` env is set. |
| `--config <path>` | Alternate config file. |

Non-fatal incidents are surfaced on stderr — recoverable parse errors, effect-classify
timeouts, discovery-time skips. They do NOT change the exit code; they warn
loudly so a scan that ate 50 broken files never looks green.

**Examples:**

```bash
aburi scan
aburi scan --format json --compact --output-dir dist/aburi
aburi scan --ignore 'src/generated/**' --ignore 'test/fixtures/**'
```

---

## `aburi diff`

Compute the semantic diff between two IRs. Two dispatch paths:

```
aburi diff <base>..<head>            [--output-dir <dir>] [--format json|md|both]
                                      [--fail-on <spec>] [--compact] [--config <path>]

aburi diff --base <base.json>        --head <head.json>
                                      [--output-dir <dir>] [--format json|md|both]
                                      [--fail-on <spec>] [--compact] [--config <path>]
```

**Ref mode** — `git rev-parse --verify` runs against BOTH refs (mistyped head
does not silently degrade to "current tree vs base"), the shallow-repo guard
fires, then `git worktree add --detach` materialises the base and scans it. Head
is always scanned from the working tree — its ref label is used only for the
report. Rename collection failures warn on stderr instead of silently downgrading
`moved` to `removed + added`.

**File mode** — read two IR files and jump straight to `buildDiff`. Skips git.

| Flag | Effect |
|---|---|
| `<base>..<head>` | Ref-spec dispatch (git). |
| `--base <path>` `--head <path>` | File-mode dispatch. Mutually exclusive with the ref-spec. |
| `--output-dir <dir>` | Emit `diff.json` + `diff.md` here. Default `out`. |
| `--format <fmt>` | `json`, `md`, or `both`. |
| `--fail-on <spec>` | CI gate — see below. |
| `--compact` | JSON without indentation. |
| `--config <path>` | Alternate config file. |

### `--fail-on` grammar

Comma-separated clauses. Every clause optionally carries a threshold `:>N`
(strict `>` semantics — other comparators are reserved for future extension).

- **Status tokens**: `added`, `removed`, `changed`, `moved`, `moved+changed`, `dropped-toggled`.
- **Directional subtypes**: `dropped-toggled:to-dropped`, `dropped-toggled:to-kept`.
- **Delta axes**: `api-changed`, `logic-changed`, `syntax-changed`.

The parser is exhaustive — unknown tokens, unsupported comparators, negative or
non-integer thresholds, and an **empty** `--fail-on` value all throw
`FailOnParseError` (mapped to `EXIT.INPUT_ERROR`). An empty gate would let
regressions slip through as green pipelines; treating it as a config error is
deliberate.

Evaluation stops at the first triggered clause so CI logs stay tight; a
triggered clause maps to `EXIT.GATE`.

**Examples:**

```bash
aburi diff main..HEAD
aburi diff main..HEAD --fail-on 'removed,dropped-toggled:to-dropped:>10'
aburi diff --base ir-main.json --head ir-branch.json --format md
```

---

## `aburi explain`

Show detail for a single Symbol.

```
aburi explain <id-or-pattern> [--ir <path>] [--output <path>] [--no-rescan] [--config <path>]
```

Three-arm dispatch:

1. **Contains `#`** → treated as a full Symbol id and looked up directly.
2. **Contains `/` and exists on disk** → all Symbols whose `source.file` matches
   the workspace-root-relative POSIX path.
3. **Otherwise** → case-sensitive substring match on `Symbol.name`.

| Flag | Effect |
|---|---|
| `--ir <path>` | Existing IR file (skip autoscan). |
| `--output <path>` | Write Markdown to a file instead of stdout. |
| `--no-rescan` | Fail if no IR file exists — do not implicitly rescan. |
| `--config <path>` | Alternate config file. |

Ambiguous substring hits exit `2` (`EXIT.INPUT_ERROR`) with the candidate list on
stdout so the operator can requalify. Zero hits exit `1` (`EXIT.RUNTIME`).

**Examples:**

```bash
aburi explain 'ts:src/billing/billing.service.ts#BillingService.applyRefund'
aburi explain src/billing/billing.service.ts
aburi explain applyRefund
aburi explain applyRefund --output docs/applyRefund.md
```

---

## Programmatic surface

`@aburi/cli` also exports every command handler as a function so integration
tests can drive the CLI without spawning:

```ts
import { runCli, runInit, runScan, runDiff, runExplain } from "@aburi/cli"
import { parseFailOn, evaluateFailOn, EXIT, DIFF_JSON_FILENAME } from "@aburi/cli"
```

`runCli({ argv, stdout, stderr, env, cwd })` never calls `process.exit` — it
returns the exit code so the caller decides.
