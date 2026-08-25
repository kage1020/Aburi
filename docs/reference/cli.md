# CLI reference

```
aburi <command> [flags]
```

| Command | Purpose |
|---|---|
| [`init`](#aburi-init) | Detect the project and write `aburi.json`. |
| [`scan`](#aburi-scan) | Analyse the workspace; write the JSON analysis and Markdown. |
| [`diff`](#aburi-diff) | Compare two revisions; write the review report. |
| [`explain`](#aburi-explain) | Print the detail for one symbol. |

`-v` / `--version` and `-h` / `--help` work anywhere and exit `0`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, no gate tripped. |
| `1` | Runtime failure — I/O error, unexpected exception, or `explain` found no match. |
| `2` | Bad invocation — unknown flag, missing input file, malformed `--fail-on`, ambiguous `explain` target. |
| `3` | **Gate.** A `--fail-on` clause tripped, a plugin failed, or the scan read too little of the workspace to be trusted. |

`3` is the code CI gates on.

## Environment variables

| Variable | Effect |
|---|---|
| `ABURI_CONFIG` | Config file path. The `--config` flag wins over it. |
| `NO_COLOR` | Suppress colour output. |
| `CI` | Makes `aburi scan` omit the timestamp, so identical commits produce identical bytes. |

## Config discovery

1. `--config <path>`
2. `ABURI_CONFIG`
3. `aburi.jsonc` / `aburi.json`, walking up from the working directory
4. Built-in defaults

Paths given to `--config` resolve against the working directory. Paths *inside*
the config resolve against the workspace root, which is not necessarily the same
directory — `aburi scan` warns when they differ.

---

## `aburi init`

```
aburi init [--output <path>] [--force] [--with-suggestions]
           [--respect-gitignore | --no-respect-gitignore]
```

Detects the workspace layout, languages, frameworks, and components, and writes
a config file.

| Flag | Effect |
|---|---|
| `--output <path>` | Write somewhere other than `./aburi.json`. |
| `--force` | Overwrite an existing file. Without it, an existing file exits `2`. |
| `--with-suggestions` | Add comments naming the plugin packages it detected but you have not installed. |
| `--no-respect-gitignore` | Include git-ignored files when taking the language census. |

```bash
aburi init
aburi init --with-suggestions --output config/aburi.jsonc
```

---

## `aburi scan`

```
aburi scan [--output-dir <dir>] [--format json|md|both]
           [--ignore <glob>]... [--respect-gitignore | --no-respect-gitignore]
           [--compact] [--no-timestamp] [--config <path>]
```

Analyses the workspace and writes `aburi.ir.json`, `workspace.md`, and
`components/*.md`.

| Flag | Effect |
|---|---|
| `--output-dir <dir>` | Where to write. Falls back to `output.dir` in the config, then `out`. |
| `--format <fmt>` | `json`, `md`, or `both` (default). `--no-md` and `--no-json` are shorthands. |
| `--ignore <glob>` | An extra exclusion for this run. Repeatable. |
| `--respect-gitignore` / `--no-respect-gitignore` | Override the config for this run. |
| `--compact` | JSON without indentation. |
| `--no-timestamp` | Omit `generatedAt`. Implicit when `CI` is set. |
| `--config <path>` | Use a different config file. |

```bash
aburi scan
aburi scan --format json --compact --output-dir dist/aburi
aburi scan --ignore 'src/generated/**'
```

### Files that produce nothing

Files the scan could not use are listed on stderr, grouped by reason, with a
pointer to the setting that governs each. This does not fail the run — an
unparseable file describes your source, not the scan.

::: details When a scan does exit 3
- **Nothing was parsed at all.** An `ignore` pattern ate the tree, a
  `components[].roots` matched nothing, or no installed plugin claims any
  extension present. The output is still written.
- **Coverage fell below `minParsedFileRatio`**, if you set one.
- **A plugin threw** on a file, as opposed to declining it.
- **A filename cannot be written down.** A path containing a backslash has no
  representation in the analysis, and filenames differing only in Unicode
  composition collapse to the same one. Both are reported by name on stderr and
  need renaming; `ignore` can exclude them instead — note that a backslash must
  be doubled in a glob pattern.
:::

Every command that scans reports the same way. `aburi diff` runs two scans and
labels each: the base by its ref, the head as `head (working tree)`.

---

## `aburi diff`

```
aburi diff <base>..<head>       [flags]
aburi diff --base <a.json> --head <b.json>  [flags]
```

Compares two revisions and writes `diff.json` and `diff.md`.

**Ref mode** verifies both refs with git, checks out the base into a temporary
worktree, and scans it. The head is always scanned from your working tree — its
ref is used only as a label in the report.

**File mode** compares two previously written `aburi.ir.json` files. No git, no
scanning.

| Flag | Effect |
|---|---|
| `<base>..<head>` | Ref-spec dispatch. |
| `--base <path>` `--head <path>` | File-mode dispatch. Mutually exclusive with the ref-spec. |
| `--fail-on <spec>` | The CI gate. See below. |
| `--output-dir <dir>` | Where to write. Falls back to `output.dir`, then `out`. |
| `--format <fmt>` | `json`, `md`, or `both`. |
| `--compact` | JSON without indentation. |
| `--config <path>` | Use a different config file. |

In ref mode, a scan that did not finish cleanly exits `3` even with no
`--fail-on` — a workspace `aburi scan` refuses to call green cannot go green here
instead.

```bash
aburi diff main..HEAD
aburi diff main..HEAD --fail-on 'removed,dropped-toggled:to-dropped:>10'
aburi diff --base ir-main.json --head ir-branch.json --format md
```

### `--fail-on` grammar

Comma-separated clauses. Each may carry a `:>N` threshold; without one, a single
occurrence trips the gate.

```
--fail-on 'removed,changed:>20,api-changed'
```

| Clause | Matches |
|---|---|
| `added` `removed` `changed` `moved` `moved+changed` `dropped-toggled` | Symbols with that status. |
| `dropped-toggled:to-dropped` `dropped-toggled:to-kept` | One direction of a boilerplate toggle. |
| `api-changed` `logic-changed` `syntax-changed` | Symbols whose change touched that axis. |

Evaluation stops at the first clause that fires, so CI logs stay short.

::: warning Quote the value
`>` is a shell redirect. Write `--fail-on 'changed:>5'`, not
`--fail-on changed:>5`.
:::

Unknown tokens, comparators other than `>`, non-integer thresholds, and an empty
value all exit `2`. An empty gate is treated as a mistake rather than as "no
gate", because it would turn every regression into a green pipeline.

---

## `aburi explain`

```
aburi explain <target> [--ir <path>] [--output <path>] [--no-rescan] [--config <path>]
```

Prints the full detail for one symbol. The target can be:

| Form | Example |
|---|---|
| A full symbol id | `ts:src/billing/billing.service.ts#BillingService.applyRefund` |
| A file path | `src/billing/billing.service.ts` — every symbol in that file |
| A name fragment | `applyRefund` — case-sensitive substring match |

| Flag | Effect |
|---|---|
| `--ir <path>` | Read an existing analysis instead of scanning. |
| `--output <path>` | Write to a file instead of stdout. |
| `--no-rescan` | Fail rather than scanning when no analysis file is found. |
| `--config <path>` | Use a different config file. |

Without `--ir`, Aburi looks for `aburi.ir.json` in the output directory, walking
up from the working directory to the workspace root, and scans only if it finds
nothing.

Several matches exit `2` and print the candidates so you can requalify. No match
exits `1`, and names how many files the analysis never read — the match may be in
one of them. When you asked about a file that the analysis explicitly skipped,
the exit code is `3` instead: there is no answer to give, and "no matches" would
claim more than the document can support.

```bash
aburi explain applyRefund
aburi explain src/billing/billing.service.ts
aburi explain applyRefund --output docs/applyRefund.md
```

---

## Programmatic use

`@aburi/cli` exports every command as a function, so tests and tooling can drive
it without spawning a process:

```ts
import { runCli, runInit, runScan, runDiff, runExplain } from "@aburi/cli"
import { parseFailOn, evaluateFailOn, EXIT } from "@aburi/cli"

const code = await runCli({ argv, stdout, stderr, env, cwd })
```

`runCli` never calls `process.exit` — it returns the code and leaves the
decision to you.

---

The behavioural contract behind this page, including the reasoning for each exit
code, is the [CLI spec](/design/cli-spec).
