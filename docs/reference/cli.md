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

`--log-level debug|info|warn|error` works on every command too, before it or after it. It
sets how much of the per-file log
(`warn: Skipped src/legacy.ts: parse reported a non-recoverable error at 12:4 — …`) reaches
stderr, from `aburi scan` and from the scans `aburi diff` and `aburi explain` run. The default,
`warn`, shows the `warn:` lines; `info` adds a line for each file `aburi scan` removes, `debug`
a line for every file extracted as well, and `error` shows none of it. Its lines
name no scan; `aburi diff` writes the base's before the head's. The `⚠` warnings are printed
whatever the level. Any other value exits `2`.

An option that takes a value takes one. Given twice (`--config a.json --config b.json`), the
command exits `2` and names it rather than keep one and drop the other without a word.
`--ignore` and `--fail-on` add up instead. A flag, which takes no value, can be repeated, and of
a `--x` / `--no-x` pair the last one written applies. An option that takes a path exits `2` on an
empty one (`--config ""`, `--output-dir ""`) rather than read it as the option left out or as the
working directory.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, no gate tripped. |
| `1` | Runtime failure: an I/O error (a write the disk refused says which command and which output; a file or directory the scan may not read is named), an unexpected exception, or `explain` found no match. |
| `2` | Bad invocation: an unknown flag, an option that takes one value given twice, an empty path, a missing input file, a malformed `--fail-on`, an ambiguous `explain` target, a ref `diff` cannot resolve, an output path a file already stands on. |
| `3` | **Gate.** A `--fail-on` clause tripped, a plugin failed, or the scan read too little of the workspace to be trusted. |

CI gates on `3`.

## Environment variables

| Variable | Effect |
|---|---|
| `ABURI_CONFIG` | Config file path. The `--config` flag wins over it. |
| `ABURI_LOG_LEVEL` | The same as `--log-level`, which wins over it. A value other than the four levels is ignored. |
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

