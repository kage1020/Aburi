# CLI Specification

Complete signatures, flags, arguments, exit codes, and stdout/stderr conventions for the `aburi` command.

References:
- [`config.md`](./config.md) — config file resolution and CLI-flag overrides
- [`diff-algorithm.md`](./diff-algorithm.md) — how inputs are supplied to `aburi diff`
- [`markdown-projection.md`](./markdown-projection.md) — output Markdown conventions
- [`extension-vocab.md`](./extension-vocab.md) — what `aburi vocab` queries

---

## 1. Purpose

The single entry point to Aburi. Every capability is exposed through a subcommand.

Design principles:
- **Easy to automate in CI**: stable exit codes, JSON output available, non-interactive by default
- **Friendly to humans**: proper help, colored output, progress indication
- **Follow Unix conventions**: stdout/stderr separation, long/short options, env vars

## 2. Command Overview

```
aburi init                                  # generate config file
aburi scan                                  # generate IR
aburi diff <base>..<head>                   # compute diff
aburi explain <id-or-pattern>               # show a single symbol/file
aburi vocab list|effects|extkinds|plugins|who-owns   # query extension vocabulary
aburi --version / aburi -v                  # version
aburi --help / aburi -h                     # global help
```

## 3. Common Options

Available on every command, unless the row says otherwise:

| Option | Short | Meaning |
|---|---|---|
| `--cwd <path>` | — | (planned) Change the working directory (origin for config resolution) |
| `--config <path>` | — | Explicitly specify the config file location (§13). Taken by `scan`, `diff` and `explain`, after the command; `aburi init` has none |
| `--log-level <level>` | — | `debug` / `info` / `warn` / `error`: the lowest level of the run's `Logger` lines (§5.6) that reach stderr. Written before the command or after it, and listed in every command's `--help` among the global options |
| `--no-color` | — | (planned) Disable colored output |
| `--help` | `-h` | Show command-specific help |

The log level is resolved in this order, the first one set winning:

```
1. --log-level CLI flag
2. ABURI_LOG_LEVEL env
3. warn
```

A `--log-level` value other than the four levels exits `2`. An `ABURI_LOG_LEVEL` value other than
them is ignored, as if the variable were unset.

Top-level only:
| Option | Short | Meaning |
|---|---|---|
| `--version` | `-v` | Show version |

Of the options the CLI declares, the global `--log-level` and those of `init`, `scan`, `diff` and
`explain`, one that takes a value takes one. Given
twice — `--config a.json --config b.json`, or `--format json --format=md` — the command exits 2
before it reads or writes anything, naming the option and both values (`--config is given more than
once ("a.json", then "b.json"): pass one`), the same value twice included, and a second value the
option would refuse on its own as well (`--format json --format bogus`). When the first value is
itself invalid, its own error is the one reported, at the same exit 2, since it is read before the
second occurrence is reached. Keeping the last one would drop a setting the caller wrote without a
word, as a repeated config key would ([`config.md`](./config.md) C19). Two options accumulate
instead, each occurrence adding to the ones before it: `--ignore` (§5.2) and `--fail-on` (§6.7). A
flag carries no value to lose and may be repeated, and of a `--x` / `--no-x` pair the one written
last applies.

Of those options, one that takes a path refuses an empty value, at exit 2 before anything is read or
written (`error: option '--config <path>' argument '' is invalid. a path must not be empty`). Taken
as written, `--config ""` would fall back to `ABURI_CONFIG` or a discovered config, and
`--output-dir ""` would write into the working directory and remove the report `diff` finds there: a
value the caller wrote, dropped without a word as a repeated one would be.

## 4. `aburi init`

Generates `aburi.json` from autodetect results.

### 4.1 Signature

```
aburi init [--output <path>] [--force] [--with-suggestions]
           [--respect-gitignore|--no-respect-gitignore]
```

### 4.2 Options

| Option | Meaning |
|---|---|
| `--output <path>` | Output destination (default: `./aburi.json`) |
| `--force` | Overwrite an existing file |
| `--with-suggestions` | Include enable candidates for plugins matching detected frameworks as JSONC comments |
| `--respect-gitignore` / `--no-respect-gitignore` | Whether the language census honours `.gitignore` (default: honour). No config exists yet to override, so this is also the only way past a `.gitignore` that cannot be read |

### 4.3 Behavior

1. Detect the workspace root ([`component-detect.md`](./component-detect.md) §2.1)
2. Run each detector (§3)
3. Convert results into Component candidates
4. Generate JSON and write it to `--output`, creating the directories that path names
5. Print a summary to stdout

### 4.4 When the File Already Exists

- Without `--force` → exit with an error (exit 2): `Use --force or specify another path`
- With `--force` → overwrite; warning goes to stderr
- When a **directory** stands at the path, neither applies: nothing overwrites one, so the answer
  names it and asks for a file path instead — the same sentence the write itself gives (§4.5).
  Offering `--force` here would be advice whose only destination is that refusal

### 4.5 Exit Codes

| code | Meaning |
|---|---|
| 0 | Generation succeeded |
| 1 | Autodetect failure (permissions, etc.) |
| 2 | Existing file present without `--force`, an `--output` that cannot hold a file — it names a directory, or a file stands on its parent path — or `--output` given twice or empty (§3) |

### 4.6 stdout Example

```
✓ Detected 3 components (pnpm workspaces)
✓ Detected 2 languages: ts, tsx
✓ Detected 1 framework: nestjs (in apps/billing)
✓ Wrote ./aburi.json

Next steps:
  1. Install lang plugin: pnpm add -D @aburi/lang-typescript
  2. Install framework plugin (optional): pnpm add -D @aburi/framework-nestjs
  3. Install effect plugins (optional): pnpm add -D @aburi/effects-prisma
  4. Enable them in aburi.json (uncomment the suggested entries)
  5. Run: aburi scan
```

With `--with-suggestions`, install/enable lines for official plugins matching the detected frameworks are included in `aburi.json` **as commented-out entries**. Uncommenting them enables the plugins immediately:

```jsonc
{
  "$schema": "https://aburi.kage1020.com/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  // Detected: nestjs. Install with: pnpm add -D @aburi/framework-nestjs
  // "frameworks": ["framework-nestjs"],
  "components": [/* ... */]
}
```

## 5. `aburi scan`

Scans the workspace and generates the IR.

### 5.1 Signature

```
aburi scan [--output-dir <path>] [--format <json|md|both>] [--no-md|--no-json]
           [--strict|--no-strict] [--discover]
           [--quiet] [--compact]
           [--concurrency <n>]
           [--respect-gitignore|--no-respect-gitignore]
           [--ignore <glob>]
```

### 5.2 Options

| Option | Meaning |
|---|---|
| `--output-dir <path>` | Output directory (default: `config.output.dir`, then `out`). Resolved against the working directory, as the config value is |
| `--format <json\|md\|both>` | Output format (default: `both`). What the format leaves out is removed from the output directory, not left from an earlier run (§5.3) |
| `--no-md` | Drops the Markdown output. Alone, equivalent to `--format json`. With `--no-json`, or with any `--format` that would have written Markdown (`md`, `both`), exit 2 |
| `--no-json` | Drops the IR JSON output. Alone, equivalent to `--format md`. With `--no-md`, or with any `--format` that would have written JSON (`json`, `both`), exit 2 |
| `--strict` / `--no-strict` | Override `config.strict` ([`config.md`](./config.md) §10). Strict stops at the first undeclared value with exit 3; off, the scan keeps every such value and writes `aburi-vocab-discovered.json` into the output directory ([`extension-vocab.md`](./extension-vocab.md) §11.5.1), an empty list included. A strict scan that completes removes a record an earlier run left, so no completed `scan` leaves one naming values that are declared now. `aburi diff` has neither flag: its scans take strictness from `config.strict` alone (CL8b) |
| `--discover` | The same as `--no-strict`, named for the workflow it serves. With `--strict`, exit 2 |
| `--quiet` | Suppress progress output; stdout carries the final summary only |
| `--compact` | Compact the JSON to a single line |
| `--concurrency <n>` | Parser concurrency (default: CPU - 1) |
| `--respect-gitignore` / `--no-respect-gitignore` | Override `config.respectGitignore`. A pair rather than the negative alone, so that a run which typed neither is distinguishable from one that asked for the default — an override the caller did not spell must leave the config alone |
| `--ignore <glob>` | Append to `config.ignore[]` (repeatable) |

### 5.3 Behavior

1. Resolve the config
2. Load plugins and build the registry
3. Walk the workspace, parsing each file in parallel
4. Extraction pipeline: drop list → tag propagation → effect classification → fingerprint → Symbol finalization
5. Write `<output-dir>/aburi.ir.json` + `<output-dir>/workspace.md` + `<output-dir>/components/*.md` — the IR first, because every page is derived from it: a page that fails to render leaves the IR on disk rather than taking it down too, and an IR the serializer refuses leaves no pages beside it. A page that fails to render is a bug in Aburi (exit `1`, §9) and names the page; the scan's incidents are reported before the command ends, as they are after a clean run
   - **What this run does not write is removed**, once everything it writes is written, so the directory describes this run alone and not a mix of runs: the `aburi.ir.json` a `--format md` run leaves out, which `aburi explain --no-rescan` would otherwise answer from (§7.3); the `workspace.md` and every component page a `--format json` run leaves out; and, under any format, the page of a Component this IR does not hold — one renamed or removed since. A path that cannot be removed is refused like one that cannot be written, and so is a `components/` that cannot be listed or a page whose first line cannot be read. The message names the step that failed — `could not remove <artefact> at <path>`, `could not list the components directory at <path>`, `could not read the Markdown for component "<id>" at <path>` — and is exit `2` for a directory standing where a removed file would be, exit `1` for any other refusal. Each file `aburi scan` removes, the discovered-vocabulary record (§5.2) included, is logged as one `info:` line, `Removed <artefact> at <path>`, so the default level, `warn`, shows none of them (§5.6)
   - **Only Aburi's own files are removed.** The output directory, and `components/` in particular, may hold files of the caller's — a README, notes, Markdown a person wrote, a subdirectory — and those stay, as `components/` itself does. `aburi.ir.json` and `workspace.md` are recognised by name alone, as `aburi diff` recognises its report (§6.4), so a file of the caller's under either name is removed with them. A component page is recognised by name and content both, since its name is any Component id: a regular file directly in `components/`, named `<id>.md` for a valid Component id ([`ir-schema.md`](./ir-schema.md) §4), that opens with the heading the page opens with, `# Component: <id>` ([`markdown-projection.md`](./markdown-projection.md) §5.1), and a line ending, LF or CRLF alike. A file whose name is no Component id, or whose first line is anything else — another heading, or that heading with more on its line — is not one. Reading that line is part of removing the page: the scan reads only as many bytes as the heading and a CRLF take, reading again until it has them or the file ends, and a failure to read is refused the same way
   - **A run that stops before this step removes nothing, and a run writes before it removes.** A plugin that fails to load, a strict scan's undeclared value (exit `3`) or a file the scan could not read (exit `1`) leaves the earlier run's files as they were: together they still describe the last scan that completed, as the discovered-vocabulary record is removed only by a strict scan that completes (§5.2). So does a write that fails or a page that fails to render, since every removal follows the last write: a `--format md` run that cannot write `workspace.md` leaves the earlier `aburi.ir.json` where it was. The removals go one file at a time, so a run that fails at one of them has already removed those before it; nothing the run should have produced is lost, and the next run that completes removes the rest. `aburi diff` removes its earlier report before it starts instead (§6.4): its exit `3` is both the gate's and a plugin failure's, and a caller that reads the report after either would take an earlier one for its own
   - These removals are `aburi scan`'s, whatever the format: a scan run for another command (`runScan` called with that `command`) removes nothing. The scan `aburi explain` runs (§7.4) writes the IR alone, and the scans `aburi diff` runs write into directories of their own
