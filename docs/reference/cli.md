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
| `1` | Runtime failure: an I/O error, an unexpected exception, or `explain` found no match. |
| `2` | Bad invocation: an unknown flag, a missing input file, a malformed `--fail-on`, an ambiguous `explain` target. |
| `3` | **Gate.** A `--fail-on` clause tripped, a plugin failed, or the scan read too little of the workspace to be trusted. |

CI gates on `3`.

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

Paths you give to `--config` resolve against the working directory. Paths
*inside* the config resolve against the workspace root, which need not be the
same directory. `aburi scan` warns you when the two differ.

`aburi diff` in ref mode settles all of this once, before it checks the base
revision out, and scans **both** revisions with the config it found. See
[`aburi diff`](#aburi-diff) below.

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
| `--output <path>` | Write somewhere other than `./aburi.json`. Directories in the path are created if they are missing; a path that cannot hold a file — an existing directory, or a file sitting on its parent path — exits 2 and names it. |
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

The scan lists the files it could not use on stderr, grouped by reason, and
points at the setting that governs each one. The run still passes. An
unparseable file tells you something about your source, not about the scan.

::: details When a scan does exit 3
- **Nothing was parsed at all.** An `ignore` pattern ate the tree, a
  `components[].roots` matched nothing, or no installed plugin claims any
  extension present. The output is still written.
- **Coverage fell below `minParsedFileRatio`**, if you set one.
- **A plugin threw** on a file, as opposed to declining it.
- **A filename cannot be written down.** The analysis has no representation for
  a path containing a backslash, and filenames differing in Unicode composition
  alone collapse to one. The scan names both kinds on stderr. Rename them, or
  exclude them with `ignore`, doubling the backslash in the glob pattern.
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
worktree, and scans it. Aburi scans the head from your working tree, and uses
its ref as a label in the report.

Both scans read the **head**'s config — the one discovery finds from your
working directory, or the one `--config` names there. The base revision's own
`aburi.json` is ignored, even when the base ref carries a different one, and a
head with no config at all scans the base by autodetect too. Otherwise editing
`ignore` would count as a change to every Symbol the setting covers, and
`aburi diff HEAD~1..HEAD --fail-on added` would fail a pull request that
touched no source.

**File mode** compares two `aburi.ir.json` files you already have. No git, no
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
`--fail-on`. A workspace that `aburi scan` refuses to call green cannot go green
here instead.

```bash
aburi diff main..HEAD
aburi diff main..HEAD --fail-on 'removed,dropped-toggled:to-dropped:>10'
aburi diff --base ir-main.json --head ir-branch.json --format md
```

### `--fail-on` grammar

Write comma-separated clauses. Each one may carry a `:>N` threshold. Without a
threshold, one occurrence trips the gate.

```
--fail-on 'removed,changed:>20,api-changed'
```

| Clause | Matches |
|---|---|
| `added` `removed` `changed` `moved` `moved+changed` `dropped-toggled` | Symbols with that status. |
| `dropped-toggled:to-dropped` `dropped-toggled:to-kept` | One direction of a boilerplate toggle. |
| `api-changed` `logic-changed` `syntax-changed` | Symbols whose change touched that axis. |

Evaluation stops at the first clause that fires, which keeps CI logs short.

::: warning Quote the value
`>` is a shell redirect. Write `--fail-on 'changed:>5'`, not
`--fail-on changed:>5`.
:::

Unknown tokens, comparators other than `>`, non-integer thresholds, and an empty
value all exit `2`. Aburi treats an empty gate as a mistake rather than as "no
gate", because it would turn a regression into a green pipeline.

---

## `aburi explain`

```
aburi explain <target> [--ir <path>] [--output <path>] [--no-rescan] [--config <path>]
```

Prints the full detail for one symbol. The target can be:

| Form | Example |
|---|---|
| A full symbol id | `ts:src/app/orders/actions.ts#submitOrder` |
| A file path | `src/app/orders/actions.ts`, giving you every symbol in that file |
| A name fragment | `submitOrder`, matched as a case-sensitive substring |

| Flag | Effect |
|---|---|
| `--ir <path>` | Read an existing analysis instead of scanning. |
| `--output <path>` | Write to a file instead of stdout. Directories in the path are created if they are missing; a path that cannot hold a file — an existing directory, or a file sitting on its parent path — exits 2 and names it. |
| `--no-rescan` | Fail rather than scanning when no analysis file is found. |
| `--config <path>` | Use a different config file. |

Without `--ir`, Aburi looks for `aburi.ir.json` in the output directory, walking
up from the working directory to the workspace root. It scans when it finds
nothing.

Several matches exit `2` and print the candidates so you can requalify. No match
exits `1`, and names how many files the analysis never read, since your match may
sit in one of them. Ask about a file the analysis skipped and you get `3`
instead. There is no answer to give, and "no matches" would claim more than the
document can support.

```bash
aburi explain submitOrder
aburi explain src/app/orders/actions.ts
aburi explain submitOrder --output docs/submitOrder.md
```

---

## Programmatic use

`@aburi/cli` exports every command as a function, so your tests and tooling can
drive it without spawning a process:

```ts
import { runCli, runInit, runScan, runDiff, runExplain } from "@aburi/cli"
import { parseFailOn, evaluateFailOn, EXIT } from "@aburi/cli"

const code = await runCli({ argv, stdout, stderr, env, cwd })
```

`runCli` returns the code rather than calling `process.exit`, leaving the
decision to you.

---

The [CLI spec](../design/cli-spec.md) holds the behavioural contract behind this
page, including the reasoning for each exit code.