`aburi diff` in ref mode settles *which config file to read* once, before it
checks the base revision out, and scans **both** revisions with it. The workspace
root stays per-scan. See [`aburi diff`](#aburi-diff) below.

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
| `--no-respect-gitignore` | Include git-ignored files when taking the language census, and git-ignored `project.json` files when finding nx projects. A git-ignored directory Aburi may not list then stops `init`. |

```bash
aburi init
aburi init --with-suggestions --output config/aburi.jsonc
```

---

## `aburi scan`

```
aburi scan [--output-dir <dir>] [--format json|md|both] [--no-md|--no-json]
           [--ignore <glob>]... [--respect-gitignore | --no-respect-gitignore]
           [--strict | --no-strict | --discover]
           [--compact] [--no-timestamp] [--config <path>]
```

Analyses the workspace and writes `aburi.ir.json`, `workspace.md`, and
`components/*.md`. After writing, it removes what an earlier run wrote there that this one
does not: the output a `--format` leaves out, and the page of a component that has since been
renamed or removed. `aburi.ir.json` and `workspace.md` are recognised by name alone, so a file
of yours under either name goes too. A page in `components/` is recognised by its name and its
first line both: it is Aburi's only when it is named after a component id and its first line is
that component's `# Component: <id>` heading, so your own files there stay. A scan that fails
before it has written everything removes nothing. `--log-level info` prints a line for each
file removed.

| Flag | Effect |
|---|---|
| `--output-dir <dir>` | Where to write. Falls back to `output.dir` in the config, then `out`. Created if missing; a path a file already stands on exits `2` and names it. |
| `--format <fmt>` | `json`, `md`, or `both` (default). Without `--format`, `--no-md` and `--no-json` each drop one output. With it, a `--no-*` that would drop an output `--format` includes exits `2`, and so does dropping both. |
| `--ignore <glob>` | An extra exclusion for this run. Repeatable. |
| `--respect-gitignore` / `--no-respect-gitignore` | Override the config for this run. |
| `--strict` / `--no-strict` | Override `strict` for this run. Strict stops at a value a plugin emits without its manifest declaring it; off, the scan keeps it and records it in `aburi-vocab-discovered.json`, which a strict scan that completes removes again. |
| `--discover` | The same as `--no-strict`. With `--strict`, exits `2`. |
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
- **A plugin emitted a value its manifest does not declare**, in a strict run
  (the default). No output is written. Declare the value, or run with
  `--discover` to keep it and see the full list.
- **A filename cannot be written down.** The analysis has no representation for
  a path containing a backslash, or for a top-level name that opens with one
  ASCII letter and a colon (`a:notes.ts`, `d:data/`), which reads as a Windows
  drive. Filenames differing in Unicode composition alone collapse to one. The
  scan names each kind on stderr and still analyses the rest. Rename them, or
  exclude them with `ignore`, doubling the backslash in the glob pattern.
- **A workspace package sits in such a directory.** It cannot be a component,
  so the scan names it on stderr, even when it holds no source file. Rename the
  directory. `aburi init` names it too, and still writes the config.
:::

Every command that scans reports the same way. `aburi diff` runs two scans and
labels each one's `⚠` lines: the base by its ref, the head as `head (working tree)`.

---

## `aburi diff`

```
aburi diff <base>..<head>       [flags]
aburi diff --base <a.json> --head <b.json>  [flags]
```

Compares two revisions and writes `diff.json` and `diff.md` (and `diff.full.md` when
`--max-bytes` shortened `diff.md`).

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

The paths *inside* that config still resolve per scan: `ignore` and
`components[].roots` are matched against each revision's own workspace root, so
for the base that is the temporary worktree. Plugin refs are the
exception. A relative one (`./plugins/x.mjs`) belongs to the plugin set, which
[comes from the head](https://aburi.kage1020.com/extend/architecture) along with
`node_modules`, so it is loaded from your working tree for both scans. An
absolute one (`/opt/plugins/x.mjs`) names the same file for both scans,
whichever workspace root each has.

**File mode** compares two `aburi.ir.json` files you already have. No git, no
scanning.

| Flag | Effect |
|---|---|
| `<base>..<head>` | Ref-spec dispatch. A ref git cannot resolve exits `2`, and the message says whether that is because the directory is not a repository, the repository has no commits, or the name is unknown. |
| `--base <path>` `--head <path>` | File-mode dispatch. Mutually exclusive with the ref-spec. |
| `--fail-on <spec>` | The CI gate. Repeatable. See below. |
| `--output-dir <dir>` | Where to write. Falls back to `output.dir`, then `out`. Created if missing; a path a file already stands on exits `2` and names it. Any `diff.json`, `diff.md` or `diff.full.md` already there is removed before the comparison starts, so a run that fails leaves no earlier report to be mistaken for its own. |
| `--format <fmt>` | `json`, `md`, or `both`. |
| `--compact` | JSON without indentation. |
| `--max-bytes <n>` | Cap `diff.md` at n bytes. See below. |
| `--config <path>` | Use a different config file. |

In ref mode, a scan that did not finish cleanly exits `3` even with no
`--fail-on`. A workspace that `aburi scan` refuses to call green cannot go green
here instead.

```bash
aburi diff main..HEAD
aburi diff main..HEAD --fail-on 'removed,dropped-toggled:to-dropped:>10'
aburi diff --base ir-main.json --head ir-branch.json --format md
```

### `--max-bytes`

A GitHub comment body cannot exceed 65536 bytes, and the report is written to be pasted into
one. A minimal symbol takes about 210 bytes of it, so a branch adding a few hundred symbols
produces a report GitHub refuses outright — the review that needed it most gets nothing.

`--max-bytes` caps `diff.md`. It is met least important first, not by cutting the text mid-fence.
Sections are kept most important first, each at its smallest — a section of whole symbols as one
name-and-location line per symbol — and a section is dropped only when it cannot fit even beside
every more important one cut that far. The name lists then get their full entries back, from the
top, as far as the budget allows. The report says at the top which sections are short and which
went:

```
> ⚠ **2 sections were omitted** to keep this report within 65507 bytes: 💧 Dropped changes, 🎨 Syntax-only changes. The full report, the same diff without a size cap, is `diff.full.md` beside `diff.md`.
```

The sections that survive are always the important ones: API changes go last, Syntax-only first.
`diff.json` is never capped, so nothing is lost from the artefact you can query. When the cap
changed anything, the uncapped report is written beside the capped one as `diff.full.md`, which
is what the note points at. Like `diff.json` and `diff.md`, one left from an earlier run is
removed before the comparison starts (see `--output-dir` above).

The CLI has no cap unless you pass one: omitting `--max-bytes` writes the whole document.
`--max-bytes 0` is not the way to say that — it exits `2`, along with every other value that is
not a positive integer.

The [GitHub Action](https://aburi.kage1020.com/guide/ci-integration) passes `65507` for you —
65536 less the hidden marker it prepends — so you only reach for this flag to choose a smaller
comment. There, `max-bytes: 0` *is* the spelling for no cap: the action input takes it and passes
no flag at all.

```bash
aburi diff main..HEAD --max-bytes 65507
```

### `--fail-on` grammar

Write comma-separated clauses. Each one may carry a `:>N` threshold. Without a
threshold, one occurrence trips the gate.

```
--fail-on 'removed,changed:>20,api-changed'
```

Repeating `--fail-on` adds its clauses after the earlier ones, so
`--fail-on removed --fail-on 'changed:>20'` gates exactly as
`--fail-on 'removed,changed:>20'` does.

| Clause | Matches |
|---|---|
| `added` `removed` `changed` `moved` `moved+changed` `dropped-toggled` | Symbols with that status. |
| `dropped-toggled:to-dropped` `dropped-toggled:to-kept` | One direction of a boilerplate toggle. |
| `api-changed` `logic-changed` `syntax-changed` `confidence-changed` | Symbols whose change touched that axis. |

Evaluation stops at the first clause that fires, which keeps CI logs short.

::: warning Quote the value
`>` is a shell redirect. Write `--fail-on 'changed:>5'`, not
`--fail-on changed:>5`.
:::

Unknown tokens, comparators other than `>`, non-integer thresholds, an empty
clause (`added,`, `added,,removed`), and an empty value all exit `2`, and with
`--fail-on` repeated the message quotes the occurrence at fault. Aburi
treats an empty gate as a mistake rather than as "no gate", because it would
turn a regression into a green pipeline.

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
document can support. A file no analysis can name, such as `a:notes.ts`, also
gets `3`, with the name to change.

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
decision to you. A CLI entry point should assign `process.exitCode`, as the
`aburi` bin does: `process.exit()` can truncate output still being written to a
pipe (`aburi scan … | head`).

---

The [CLI spec](../design/cli-spec.md) holds the behavioural contract behind this
page, including the reasoning for each exit code.