6. Print a one-line final summary to stdout

### 5.4 Exit Codes

| code | Meaning |
|---|---|
| 0 | Extraction succeeded |
| 1 | Extraction error — a file or directory the scan could not read. A source file that stopped being one by the time the scan reached it is skipped rather than fatal, and a directory gone by then is passed over — a concurrent build can do that, and a rerun is the fix — but a permission, descriptor or IO failure still ends the run, because absorbing it would let the same commit produce a different Document on a different day. Three calls read the tree — the walk's listing of each directory, discovery's `stat` and the read before extraction — and one predicate decides all three: which of them a failure lands on is an accident of timing and must not change the outcome. The one directory a failed listing does not end the run for is one `.gitignore` excludes, while it is respected: none of its files can reach the Document (drop-list.md §3). A file the language plugin *could* read and refused to parse is not this: it is withdrawn and the code stays `0` (lang-plugin.md §7.1) — unless it took every file the scan found, or crossed `minParsedFileRatio`, which is a coverage gate rather than a read failure (§5.7) |
| 2 | Config error (schema violation, resolution failure, a `--config` path that names nothing), format flags that contradict each other or leave nothing to write (§5.2), an option that takes one value given twice or a path given empty (§3), or an `--output-dir` that cannot hold the outputs because a file stands where the directory would go. A config that exists and cannot be read is `1` — see §9; so is an output directory the process may not write to, since no edit to what was typed changes that |
| 3 | Gate — the run finished and produced something the caller must not accept silently: a plugin load failure or manifest violation, a file withdrawn during extraction, undeclared vocab detected in strict mode, a scan whose coverage collapsed (§5.7), or a file or a workspace package the Document has no way to name (§5.8). Named by outcome rather than by cause because an empty scan caused by an `ignore` glob is not a plugin fault |

### 5.5 stdout Example

```
✓ Loaded 3 plugins (1 lang, 1 framework, 1 effects)
✓ Parsed 1234 files in 12.4s
✓ Extracted 542 kept · 87 dropped symbols
✓ Wrote out/aburi.ir.json + out/workspace.md + 3 component files
```

The kept/dropped line is followed by the call-resolution census in the same
format `aburi diff` uses (§6.6):
```
542 kept · 87 dropped · 1234 files
calls 1310 · resolved 1203 · unresolved 107 (external 30 · dynamic 60 · ambiguous 3 · no-match 14)
```

With `--quiet`, only the final line:
```
542 kept · 87 dropped · 3 components
```

### 5.6 stderr (Warnings)

```
⚠ Component "api" lists "framework-nestjs" in frameworks, which names a plugin, not a framework; the IR carries it as written. Write "nestjs".
⚠ 3 file(s) had recoverable parse errors.
    src/widget.tsx: 4 errors, first at 31:12 — syntax error
    src/panel.tsx: 12:4 — syntax error
    src/table.tsx: 88:9 — syntax error
⚠ Config /repo/apps/web/aburi.json sits below the workspace root /repo. …
⚠ 1 file(s) could not be parsed and were left out of the IR.
⚠ 5 file(s) contributed no Symbols: over-size=3, parse-failed=1, extraction-failed=1
⚠ over-size (3) — larger than maxFileSizeBytes. Raise the budget, or leave them out with ignore.
    vendor/bundle.js: 2100000 > 1048576
    vendor/legacy.js: 1400000 > 1048576
    public/data.js: 1100000 > 1048576
⚠ parse-failed (1) — the language plugin refused the source. Deterministic: fix the file, or the plugin.
    src/broken.ts: parse reported a non-recoverable error at 12:4 — unterminated string
⚠ extraction-failed (1) — a plugin threw while extracting, or its Symbols could not enter the Document. This is the reason the run does not exit clean.
    src/route.ts: qualified name "{ GET, POST }" contains the non-identifier segment "{ GET, POST }"
```

The `frameworks` line comes ahead of the parse lines because the artifact cannot always
reproduce it: a first-party plugin that is not loaded is absent from `plugins[]`, so nothing in
the IR says `framework-next` was a plugin's name ([config.md](./config.md) §6).

The parse-error line names its files, which nothing else does: mostly they are in the IR, so
`stats.skippedFiles[]` does not hold them and no per-file log line is written for them either.
One kind is in that list all the same, under a different reason: a file abandoned on its
`parseTimeoutMs` budget is named on both lines, and its skip entry carries the clock rather than
the errors, so the line above is still the only place those are named. A file withdrawn for a
duplicate Symbol id is named on both lines for the same reason: its extraction ran to a result,
so the parse errors it carries are real observations about the file and are kept. A file a
plugin threw on is the one case that is not — the result never materialized, so it has no parse
errors to carry and does not reach this line.

Each file is given the first error reported for it, and a count when there was more than one;
an embedder wanting all of them reads `ScanResult.parseErrors`, which this line summarizes
rather than reprints. The listing is uncapped, for the reason §5.8's is: a `…and N more` tail
over the run's only account of something is the loss rather than a summary of it. The listings
that *are* capped are the ones the artifact records in full — the skip census below, which
`stats.skippedFiles[]` holds entire.

The two parse lines are counted apart rather than summed. The first counts files whose errors the
plugin called recoverable; the second counts files the parse refused. A withdrawn file's errors
appear on `ScanResult.parseErrors` all the same — they are the account of why it went — so summing
the two would call them recoverable, which is the opposite of what the plugin said.

The split is by what the plugin said, not by what reached the IR: a file abandoned on its
`parseTimeoutMs` budget is counted on the first line and is not in the document. That is
deliberate. Its errors really are all recoverable — a refusal is decided before the first deadline
reading — and lang-plugin.md §7.1.2 keeps them precisely so a slow parse of broken input does not
send the reader to raise a budget that was never the problem.

The first line was previously the only account of an unparseable file's errors, so a withdrawn
file's skip detail carries one of them: the refusal when there is one, otherwise the first
recoverable error with its position.

The "contributed no Symbols" line is a census; under it each reason present gets a line of its
own, saying what to do about it, and then its files with the detail `@aburi/core` recorded for
each. The reasons want different responses — `over-size` points at `maxFileSizeBytes`,
`parse-timeout` at `parseTimeoutMs` and a re-run, `unreadable` at a re-run alone — a tree that
changed while the scan ran is the only thing that produces it, since every other read failure
ends the run — `unroutable` at a bug in the plugin set or at a rename, `parse-failed` at the source,
`extraction-failed` at the plugin — and one neutral line said none of it. The re-run /
fix-something split is the one `SkippedFile.reason` draws in the IR schema.

Reasons appear in a fixed order — `over-size`, `unreadable`, `unroutable`, `parse-failed`,
`parse-timeout`, `extraction-failed`, the order the IR schema's `reason` enum declares — in the
census and in the groups alike, so the groups
arrive in the order the census named them and neither depends on where in the workspace the
losses happened to sit.

The listing is capped at ten files **per reason**, with a "…and N more" tail. Per reason rather
than across the whole listing because one shared budget belongs to whichever reason lost the
most files, and that is not the reason a reader most needs named: a hundred over-size files
would push the one file withdrawn during extraction — the only reason that moves the exit code to `3`
(§5.4) — inside the tail, leaving a non-zero status with nothing on screen to account for it.
Every other reason leaves the code at `0`.

`extraction-failed` is listed by that rule like any other reason rather than by one of its own.
Its files were listed twice while it had its own clause: the message the withdrawal was made
with is written to both `skipped[].detail` and `extractionFailures[].message` at a single site in the
scan. `ScanReport.extractionFailures` is unchanged — it still carries the error's `code`, and it
is still what decides the exit code and what the `diff` fault clause counts.

Where the lines come from is part of the contract. `runScan` writes them to a sink its caller
supplies, so all three commands that scan report them, rather than one command's wrapper
printing them while the other two discard the report. A caller that supplies no sink gets no
incident report.

That is not the same as silence. The run's `Logger` is a separate channel — per file rather
than per run, governed by `--log-level` (§3) and `ABURI_LOG_LEVEL` (§11), and still writing to
`process.stderr` whatever streams the caller injected. The level is the command's rather than
one scan's: `diff` hands it to both of its scans and `explain` to the one it rescans with, so no
scan logs at a level the reader did not choose. An embedder passes it as `logLevel` to
`runScan`, `runDiff` or `runExplain`, and gets `warn` without one. An embedded scan with no sink
is quiet, not mute, and routing that channel to the caller is a known gap rather than something
this contract covers.
It is also why the files above are listed by the CLI itself rather than left to that channel:
at `ABURI_LOG_LEVEL=error` the per-file lines are gone, and for `over-size`, `unroutable` and an
`unreadable` raised during discovery there is no `Logger` line to lose — those three are decided
before extraction and are not logged at all, so the report is their only account.

The reverse is a known gap: some things have only a `Logger` line, and Aburi's own packages write
that channel at `warn` and `debug` only, apart from the `info:` line `aburi scan` writes for each
file it removes (§5.3), so a reader who asks for `error` loses them. They are a
language server that did not shut down
(`[aburi:lsp] shutting down the <language> server failed (…); it may still be running`), why LSP
was disabled for a language mid-run, and which files' `didOpen` failed — the `⚠` lines name the
language, or count the files that fell back, and give no cause. `diff` adds the files past the
listing's cap. A skipped file past a reason's first ten is named only in its scan's IR, which
`diff` deletes before it exits, so unless the comparison names it — in `notCompared[]` when both
scans skipped it, on an `unknown` entry when the other scan has Symbols from it — that scan's
`warn: Skipped …` line is its only account, and for a reason decided before extraction there is
none.

§5.8's paragraph, the unreleased-tree line and the parse-error listing sit directly under the
coverage line and above this census — ahead of everything that is recoverable from the artifact,
because they are the sections that are not. A sink that closes takes whatever is last, so what
exists nowhere else goes first.

A command that runs more than one scan labels them, after the glyph, with the scan the line
came from:

```
⚠ base ref "main": 3 file(s) had recoverable parse errors.
```

`aburi diff` also folds the two scans' recoverable-error counts into one line of its own, and
names the files under it with the side on each entry — the two scans read different trees, so a
path doubtful on one side and clean on the other is the likeliest cause of the added / removed
movement that line warns about:

```
⚠ Files with recoverable parse errors (base 1, head 2) reached the IR rather than stats.skippedFiles, …
    base src/panel.tsx: 12:4 — syntax error
    head src/panel.tsx: 12:4 — syntax error
    head src/widget.tsx: 4 errors, first at 31:12 — syntax error
```

`⚠` starts every line that stands on its own. The only lines without it are the indented
per-file listing and its `…and N more` tail, which belong to the line above them and are
attributed by it.

The warnings precede the stdout summary in a merged view (a terminal, `2>&1`, an Actions log),
where before the reporting moved they followed it. Deliberate: the last thing on screen is then
the kept / dropped line and the artifact paths, which is the part a reader acts on.

### 5.7 Coverage

A scan that read almost none of the workspace exits `3`. The shape it would otherwise produce is
the dangerous one *because* it is a success: an IR with no Symbols diffs against another one as
`+0 -0 ~0`, so every `--fail-on` gate downstream passes, and the run that lost the workspace is
the one that looks healthiest.

**`parsedFiles === 0` gates unconditionally.** Two lines, because the first move differs:

```
⚠ No file was discovered to scan. The IR is empty and will diff clean against any other empty IR. Check ignore and .gitignore, components[].roots, and whether a loaded language plugin claims any extension in this workspace.
⚠ 1200 file(s) discovered, 0 parsed — 1200 as parse-failed. The IR is empty and will diff clean against any other empty IR.
```

Nothing discovered is a question about the config; nothing parsed is a question about whatever
withdrew the files, so the second names the reason that took the most of them — ties broken by the
reason enum's order, so the line is a function of the losses rather than of the walk. The line
goes through the same sink as the rest of §5.6, above the census that is its evidence, so a
two-scan `diff` labels it by side.

**Anything above zero is the workspace's own call**, through `minParsedFileRatio`
([`config.md`](./config.md)). Absent by default: where the line sits between "lost some files"
and "lost the workspace" depends on the repository, and a default would red a build for a
judgement nobody made. Set it and the scan gates when `parsedFiles / totalFiles` falls below it —
`<`, not `<=`, the same reading `--fail-on`'s thresholds use.

The floor counts **every** skip reason. `parse-timeout` is the reason whose loss varies by
machine, and so the one a floor is usually reached for, but it is not the only one that hides a
blind spot: which reason produced the loss decides the fix, not whether coverage collapsed. Each
one is named per file directly below (§5.6) either way.

`keptSymbols` plays no part. A file that parses cleanly and declares nothing is counted as
parsed, which is correct — a repository of configuration and tests is not a failed scan — so a
Symbol count says something about the code where `parsedFiles` says what this policy is about.

Neither gate withholds anything the run would otherwise have written, as neither does for an
extraction fault: a reviewer gets whatever `--format` asked for and a non-zero code rather than
the artifact and a green light. `--format md` writes no IR either way, so "the IR is written" is
a claim about what gating does not change rather than about what a gated run always produces.

### 5.8 Files the Document cannot name

Three things put a file beyond what a Document can name, and all three end the same way: the
file is not skippable — a skip entry is a path plus a reason, and it is the path that is missing —
and not countable either, because invariant #21 holds `stats.skippedFiles`'s length to
`totalFiles - parsedFiles`.

**The first cause: a name a path cannot spell.** A filename may contain a backslash on any POSIX
filesystem, and a Document path may not: `/` is its only separator, so there is no way to write
such a name down that a reader will not take for a directory boundary (ir-schema.md §14
invariant #10).

So it leaves `totalFiles` the way a file no plugin claims does, and the run says so itself:

```
⚠ 3 file(s) were left out of the IR and out of its counts, under 2 name(s) with no spelling here: "/" is the only separator a Document path has, so a name holding a backslash cannot be written down at all. Rename each one below. To leave one out with ignore instead, write its backslash twice — a glob pattern spends a single one as an escape, so the name as printed does not match itself.
    odd\name.ts
    src/v\1 — a directory, and the 2 file(s) under it
```

**It exits `3`.** Every other loss leaves a trace in the artifact that a later reader can find the
file by; this one leaves none, so the exit code and that paragraph are the whole record. A scan
that dropped source and went green would be reporting a clean run over a workspace it did not
describe.

**One line per name that has to change, not per file, and no cap.** A backslash in a directory
name disqualifies every file beneath it and none of those filenames is at fault, which is the
same rule the `unroutable` detail follows for `:` and `#` — so the line names the path up to and
including the offending segment, and the file count under it. That also makes the listing the
length of the work rather than of the damage, which is what lets it go uncapped: every other
listing in §5.6 caps at ten because `stats.skippedFiles[]` holds the rest, and here nothing does.

**The `ignore` spelling is not the printed one.** Patterns reach picomatch, which spends a lone
backslash as an escape:

| pattern | excludes `src/v\1/util.ts` |
|---|---|
| `src/v\1/**` | no |
| `src/v\\1/**` | yes |
| `src/v?1/**` | yes |

The first row is the name exactly as the paragraph above prints it, which is why the advice says
to double the character rather than leaving the reader to infer it from one failed attempt.

The check runs after the extension filter, so a `notes\1.txt` in a TypeScript workspace is
filtered on the extension alone: it was never a candidate, and an incident that gates the exit
code should not be raised about a file the scan was never going to read.

Renaming is the only fix that makes the file *describable*. `ignore` only stops the run
mentioning it — no setting gives the character a spelling here, because it has none rather than a
disallowed one.

`aburi explain` answers for one of these files without consulting the document, since no document
could hold it: see §7.2.

**The second cause: a top-level name that reads as a drive.** A path opening with one ASCII
letter and `:` names a Windows drive, and invariant #10 refuses it as absolute on every platform,
because a Document written on POSIX has to mean the same thing read on Windows. So `a:notes.ts`,
and every file under a top-level directory `d:data/`, has no spelling either, though both are
ordinary workspace-relative names on a POSIX filesystem. The test is on the first segment as the
rule reads it, after normalization to NFC, so a name opening with U+212A KELVIN SIGN and `:` is
one too — NFC turns that sign into `K` — and the listing prints the name as it is spelled on
disk.

A `:` anywhere else is the `unroutable` case §5.6 lists — `ab:notes.ts` and `src/x:y.ts` are
recorded by path, since the rule admits them and only the Symbol id grammar refuses them — so the
line between the two is drawn exactly where the rule draws it, and no name the walk accepts is one
the rule then throws on.

```
⚠ 3 file(s) were left out of the IR and out of its counts, under 2 top-level name(s) a Document path reads as a Windows drive: a path opening with one ASCII letter and ":" names a drive there, and a Document means the same on every platform, so no workspace-relative path can open that way. Rename each one below, or leave it out with ignore, which matches the name as printed.
    a:notes.ts
    d:data — a directory, and the 2 file(s) under it
```

It exits `3`, lists one line per name with no cap, and blames a directory once, for the reasons
given for the backslash above. Its own paragraph, because the `ignore` advice differs: picomatch
gives `:` no meaning, and a pattern naming a directory excludes everything under it, so
`a:notes.ts` and `d:data` exclude these as printed. Where one segment holds both a backslash and a
drive, the backslash's paragraph names it, since doubling is then what the pattern needs; a
drive-shaped directory with a backslash further down is named by the directory, the shallower of
the two.

A workspace package whose directory has no spelling — under either of the first two causes — is
not a Component and not a `workspace.managers[].roots` entry, since no root could name it; the
rest of the workspace is detected and scanned ([`component-detect.md`](./component-detect.md)
§3.1.1). The paragraphs above list its files only when one of them is a file a language plugin
claims, and a package holding nothing but its `package.json` and a README would otherwise leave no
trace anywhere, so detection names the package itself, one line per package and per manifest of
the detector that found it:

```
⚠ pnpm package "a:pkg" (pnpm-workspace.yaml) is not a component and not on workspace.managers[].roots, and none of its files can be scanned: "a:pkg" opens with one ASCII letter and ":", which a Document path reads as a Windows drive, so no IR can name it. Rename it.
```

The quoted name is the directory to rename, which is the package's own unless it sits below one:
a package at `d:data/pkg` names `"d:data"`. Both are printed as spelled on disk. The line comes
first among the incidents, beside a pattern that named no package, and like that one it is
followed by the fallback's line when no other package was found
([`component-detect.md`](./component-detect.md) §5):

```
⚠ No other workspace package was found, so the whole repository is described as one component.
```

`aburi scan` exits `3` for it, whether or not the package holds a source file, for the reason it
exits `3` for a file: the Document leaves out something the workspace declared, and nothing in it
says so. `aburi init` prints the same lines and exits `0`, as it does for a pattern that named no
package: it writes a config rather than a Document, and the config it writes leaves the package
out, which is what every scan of that workspace does too.

**The third cause: two names, one path.** A path is normalized on the way into the Document
(§1.2), and two names differing only in how they are composed normalize to the same string. The
Document then has one path for two files, which is no name for either.

```
⚠ 2 file(s) were left out of the IR and out of its counts, on 1 path(s) that two names claim at once: the Document holds every string in Unicode NFC, and these names differ only in how they are composed, so normalizing them gives one path for more than one file. Rename one of each group. ignore matches the spelling on disk rather than the one below, so the pattern that works there is a wildcard.
    src/café.ts — claimed by 2 file(s) on disk:
        "src/café.ts" (U+0073 U+0072 U+0063 U+002F U+0063 U+0061 U+0066 U+0065 U+0301 U+002E U+0074 U+0073)
        "src/café.ts" (U+0073 U+0072 U+0063 U+002F U+0063 U+0061 U+0066 U+00E9 U+002E U+0074 U+0073)
```

Every claimant is withdrawn, not one kept. A rule granting the path to the NFC-spelled claimant
is partial — two *different* decomposed spellings can normalize to one composed path with no NFC
claimant among them — and it is the pair that is at fault rather than either file, the same
reading a backslash in a directory name gets.

The codepoints are not decoration. The whole property of the pair is that the names are
different bytes and identical glyphs, so the two lines would otherwise print the same.

The pair is decided over every **candidate**, not over the files that were read: one path landing
in `stats.skippedFiles[]` *and* on `symbols[].source.file` is the contradiction `aburi diff`
resolves as a deletion, and two skipped claimants break invariant #21 outright.

Renaming all but one of the group is the fix. `ignore` does something different in each
direction, and the summary "use a wildcard" is false, so the paragraph states both. Measured
against discovery's own options, on a composed and a decomposed spelling of one path:

| `ignore` pattern | candidates left |
|---|---|
| none | both, withdrawn as a collision |
| the path printed above | the claimant *not* spelled that way, scanned normally |
| the other claimant's spelling | the composed one, scanned normally |
| `src/caf*` | none |

So the printed path is not a pattern that fails: it is the one that resolves the collision and
keeps a file, by excluding the claimant it names. It matches nothing only in the case two
paragraphs up — where no claimant is spelled as the normalized path — and that is the case the
"wildcard" advice is actually for.

`aburi explain` has no dedicated answer for this one, the way it does for a name a path cannot
spell: that is decidable from the argument string, and a collision is a property of a group, so
nothing in the argument says whether one exists. On the default path it rescans, so the section
above is printed and the run exits 3 like any other scan that found one. Under `--ir` or
`--no-rescan` there is no scan and the document holds no trace of the group, so the lookup
answers `No matches` at exit 1 — which is the case to know about.

## 6. `aburi diff`

Compares two IRs.

### 6.1 Signature

```
aburi diff <base>..<head>                                  # specify git refs
aburi diff --base <ir.json> --head <ir.json>               # specify existing IRs directly
```

### 6.2 Options

| Option | Meaning |
|---|---|
| `--base <path>` | Base IR file path (instead of a ref) |
| `--head <path>` | Head IR file path (instead of a ref) |
| `--output-dir <path>` | Destination for diff.json / diff.md / diff.full.md (default: `config.output.dir`, then `out`) |
| `--format <json\|md\|both>` | Output format |
| `--filter <kinds>` | Comma-separated restriction to change kinds (`added,removed,changed,moved,moved+changed`) |
| `--fail-on <kinds>` | Exit 3 if even one change of the given kinds (status granularity) exists (for CI gates). Repeatable: each occurrence adds its clauses after the earlier ones' (§6.7) |
| `--max-bytes <n>` | Cap `diff.md` at n UTF-8 bytes, keeping sections most important first at their smallest (names only for a section of whole Symbols) and then growing the name lists back to full entries from the top ([`markdown-projection.md`](./markdown-projection.md) §6.4). `diff.json` is never capped, and when the cap changed the report the uncapped one is written as `diff.full.md` beside it. Absent: no cap — `0` is exit 2 here, not the opt-out it is on the action input. Warns when `--format json` leaves it nothing to cap, and when the budget could not be met |
| `--quiet` | Limit stdout to a single final summary line |

### 6.3 Arguments

Ref forms:
- `main..HEAD` — base=main, head=HEAD
- `v1.2.0..v1.3.0` — tag comparison
- `abc123..def456` — direct commit specification

Exactly one `..` separates the two refs. The three-dot form `main...HEAD` — what a GitHub
compare URL and `git diff a...b` spell — is **rejected as a syntax violation** (exit 2, §6.5)
with a message naming the two-dot rewrite and pointing at `git merge-base <base> <head>`
(placeholders, not the caller's own refs pasted into a runnable command: a ref name may legally
contain `$`, backticks and `;`). It is refused rather than accepted-as-two-dot because the two forms answer
different questions, and silently answering the other one is worse than saying so. A
merge-base form of its own is under consideration (see the [roadmap](../roadmap.md)).

If git is unavailable, pass existing IR files via the `--base / --head` pair.

### 6.4 Behavior

With refs (every git command these steps run gets the caller's environment as §6.4.3 describes):
1. **Pre-validation** (§6.4.1)
2. Create a temporary git worktree and check out the base ref
   - **Directory name**: the worktree's own directory is named after the head workspace's directory (`<temp>/base/<head-workspace-dirname>`), under a `base/` level of its own so the leaf is free to be any name the workspace has — `base-out` and `head-out` included, which as siblings would be the run's own temporary scan outputs
   - Rationale: component autodetection falls back to the directory name for a Component rooted at the workspace root ([`component-detect.md`](./component-detect.md) §4.1 — a Component under `packages/*` takes its name from its own directory and never reaches this one). A fixed name would give the base side a different Component id from the head's, so a workspace whose Component is the root itself and which declares **neither** a package name **nor** explicit `components[]` would report one Component added and one removed on every diff
   - Two leaves the rule cannot use: an empty one (only at the filesystem root) and `@` (which `git worktree add` cannot spell under `.git/worktrees/`, failing with `fatal: not a git repository`). Both fall back to `base`. That is safe because a substitution can only reinstate the defect by supplying a Component id differing from the head's, and both leaves kebab-case to nothing: where detection decides ids the scan refuses the workspace with `invalid-component-id` and names the directory that did it, and where `components[]` declares them no directory name is read on either side
3. Run `aburi scan` on the base and store the IR temporarily
   - **Config used**: apply the **head-side `aburi.json`** to the base scan as well (the base is interpreted through the head's view; a stale config remaining in the base is ignored)
   - Rationale: using the config as of the base ref would make "config change = the entire IR changes", breaking the diff. Fixing the view to the head automatically resolves config differences
   - A future `--base-config <path>` may be provided to override this (planned — see the [roadmap](../roadmap.md))
4. Run `aburi scan` on the head (the original cwd)
   - Both scans root at the repository: the workspace-root walk stops at the first `.git` ([`component-detect.md`](./component-detect.md) §2.1, CD32), the head checkout's own `.git` (a directory or a file) on one side and the temporary worktree's `.git` file on the other. Rooted anywhere else, the two sides scan different trees (`component-detect.md` §11.1 has the layouts that did), so a base scan that roots anywhere but its worktree ends the run as a bug in Aburi (exit `1`, §9)
5. Compare the two IRs and compute the diff ([`diff-algorithm.md`](./diff-algorithm.md))
6. Write `<output-dir>/diff.json` + `<output-dir>/diff.md`, and `<output-dir>/diff.full.md` (the uncapped `diff.md`, written before `diff.md` so the note never points at a file that failed to land) when `--max-bytes` changed the report. Any `diff.json`, `diff.md` or `diff.full.md` already there was removed when the output directory was created, ahead of step 1 and whatever the `--format`, since each would describe another diff: a `--format md` run leaves no `diff.json` of an earlier run's, and a `--format json` run no `diff.md`, so none naming a `diff.full.md` that is gone. So a run that stops before this step (a plugin that fails to load, a strict scan's undeclared value) leaves no report at all rather than an earlier one a caller would take for its own. A path there that cannot be removed is refused like one that cannot be written
7. Print a one-line summary to stdout
8. Clean up the worktree. This holds for a run stopped by `SIGINT`, `SIGTERM` or `SIGHUP` too: from just after the temporary directory is created until this cleanup has finished, a listener for each removes the worktree and the temporary directory synchronously, then raises the same signal again, so on POSIX the exit status stays 128+N. On Windows a signal cannot be raised against the process again; the run exits with that same 128+N instead. A failed removal on this path is reported on stderr. The listener narrows the window rather than closing it: a signal sent to this process alone (not to its process group, as a terminal's Ctrl-C is) does not reach a `git worktree add` still running, and that child can finish registering the worktree after the cleanup has run, leaving it behind. `SIGKILL` cannot be caught, and leaves both behind; `SIGQUIT` and `SIGBREAK` are not handled either

With file inputs: skip steps 1-3 and start at step 5.

### 6.4.1 Git Pre-Validation (Ref Form)

Before creating the worktree, the following checks run in order; on failure, a concrete remediation message on stderr. The exit code follows §9's line: a ref that names nothing is what the reader typed, or where they ran the command (exit 2); a checkout whose shape the command cannot work with, or a git that will not answer, is exit 1.

| Check | Failure message | exit |
|---|---|---|
| `git rev-parse --verify <ref>` succeeds for `<base>`, then `<head>` (the message opens `Head ref` when it is the head that failed). When it does not, the run asks git two more questions to say why, because git's own stderr (`Needed a single revision`) does not distinguish a mistyped ref from a repository with nothing to name — and `git fetch` is the wrong remedy for two of the three. Each message ends with what git itself reported, in parentheses | `Base ref '<ref>' could not be resolved: <cwd> is not inside a git repository. Run aburi diff from inside one, or compare IR files with --base/--head.` — when `git rev-parse --is-inside-work-tree` is refused *and* nothing git would open (a `.git`, or `GIT_DIR`) stands at `<cwd>` or above it. A refusal with a `.git` above is not this: it is the row below | 2 |
| | `Base ref '<ref>' could not be resolved: <cwd> is inside a git directory, not a working tree. …` — when that probe prints `false` | 2 |
| | `Base ref '<ref>' could not be resolved: the repository at <cwd> has no commits yet, so there is no revision to compare.` — when `git rev-list --all --max-count=1` prints nothing | 2 |
| | `Base ref '<ref>' could not be resolved: no such revision in this repository. Check the spelling, or fetch the branch first.` — when both questions were answered. No `--deepen` advice: the shallow check below refuses the clone that would follow it | 2 |
| | `Base ref '<ref>' could not be resolved, and git would not say why. What it reported: <git's stderr>` — when git refuses either question inside a repository. Dubious ownership is the everyday case, and git's own report carries the `safe.directory` remedy, which no diagnosis of ours could | 1 |
| `git` can be spawned at all | `git executable not found in PATH. aburi diff <base>..<head> requires a working git installation. Install git or use --base/--head with pre-generated IR files.` | 1 |
| Repository is not shallow (`git rev-parse --is-shallow-repository` is `false`) | `Repository is shallow. aburi diff requires base ref history. Run: git fetch --unshallow` | 1 |
| Sparse-checkout is disabled (`git config --bool --default false core.sparseCheckout` is `false`; `--bool` reads `1`, `yes` and `on` as `true` too) | `Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable` | 1 |
| The index holds no submodules: no gitlink (mode `160000`) in `git ls-files -z --stage`, run at the head workspace root. This is the list `git submodule status` prints. `-z` is what keeps each path whole: without it git renders a path outside printable ASCII the way `core.quotePath` asks — double-quoted and octal-escaped — and under it each record is NUL-terminated and git's path quoting is bypassed entirely. `git worktree add` does not populate submodules, so the base side would see each one empty while the head walks into its checkout; the paths are therefore left out of both **file** scans (as `ignore` patterns matching each path literally), and the warning names them. Component detection still walks them, since it looks for manifests without `ignore`, so a submodule that is itself a workspace package can still appear in the Component delta | `Submodules detected: <list>. Submodule-aware diff is not yet supported, so their files are left out of both file scans. Component detection still walks them, so a workspace package inside one can still be reported as a Component added or removed.` (warning; continue) | — |
| On Windows, trial-check whether the base ref contains symbolic links | `Symbolic links in working tree may fail to materialize in worktree on Windows.` (warning; continue) | — |

The two diagnosing questions are asked only once a ref has failed, so a run whose refs resolve pays for no extra git calls. Only an answer becomes a diagnosis: a question git refuses ends the run with git's own words rather than with a guess, because whatever refused the ref is still refusing, and a guess would replace the one precise sentence there is with a wrong one at the wrong exit code.

#### 6.4.1.5 Plugin Dependency Resolution at the Base Ref

When scanning the base ref for `aburi diff <base>..<head>`, Aburi **shares the head's `node_modules`** (the worktree only materializes the base sources at a separate path; dependency resolution uses the original cwd's `node_modules`).

- **Rationale**: since §6.4 decided to "apply the head's `aburi.json` to the base scan as well", the plugin set also comes from the head. Reinstalling from the base ref's `package.json` for the base scan would explode build time, and `--frozen-lockfile` does not work on shallow clones
- A **relative plugin ref** (`./plugins/x.mjs`) in that config resolves against the head's workspace root, not the worktree, for the same reason: the ref belongs to the head's plugin set, and a commit that adds a plugin file would otherwise make the base scan fail to load a config the head reads fine. Everything else inside the config — `ignore`, `components[].roots` — keeps resolving against the scan's own workspace root, which for the base scan is the worktree, because those name *sources* and the base's sources are what the worktree holds
- **Known limitation**: when the base ref's sources cannot be extracted with the head's plugins (e.g. the base uses syntax from an older framework version and the head's framework plugin only supports the newer one), parsing/extraction may fail
  - This is a consequence of the "IR generator is pinned to the head environment" design
  - On failure, the affected file is skipped with a warning log
- The request "apply the base ref's contemporaneous plugin set" is under consideration as `--base-plugins <path>` for a future release (see the [roadmap](../roadmap.md))

#### 6.4.2 GitHub Actions Guidance

Required setup when using `aburi diff` in CI:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0    # full history (aburi diff fails on shallow clones)
```

Nothing less: the pre-validation above refuses a shallow repository outright, so a `fetch-depth` of `50` produces a clone this command will not diff, and the default of `1` cannot be used either. Nor a partial tree: `sparse-checkout:` on `actions/checkout` turns `core.sparseCheckout` on, which the pre-validation refuses too, so the job that runs `aburi diff` leaves it out.

#### 6.4.3 The Caller's Git Environment

Every git command `aburi diff` runs, from the §6.4.1 pre-validation through the rename collection to the worktree steps, gets the caller's environment without `GIT_INDEX_FILE` and `GIT_PREFIX`. A commit hook exports both. `GIT_INDEX_FILE` names the index of the commit being made, and `git worktree add` checks the base out through whatever index it names: inherited as an absolute path, which `commit -a` and `commit <paths>` export in the main worktree and every commit exports in a linked worktree, it would overwrite that index and the commit would record the base revision's tree; inherited as the relative `.git/index` a plain `commit` exports in the main worktree, the worktree step would fail on the new worktree's `.git` file. `GIT_PREFIX` is the hook's directory inside the caller's tree.

Everything else is passed on. `GIT_DIR` names the repository both scans are about, and for a bare repository driven with `GIT_WORK_TREE` it is the only thing that does. `GIT_WORK_TREE` is passed on for that same caller, because `git rev-parse --is-inside-work-tree` in §6.4.1 asks about the caller's working tree, and without it a mistyped ref would be diagnosed as a run from inside a git directory. The caller's `-c` settings (`GIT_CONFIG_PARAMETERS`) stay theirs.

### 6.5 Exit Codes

| code | Meaning |
|---|---|
| 0 | Diff computed successfully (regardless of whether differences exist) |
| 1 | Computation error (invalid IR, git error, an output the disk refused) |
| 2 | Argument error (`<base>..<head>` syntax violation; one of `--base/--head` missing, or either beside a ref spec; a ref that resolves to nothing — §6.4.1; an `--output-dir` a file stands on; an option that takes one value given twice, or a path given empty — §3) |
| 3 | Changes matching `--fail-on` were detected (CI gate), or one of the two scans this command ran did not exit clean (§5.6) |

The second cause is about greenness, not about counts. A file withdrawn during extraction is recorded in
`stats.skippedFiles`, so its Symbols already classify as `unknown` rather than as deletions and
the diff overstates nothing. The exit code is what would be wrong: the same workspace makes
`aburi scan` exit `3`, and asking it for a diff instead must not turn it green.

A fault at the **base** ref gates as well. That is a policy rather than a side effect, and it
has a cost — a broken base reddens every diff taken against it until the base moves — but a
comparison with a broken half is not evidence about the half that worked.

It gates on the scan's exit code, not on a named incident, and the diagnostic wording is derived
from what the scan actually reported so that a second reason arrives with the code right and the
message still true. Three more have: a scan whose coverage collapsed (§5.7), one that found a
file the Document cannot name (§5.8), and one that found a workspace package it cannot name
(§5.8). The file is named ahead of "discovered no file to read"
and behind the other two faults, because an unnameable file leaves `totalFiles` — so a workspace
whose whole candidate set is unnameable discovers nothing and that fault is this one's
consequence, while leaving the denominator can only raise the parsed ratio and so cannot produce
either of the others. The package is named — `N workspace package(s) sit in directories no
Document path can spell` — only when none of those is, since a file under it is one of the
unnameable files the scan already counts. A coverage collapse reddens a diff the
same way an extraction fault does, and names itself — `The base scan parsed none of the 1200
file(s) it found` — rather than falling back to "did not exit clean". An extraction fault is named
first when both apply, because a scan that withdrew every file has the coverage fault as a
consequence of it rather than as a second finding.

When a gate clause and a scan fault both apply the code is `3` either way, both messages are
printed, and `DiffReport.faultedScans` names the sides so a programmatic caller does not have to
read the warnings to tell the two apart.

### 6.6 stdout Example

Normal:
```
+5 -3 ~12 ↔2 ⤴1   (added · removed · changed · moved · moved+changed)
calls 1310 · resolved 1203 · unresolved 107 (external 30 · dynamic 60 · ambiguous 3 · no-match 14)
→ out/diff.md
```

The second line is the head IR's `stats.callResolution` ([`call-resolution.md`](./call-resolution.md) §8.1). It answers "is the Slice View below missing edges?" without a second command. Buckets with a count of zero are omitted; when nothing is unresolved the line reads `calls N · resolved N · unresolved 0`.

A head IR produced before the counter existed cannot be back-filled, so the line is omitted rather than printed as zeroes — zeroes would assert a clean call graph the run never observed. Omitting it silently would be its own failure, though: the reviewer would read the Slice View without knowing the signal that explains a suspicious singleton is absent. A one-line note therefore goes to **stderr** (§18.2 — stdout carries result data only), naming the cause and pointing at a re-scan of the head revision.

The `unknown` count is appended to the first line when there is one — `+5 -3 ~12 ↔2 ⤴1 · ?2 unknown` — and omitted otherwise, so the line a reviewer skims on every PR does not grow a permanent `?0`. It qualifies the counts beside it: the added and removed totals are smaller than the truth by that much.

It counts Symbols only. `summary.depsUnknown` counts the same thing for `dependencies[]` ([`diff-algorithm.md`](./diff-algorithm.md) §6.2.1) and stays out of this line for the reason the dependency counts already do: the glyph line reports the Symbol-level shape of a change, and `depsAdded` / `depsRemoved` are not on it either. `depsAdded`, `depsRemoved` and `depsUnknown` all appear in `diff.json`; `diff.md` lists the corresponding edges under Dependency changes and prints no counts at all.

A file skipped by **both** scans produces no `unknown` entry — there are no Symbols from it in either document, so the matcher has no leftover to classify. It is reported at document level instead: `diff.json` carries the path and each scan's reason in `notCompared[]`, and `diff.md` lists it under `## 🚫 Not compared` ([`diff-algorithm.md`](./diff-algorithm.md) §6.3). The stderr line stays, deliberately shorter than the artifact — a count and a capped list of paths, a renamed file as `base → head` as `diff.md` names it, no reasons — because it is the cover note for whoever is watching the command, and a terminal line that grows with the size of a workspace's blind spot stops being read.

An IR that dropped files but predates `stats.skippedFiles` reports the count without the list, and `aburi diff` cannot then tell a lost file from a deleted one — it classifies every leftover as `added` / `removed`, which is the pre-field behaviour, and warns on **stderr** for each side that is in that state. It does not guess: inferring the list from `totalFiles > parsedFiles` would attach the doubt to whichever Symbols happened to be missing.

Ref mode runs two scans, so both scans' incidents (§5.6) appear, labelled by side. The base is
labelled by its ref; the head is labelled `head (working tree)` and never by the ref spec's head
token, which §6.4 does not scan.

A file lost on **both** sides therefore produces each scan's account of it and then the diff's:
each scan saying what it failed to read, and the diff saying the comparison never happened. That
is not duplication — neither scan is in a position to know the other lost the same file — and
how many lines it comes to depends on the reason. A refusal costs two per scan (the withdrawal
and the skip summary), an over-size file one.

One line has no counterpart in the artifact at all. A file whose parse reported *recoverable*
errors reached the IR rather than `stats.skippedFiles`, so nothing marks it and nothing about it
becomes `unknown` — yet those errors may have cost it a declaration, leaving its Symbol set short
and moving `added` / `removed` with no file having gone missing. `aburi diff` says so when either
scan reported one, and only ref mode can: `parseErrorCount` is a property of the scan, not of the
document it wrote, so `--base` / `--head` has nothing to read.

`--base` / `--head` is not silent about faults, though. `stats.skippedFiles[].reason` persists
`extraction-failed`, so file mode can see that a file was withdrawn when a document was written even
though it never watched it happen; it names those paths per side. It does **not** gate on them:
the fault already had its exit code in the run that hit it, and failing here would red a job for
someone else's incident, on documents the caller pinned deliberately. `DiffReport.faultedScans`
is `null` in this mode rather than empty, because "ran no scan" is not the same answer as "ran
two clean scans".

`--quiet`:
```
+5 -3 ~12 ↔2 ⤴1
```

### 6.7 Uses of `--fail-on`

Used in CI for gates such as "PRs containing changes of a specific status require approval before merge":

```bash
aburi diff main..HEAD --fail-on changed,removed
# exit 3 if even one symbol has status "changed" or "removed"
```

`unknown` counts Symbols only — it reads `symbols[]`, not `dependencies[]`, and not `notCompared[]`. A gate written meaning "fail if this diff is incomplete" therefore catches neither the dependency side ([`diff-algorithm.md`](./diff-algorithm.md) §6.2.1) nor a file both scans skipped (§6.3), and no token exists for either. A bare token for the second would be the wrong default in any case: a workspace with a permanent over-size bundle would trip it on every pull request, which is an argument for a threshold rather than a flag. Whether the gate vocabulary should grow either family is an open decision.

#### Accepted Values

| Kind | Values |
|---|---|
| Status granularity | `added` / `removed` / `changed` / `moved` / `moved+changed` / `dropped-toggled` / `unknown` |
| Delta granularity | `api-changed` / `logic-changed` / `syntax-changed` / `confidence-changed` |
| Direction granularity | `dropped-toggled:to-dropped` / `dropped-toggled:to-kept` |
| Count threshold | `<value>:><N>` (e.g. `dropped-toggled:>10` fires when the count exceeds 10) |

Multiple values may be given, comma-separated. Every segment must be a clause: an empty one (`added,`, `added,,removed`) exits 2, as a value with no clause at all does.

`--fail-on` may also be repeated, so a script can write one clause per `--fail-on`: each occurrence adds its clauses after those of the occurrences before it, and `--fail-on changed --fail-on removed` gates exactly as `--fail-on changed,removed` does — the order included, which decides the clause a tripped gate names. Keeping only the last occurrence would leave the earlier clauses unchecked, and the run would pass on the change they were written to block. Each occurrence is read as a value of its own: an error quotes the one at fault and counts clauses within it (`--fail-on removed, --fail-on changed` exits 2 with `--fail-on value "removed," is invalid: clause 2 of 2 is empty; …`), and an empty occurrence exits 2 beside a valid one as it does alone. `runDiff`, which also takes the values as a list, refuses an empty one as it refuses an empty value, since either leaves the gate checking nothing.

#### Uses of Direction-Specific fail-on

`--fail-on dropped-toggled:to-kept` detects "symbols previously treated as dropped became kept". Useful for deliberate review of drop-rule relaxation.
The inverse, `dropped-toggled:to-dropped`, detects "symbols that were kept became dropped" (e.g. checking the blast radius of a DTO consolidation).

#### Uses of Count Thresholds

In cases where a drop-rule change legitimately fires `dropped-toggled` in bulk (e.g. changing all DTOs), a plain `--fail-on dropped-toggled` misfires. A threshold such as `--fail-on dropped-toggled:>50` — "block only when there are more than 50" — is the practical choice.

#### Evaluation Rules

- Status granularity (`changed`, etc.): fires if even one Symbol has the given status
- Delta granularity (`api-changed`, etc.): fires if even one Symbol has status `changed` or `moved+changed` with the corresponding `delta.<axis>Changed: true`. A diff written before `delta.confidenceChanged` existed carries no key, and `confidence-changed` counts nothing in it

Examples:

```bash
aburi diff main..HEAD --fail-on api-changed
# exit 3 if even one symbol has delta.apiChanged: true
# changed symbols where only logic changed, and moved (status only), have no effect

aburi diff main..HEAD --fail-on api-changed,removed,dropped-toggled
# fires on API change OR removal OR drop-rule fluctuation
```

This allows fine-grained CI gates, making operational policies such as "only API changes require approval, logic changes are warnings" possible today.

A Symbol whose extraction confidence moved is `changed` even when no fingerprint did ([`diff-algorithm.md`](./diff-algorithm.md) §4), so `--fail-on changed` fires on it. A plugin can decide confidence from a file-level signal (the Express plugin reads whether the file imports `express`), so one edit can move every Symbol in a file at once. A gate that should not fire on that writes the axes it cares about (`--fail-on api-changed,logic-changed`, which a confidence-only change does not trip) and, where a mass shift should still be noticed, a threshold on the confidence axis (`confidence-changed:>20`).

## 7. `aburi explain`

Shows details of a single Symbol / file / pattern match.

### 7.1 Signature

```
aburi explain <id-or-pattern> [--output <path>] [--ir <path>] [--no-rescan] [--debug-resolution]
```

### 7.2 Arguments

`<id-or-pattern>` is one of:
- **Full Symbol id** — the string contains `#` and matches the `<language>:<path>#<qname>` form → direct lookup
- **File path** — the string contains `/` and either is an existing file or is a path the IR names in `stats.skippedFiles` (§7.6) → show all Symbols in that file. A `#` in it does not disqualify it: the id form above is checked first and only claims the argument when it *is* one, and a file whose name holds an id separator is recorded in `stats.skippedFiles` precisely because no Symbol in it could be named
- **Partial-match pattern** — anything not matching the above → collect candidates by **case-sensitive substring match** against each Symbol's qualified name (`Symbol.name`)

A file path whose workspace-relative path holds a **backslash**, or whose first segment reads as
a **drive** (`d:data/x.ts`, `./a:notes.ts`), is answered without consulting the document at all,
with exit 3: no IR can name it (§5.8), so neither the skip list nor the file existing on disk
says anything about it, and `No matches` would be a claim about the workspace when the absence is
the format's. The line on stderr says which of the two it is, naming the segment to rename as the
argument spells it. The same answer whether the run scanned or read an IR off disk, because it is
decided from the argument.

The path tested is the workspace-relative one, not the argument: run from `src/`, `./a:notes.ts`
is `src/a:notes.ts`, which a Document can name and which is looked up as any other file, while
`../a:notes.ts` is the drive case. An argument without a `/` gets this answer too when it names a
file on disk — `aburi explain a:notes.ts` beside that file — and otherwise keeps the rule above:
`A::create`, a static member's qualified name, opens the way a drive does and names no file, so it
is matched as a substring. On Windows an argument on another drive is outside the workspace rather
than a name, and is looked up as any other path.

#### 7.2.1 Exact Definition of Partial Matching

- **case-sensitive** (`getUser` and `getuser` are distinct)
- **substring match** on `Symbol.name` only (= a partial match against the whole qualified name; `Service.create` hits `InvoiceService.createInvoice`)
- **no glob support** (patterns like `*Service` are under consideration for a future release — see the [roadmap](../roadmap.md))
- If multiple candidates match, exit 2 + candidate list on stdout

### 7.3 Options

| Option | Meaning |
|---|---|
| `--output <path>` | Write to a file (default: stdout). The directories the path names are created, as `--output-dir` creates its own; a path that cannot hold a file — it names a directory, or a file stands on its parent path — is exit 2 |
| `--ir <path>` | Use an existing IR file. Resolved against the working directory, as every path-bearing flag is. Without it the command looks for `<output-dir>/aburi.ir.json` — `config.output.dir` when the config names one, otherwise `out` — starting at the working directory and walking up to the workspace root, taking the nearest — `aburi scan` writes under the directory it was run from, and a scan covers the whole workspace wherever it was started, so either place holds an answer about the same tree. Nothing found triggers a scan, or exits 2 under `--no-rescan` |
| `--no-rescan` | Exit `2` when the lookup above finds no IR, instead of scanning. Staleness is not examined: an IR that is found is read whatever its age. An `aburi scan --format md` removes the IR an earlier run left in its output directory (§5.3), so a scan that wrote only pages leaves none to be read in its place |
| `--debug-resolution` | Append a `## Call resolution` table: one row per call site with the resolved callee, or the [`call-resolution.md`](./call-resolution.md) §8.1 bucket that explains the `null`, plus the competing candidates for `ambiguous`. Those buckets are per-run diagnostics that the IR deliberately does not persist, so the flag **always rescans** and is rejected (exit 2) alongside `--no-rescan` or `--ir`. It is a reporting flag, not a tuning knob — no IR or diff content changes |

### 7.4 Behavior

1. Read the IR (invoke `aburi scan` internally if missing). That scan writes the IR alone and removes nothing an earlier `aburi scan` wrote beside it (§5.3)
2. Resolve the argument:
   - Full id → direct lookup
   - File → all Symbols in that file
   - Pattern → collect candidates by partial name match
3. Generate the Markdown projection ([`markdown-projection.md`](./markdown-projection.md) §7)
4. Emit to stdout (or `--output`)

When step 1 rescans, that scan's incidents (§5.6) go to stderr, unlabelled — only one scan ran.
Reading an existing IR reports nothing live: no scan happened here, and the incidents of the scan
that wrote the file were reported when it did. What the document itself records about those
incidents is a different matter, and step 2 reads it — see §7.6.

### 7.5 When Multiple Candidates Match

```
Multiple matches for "createInvoice":
  1. ts:apps/billing/src/InvoiceService.ts#InvoiceService.createInvoice
  2. ts:apps/billing/src/legacy/OldService.ts#OldService.createInvoice
  3. ts:packages/test/src/factories.ts#createInvoice

Specify the full id to disambiguate.
```

exit code: 2 (ambiguous).

### 7.6 When the Document Does Not Cover the Question

`stats.skippedFiles` ([`ir-schema.md`](./ir-schema.md) §2) names every file the scan gave up on
and why. A lookup that finds nothing is an assertion of absence, and that list can contradict it:
the file that would have declared the Symbol was withdrawn, so the document does not know.

One principle decides every case. **The answer is `unknown` (exit 3) when the document positively
identifies the file the question named as one it never analysed; it stays "not found" (exit 1),
qualified, when the doubt is diffuse.**

| Arm | Names a file? | Miss becomes |
|---|---|---|
| Full id | yes — the `<path>` segment of the id | `unknown` when that path is in `stats.skippedFiles`; otherwise the diffuse answer below |
| File path | yes — the argument | `unknown` when that path is in `stats.skippedFiles`; otherwise the diffuse answer below |
| Pattern | no | always the diffuse answer below |

The diffuse answer is `not found` (exit 1) with a line counting the files the document says it
never analysed, and it attaches to **every** miss the document could not tie to the file the
question named — including a miss in the two naming arms on a file that was analysed after all.

```
$ aburi explain src/route.ts --ir out/aburi.ir.json
Cannot answer "src/route.ts": this IR never analysed src/route.ts (parse-failed), so it cannot say what that file declares.
EXIT=3
```

Consequences of the principle, each of which is a case that would otherwise be argued separately:

- **The file arm does not require the path to exist on disk.** A path named in
  `stats.skippedFiles` reaches the arm as well. `--ir` and `--no-rescan` exist so a CI job can
  question a pinned artifact from a tree that need not hold the same files, and demanding the
  file locally would drop exactly the motivating case into the pattern arm.
- **The check runs on a miss only, so a hit is never qualified.** A hit is the document speaking
  about a Symbol it holds. An `over-size` file is skipped by every run of a workspace, so
  caveating hits would caveat every answer that workspace ever gives — and where a hit really is
  suspect because the *scan* broke, the §7.7 gate already covers it. This also settles the id
  whose `<path>` segment and `symbols[].source.file` disagree, which a re-export or a generated
  file produces: the Symbol is right there, and is answered.
- **The id arm asks the id grammar, not the `#`.** Dispatch is a silhouette; the file segment is
  only read out of a string that satisfies the whole Symbol-id grammar
  ([`ir-schema.md`](./ir-schema.md) §3.1). A typo that happens to contain a skipped path names no
  file, and gets the pattern arm's diffuse line rather than a positive claim about coverage.
- **A document predating `stats.skippedFiles` can only ever give the diffuse answer.**
  `totalFiles > parsedFiles` with no list says how many files were lost and nothing about which,
  so it can never identify the file the question named, in any arm. `aburi diff` reports the same
  shape per side (§6.6).

The diffuse line is a count and a pointer at `stats.skippedFiles`, not a list: the question was
about one Symbol, and answering it with an inventory of the run buries it.

### 7.7 Exit Codes

| code | Meaning |
|---|---|
| 0 | Success |
| 1 | The requested symbol was not found |
| 2 | Multiple candidates; disambiguation required, an `--output` that cannot hold a file, or an option that takes one value given twice or a path given empty (§3) |
| 3 | The answer would not be safe: the scan this command ran did not exit clean (§5.6), the document names the file the question asked about as one it never analysed (§7.6), or that file is one no IR can name (§7.2) |

Exit `3` outranks the other three, and the two routes to it are the same statement about
different evidence. When the scan broke, every answer is suspect: a `single` hit may have had a
competing candidate in the withdrawn file and should have been `2`, and a `not-found` may be
describing the withdrawal rather than the workspace. When the document is intact but says it
never read the file in question, only that question is unanswerable — which is the case that
matters most, because `No matches` is otherwise indistinguishable from "that Symbol does not
exist". Reading an existing IR reaches this code by the second route only; no scan ran.

## 8. `aburi vocab`

Queries the registered extension vocabulary.

### 8.1 Subcommands

```
aburi vocab list                            # all vocab
aburi vocab effects                         # effect ids only
aburi vocab extkinds                        # extKinds only
aburi vocab plugins                         # plugin list
aburi vocab who-owns <id>                   # the plugin that owns this id
```

### 8.2 Common Options

| Option | Meaning |
|---|---|
| `--json` | Machine-readable JSON output instead of a table |

### 8.3 Exit Codes

| code | Meaning |
|---|---|
| 0 | Success |
| 1 | id not found (who-owns only) |
| 2 | Subcommand missing or invalid |

### 8.4 Output Examples

`aburi vocab effects`:
```
core / db.read           — Database read operation
core / db.write          — Database write operation
...
effects-nest / x-nest:lifecycle.on-module-init      — NestJS OnModuleInit hook
effects-prisma / (prefix x-prisma)                  — Prisma plugin namespace
```

`aburi vocab who-owns x-nest:lifecycle.on-module-init`:
```
Plugin:      effects-nest (v1.2.3)
Type:        effects
Declaration: explicit (provides.effects[])
Description: NestJS OnModuleInit hook
```

## 9. Exit Code Conventions (All Commands)

| code | Use |
|---|---|
| 0 | Complete success |
| 1 | Runtime error (IO, extraction, git) |
| 2 | Input error (CLI arguments / config / missing / ambiguous) |
| 3 | Plugin error / fail-on gate / strict violation |

128+N is for fatal signals. Aburi does not choose it: a run stopped by a signal ends on that signal once its cleanup has run, so the status is the one the shell reports for the signal (§6.4, step 8).

The line between `1` and `2` is who has to act, not which subsystem failed. `2` covers the whole
of what the reader wrote: a config that does not parse, does not conform, or names the same
component twice — and a `--config` path that names nothing, which is the "missing" in the table
above and is a mistyped argument rather than an IO failure. `1` covers a config that is **there
and cannot be read**: a permission, a mount, a directory of that name. No edit to `aburi.json`
fixes any of those. And a failure Aburi's own invariants raised is `1` with the run named as a
bug in Aburi, since `2` is a sentence about the reader's file and would send them looking for
something that is not in it.

A plugin error means the same thing in every command that scans. `scan`, `diff` and `explain` all
exit `3` when the scan they ran did not exit clean, whichever of them ran it.

Code `3` also covers the narrower statement "this answer would not be safe", which a command can
reach without having scanned anything. `aburi explain` does when the document it read names the
file the question asked about as one that scan never analysed (§7.6): the toolchain is fine and
the document is intact, but the one question put to it is unanswerable, and reporting `1` would
be an assertion of absence. What a command still does **not** do is inherit a status from a
document it merely read — an IR that records losses irrelevant to the question is reported on
and left at the code the answer itself earned.

## 10. stdout / stderr Conventions

| Stream | Use |
|---|---|
| stdout | Results (summary lines, JSON, Markdown body). Pipeable; the target of CI parsing |
| stderr | Progress, warnings, error messages, colored UI |

Example: `aburi diff main..HEAD --quiet > result.txt 2> log.txt`

The `--json` flag (`aburi vocab` only) dedicates stdout to machine-readable JSON.

## 11. Environment Variables

| Variable | Meaning |
|---|---|
| `ABURI_CONFIG` | Config file path (equivalent to --config) |
| `ABURI_LOG_LEVEL` | Equivalent to --log-level, which wins over it (§3), except that a value other than the four levels is ignored rather than refused |
| `NO_COLOR` | If set, disable coloring (standard convention) |
| `FORCE_COLOR` | If set, force coloring on (standard convention) |
| `CI` | If set, CI mode (§12) |

Precedence: CLI flags > environment variables > config file.

git's own variables reach the git commands `aburi diff` runs, except `GIT_INDEX_FILE` and `GIT_PREFIX` (§6.4.3).

## 12. CI Mode

Automatic switches when the `CI=true` env is detected:

- Suppress progress animations (final summary only)
- Disable coloring (on if `FORCE_COLOR` is set)
- Emit stack traces on errors (debug only)

Can also be enabled via an explicit `--ci` flag (for CI environments where the env is not set).

## 13. Config Resolution Order

```
1. --config CLI flag
2. ABURI_CONFIG env
3. <cwd>/aburi.jsonc
4. <cwd>/aburi.json
5. Repeat 3-4 recursively in parent directories, up to the **filesystem** root — not the
   workspace root, so a config shared across several repositories is still honoured
6. autodetect (works with no config present)
```

Passing `--cwd` (planned, §3) will change the cwd and therefore the search origin.

`aburi diff` in ref mode runs this list **once**, against the invoking cwd, before it
materialises the base worktree — and hands the single answer (an absolute path, or "nothing
found, autodetect") to both scans. Re-running it from inside the worktree would resolve steps
1-5 against the base revision instead of the head — a relative `ABURI_CONFIG` relocates
exactly like a relative `--config`, since both arrive as the same value — and would turn a
head-side step 6 into a step 3-5 hit whenever the base ref still carries a config the head
deleted. Either is what §6.4 step 3 forbids.

## 14. Concurrency

- Parser concurrency for `aburi scan`: default = `max(1, CPU_count - 1)`
- Override with `--concurrency <n>`
- The effective concurrency is capped at `min(specified, floor(availableMemoryMB / wasmHeapPerWorkerMB))` ([`lang-plugin.md`](./lang-plugin.md) §8.1)
  - A guard against crashes from exceeding the WASM heap budget
  - The per-worker budget's source of truth is **`capabilities.wasmHeapPerWorkerMB` in the plugin manifest** (range: 16–4096 MiB; 256 MiB when undeclared)
  - When multiple lang plugins coexist in the same run, the **maximum** of the declared values is used
- On memory-constrained CI, `--concurrency 1` is recommended (for debugging)

A future release will switch to Node worker_threads instead of a worker pool (see the [roadmap](../roadmap.md)). Architecture details — pool sizing, work partitioning, serialization boundary, and byte-identical merge — are specified in [`performance.md`](./performance.md).

## 15. Planned Features

| Feature | Summary |
|---|---|
| `aburi watch` | Watch file changes and regenerate the IR |
| `aburi doctor` | Consistency check of config / plugins |
| `aburi serve` | LSP-like local server (IDE integration) |
| `aburi vocab list --json` extension | merged with discoverer output |

None of these are implemented yet; see the [roadmap](../roadmap.md). The signatures are reserved to avoid future compatibility breaks.

## 16. Help Output

`aburi --help`:

```
aburi - Render meaningful code structure as IR for review

Usage:
  aburi <command> [options]

Commands:
  init       Generate aburi.json from autodetect
  scan       Generate IR from current workspace
  diff       Compute diff between two IRs
  explain    Show single symbol details
  vocab      Show registered extension vocabulary

Common options:
  --cwd <path>           Set working directory (planned)
  --config <path>        Override config file location
  --log-level <level>    debug | info | warn | error
  --no-color             Disable colored output (planned)
  -h, --help             Show help for command
  -v, --version          Show version

Run "aburi <command> --help" for command-specific options.
```

Each command's `--help` follows the same three-section structure: "Usage / Options / Examples".

## 17. Verifiable Properties

| ID | Input | Expectation |
|---|---|---|
| CL1 | `aburi --version` | One-line version string, exit 0 |
| CL2 | `aburi --help` | Help for all commands, exit 0 |
| CL3 | `aburi nope` | Unknown command, exit 2 |
| CL4 | `aburi init` with existing aburi.json | exit 2, error message on stderr |
| CL5 | `aburi init --force` | Overwrites existing file, exit 0, warning on stderr |
| CL6 | `aburi scan` (no config) | Runs via autodetect, exit 0 |
| CL7 | `aburi scan --discover` | Records undeclared vocab, exit 0 |
| CL8 | `aburi scan` strict + undeclared vocab | exit 3 |
| CL8a | `aburi scan --strict --discover` | exit 2 |
| CL8b | `aburi diff` with `strict: false` + undeclared vocab | Listed in each scan's incident report; no `aburi-vocab-discovered.json`, since only `aburi scan` writes or removes the record (§5.3): the scans `aburi diff` runs write their IRs alone |
| CL8c | `aburi scan --discover`, then `aburi scan` once every value is declared | The second run exits 0 and removes `aburi-vocab-discovered.json` |
| CL9 | `aburi diff main..HEAD --fail-on changed` with changes | exit 3 |
| CL10 | `aburi diff` with missing arguments | exit 2 |
| CL11 | `aburi explain <ambiguous>` | exit 2, candidate list on stdout |
| CL12 | `aburi vocab who-owns <unknown>` | exit 1 |
| CL13 | `aburi vocab list --json` | machine-readable JSON, exit 0 |
| CL14 | Piping stdout (`aburi scan --quiet | wc -l`) | Readable without escape sequences |
| CL15 | `NO_COLOR=1 aburi scan` | No coloring |
| CL16 | `CI=true aburi scan` | Progress animation suppressed |
| CL18 | `aburi --config ./custom.json scan` | Uses the specified config |
| CL19 | `aburi explain <name>` where a plugin threw during the rescan | exit 3, incident lines on stderr |
| CL20 | `aburi diff main..HEAD` where a plugin threw at the base ref | exit 3 with no `--fail-on` clause, base-labelled lines on stderr |
| CL20a | `aburi scan` where a plugin emitted two Symbols under one id for one file (`lang-plugin.md` LP28b) | exit 3 and the IR still written, with that file on the `extraction-failed` lines a throw reaches — the wording there names both causes, since nothing threw. `aburi diff` gates the same way, and its fault clause says `extraction withdrew N file(s)` rather than naming an exception |
| CL21 | `aburi explain src/route.ts --ir <ir>` where that IR names `src/route.ts` in `stats.skippedFiles` | exit 3, the file and its skip reason on stderr, nothing on stdout |
| CL22 | `aburi explain <pattern>` with no match, against an IR that skipped files | exit 1, `No matches` plus a line counting them |
| CL23 | `aburi scan` in a workspace holding a source file whose name contains a backslash | exit 3, the name to rename on stderr, and the file not counted in `stats.totalFiles` |
| CL23a | `aburi scan` in a workspace holding `a:notes.ts`, `d:data/x.ts` and `ab:notes.ts` beside `src/ok.ts` | exit 3, the IR written, `a:notes.ts` and `d:data` to rename on stderr and neither counted in `stats.totalFiles`; `ab:notes.ts`, like `src/x:y.ts`, is an `unroutable` skip |
| CL23b | `aburi scan` in a pnpm or nx workspace one of whose packages sits at `a:pkg/`, holding a source file or only its `package.json` and a README | exit 3, a line naming the tool, `a:pkg`, the manifest and the reason on stderr; the other packages are Components and scanned, and `a:pkg` is none. A package at `odd/` in the same state is a Component that owns no file, and the scan exits 0. `aburi diff` with such a scan on one side exits 3, saying `N workspace package(s) sit in directories no Document path can spell` when nothing else faulted |
| CL23c | `aburi init` in the workspace of CL23b | exit 0, the same line on stderr, and no `components[]` entry rooted at `a:pkg`. Where `a:pkg` is the only package, `aburi init` and `aburi scan` both follow the line with `No other workspace package was found, so the whole repository is described as one component.` |
| CL24 | `aburi explain 'src/weird\name.ts'` where that file exists | exit 3, a line saying no IR can name it, nothing on stdout |
| CL24a | `aburi explain d:data/x.ts`, `aburi explain ./a:notes.ts`, `aburi explain ../a:notes.ts` run from `src/`, or `aburi explain a:notes.ts` where that file exists | exit 3, a line saying no IR can name it because the name reads as a drive, nothing on stdout. `./ab:notes.ts`, and `./a:notes.ts` run from `src/`, are looked up as any other file; `A::create`, and a bare `a:notes.ts` that is not on disk, are matched as substrings |
| CL25 | `aburi init --output config/aburi.jsonc` where `config/` does not exist | Creates the directory, writes the file, exit 0 |
| CL26 | `aburi explain <id> --output docs/alpha.md` where `docs/` does not exist | Creates the directory, writes the Markdown, exit 0 |
| CL27 | `aburi init` or `aburi explain` with an `--output` that names a directory, or whose parent path is an existing file | exit 2, the path and the remedy on stderr |
| CL28 | `aburi scan --output-dir notadir` or `aburi diff … --output-dir notadir` where `notadir` is a file | exit 2; stderr names the command, the output directory, the path and `--output-dir` |
| CL29 | `aburi scan` into a directory the process may not write to, or under a name the filesystem refuses | exit 1; stderr names the command, the artefact that did not land and the errno — never the bare errno alone, and no flag to point elsewhere, since none would help |
| CL30 | `aburi diff main..HEAD` outside any git repository | exit 2, "is not inside a git repository", git's own report appended, no `git fetch` advice. Inside a repository git refuses to open, exit 1 with that report instead |
| CL31 | `aburi diff HEAD~1..HEAD` in a repository with no commits | exit 2, "has no commits yet", no `git fetch` advice |
| CL32 | `aburi diff nope..HEAD` in a full clone | exit 2, "no such revision", "Check the spelling", no `--deepen` advice |
| CL33 | `aburi scan --format both --no-md`, or `aburi scan --no-md --no-json` | exit 2, naming the flags, and no output directory is created |
| CL34 | `aburi diff … --fail-on 'added,'` | exit 2, "clause 2 of 2 is empty", before any output is written |
| CL35 | `aburi scan`, `aburi diff main..HEAD`, or `aburi explain <name>` with no IR on disk, where each scanned tree holds a file that fails to parse | One `warn:` line per scan naming that file, so two from `diff`, and the same at `--log-level info` or with an `ABURI_LOG_LEVEL` other than the four levels; none at `ABURI_LOG_LEVEL=error`; the per-file `debug:` lines as well at `ABURI_LOG_LEVEL=debug`; `--log-level`, before the command or after it, wins over the variable whichever of the two is the more verbose |
| CL36 | `aburi scan --log-level loud` | exit 2 naming the four levels |
| CL37 | `aburi init --log-level debug` | exit 0: `init` accepts the flag, which has no per-file log there to govern |
| CL38 | `aburi init --help`, `aburi scan --help`, `aburi diff --help` or `aburi explain --help` | `--log-level` listed under "Global Options" |
| CL39 | `aburi diff … --fail-on changed --fail-on removed` over one changed Symbol, in either order; over a changed and a removed one, in either order | exit 3 in both orders, as `--fail-on changed,removed` gives, and `--fail-on removed --fail-on added`, or no `--fail-on` at all, exits 0; over both, the tripped line names the clause written first. An invalid occurrence beside a valid one (`--fail-on bogus --fail-on changed`, `--fail-on '' --fail-on changed`) exits 2 quoting that occurrence alone, before either IR is read and with an earlier report in the output directory left as it was. `runDiff` refuses `failOn: []` as it refuses `failOn: ""` |
| CL40 | Any option that takes a value, other than `--ignore` and `--fail-on`, given twice on any command — `init --output`; `scan --output-dir`, `--format`, `--config`; `diff --base`, `--head`, `--output-dir`, `--format`, `--max-bytes`, `--config`; `explain --ir`, `--output`, `--config`; and `--log-level`, before the command, after it, or once on each side — in either spelling (`--config=a.json --config a.json`), the same value twice included, and a second value the option refuses on its own (`scan --format json --format bogus`, `diff … --max-bytes 1000 --max-bytes 0`) | exit 2, `<option> is given more than once ("<first>", then "<second>"): pass one` on stderr, nothing on stdout, nothing written, and an earlier report left as it was. With the invalid value first (`scan --format bogus --format json`), that value's own error instead, at exit 2. `aburi scan --compact --compact` and `--no-timestamp --no-timestamp` run and exit 0; `--ignore a/** --ignore b/**` leaves out the files under both and exits 0; `--respect-gitignore` and `--no-respect-gitignore` together, in either order, over a config that sets `respectGitignore: false`: the one written last applies |
| CL41 | An empty value for any option that takes a path — `init --output`; `scan --output-dir`, `--config`; `diff --base`, `--head`, `--output-dir`, `--config`; `explain --ir`, `--output`, `--config` — in either spelling (`--output-dir=`) | exit 2, `error: option '<option> <path>' argument '' is invalid. a path must not be empty` on stderr, nothing on stdout, nothing written, and an earlier report left as it was |
| CL42 | `aburi diff main..HEAD --base b.json`, or `aburi diff main..HEAD --head h.json` | exit 2, `<option> cannot be combined with a ref spec argument. Use one or the other.`, naming the option given |
| CL43 | `aburi scan` after one Component was renamed and another removed | The page of each id the IR no longer holds is removed, with LF or CRLF line endings, and on a filesystem that returns a few bytes per read; nothing else in `components/` goes. A file beside them that is not such a page stays: another extension, a first line naming another id or none, the heading with more on its line, a name no Component id takes, the same page in a subdirectory, or a directory named like a page |
| CL44 | `aburi scan --format json` or `--format md` after an `aburi scan` that wrote both | Only what the format writes is left of Aburi's files: no `workspace.md` or component page under `json`, no `aburi.ir.json` under `md`, and so `aburi explain --no-rescan` exits 2 rather than answering from the earlier IR. The caller's files in the output directory and in `components/` stay. At `--log-level info`, one `info:` line names each file removed, the discovered-vocabulary record a strict scan removes included; at the default level, none |
| CL45 | `aburi scan --format md` with a directory at `aburi.ir.json`, `--format json` with one at `workspace.md`, or a scan where the process may not remove a component page, list `components/` or read a stale page | exit 2 for a directory, naming the artefact, its path, that a directory stands where an earlier run's file would be, and `--output-dir`; exit 1 for the rest, naming the step that failed (remove, list or read), the page's component or the components directory, its path and the errno |
| CL46 | A strict `aburi scan` stopping at an undeclared value (exit 3) after one that completed, or an `aburi scan --format md` stopping at a directory where `workspace.md` would go (exit 2) after an `aburi scan --format json` | The earlier run's IR, `workspace.md` and component pages are left as they were |
| CL47 | `aburi explain <name>` with no IR on disk, after `aburi scan --format md`; `runScan` with `command: "explain"` or `"diff"` and `format: "md"`, after an `aburi scan` that wrote both beside a stale page | The scan it runs writes the IR beside the pages and removes none of them; the `runScan` call removes nothing, neither the IR nor the stale page |
| CL48 | `aburi diff … --format json` or `--format md` after an `aburi diff --max-bytes` that wrote `diff.full.md` | Only the files that run writes are left of the report: no `diff.md` naming a `diff.full.md` that is gone, no earlier `diff.json`. The caller's own file in the output directory stays |
| CL51 | `aburi scan` or `aburi init` in a workspace holding a directory the process may not list, whether the component census or discovery reaches it first | exit 1, with `Directory "<path>" could not be listed` and the errno on stderr. With `.gitignore` excluding that directory, `aburi scan` exits 0 and the IR holds the rest of the workspace |

## 18. Design Decisions

### 18.1 Limiting Status-Class Exit Codes to Three

Only the four values 0 / 1 / 2 / 3. Respects Linux convention while reserving code 3 for the CI gate (`--fail-on`).
Finer-grained exit codes increase the burden on consumers, so they are avoided.

### 18.2 Strict stdout / stderr Separation

To avoid confusion when CI uses `2>/dev/null` or `> result.txt`, all progress and warnings go to stderr.
Only result data (summary / JSON / Markdown) goes to stdout.

### 18.3 Why `--fail-on` Ships from the Start

A CI gate is the feature that delivers the most value at review adoption time. Once "automatically block PRs with dangerous changes" works, Aburi adoption accelerates sharply. Retrofitting it would require rewriting CI configurations, so it is provided from the start.

### 18.4 Why `aburi diff` Uses git worktree

Checking out the base ref would require stashing the current work, risking accidental loss of uncommitted changes. With git worktree, the base can be materialized at a separate path while the head's working directory is preserved, its index included, which is why a diff run from a commit hook does not hand `git worktree add` the index being committed (§6.4.3).

### 18.5 Partial Matching in `aburi explain`

Typing the full id every time is burdensome. Returning candidates on a partial match and disambiguating when there are several is the practical UX.
In the majority of cases without ID collisions there is 1 hit; ambiguity is an explicit error.

### 18.6 Why `aburi vocab` Is a Standalone Subcommand

Vocab is a query target independent of the IR. A standalone `aburi vocab` command has higher discoverability than a flag like `aburi scan --show-vocab` (it also appears on its own in the help output).

### 18.7 Why Environment Variables Substitute for CLI Flags

In CI / Docker / Makefiles, configuring via env is easier than threading flags through. Standard conventions (`NO_COLOR` / `CI`) are respected, and Aburi-specific envs (`ABURI_*`) are provided as well.

### 18.8 Why Planned Features Are Reserved

Reserving the names `aburi watch` / `aburi doctor` / `aburi serve` today prevents name collisions and compatibility breaks when they are added later. They are not implemented, but are documented.
