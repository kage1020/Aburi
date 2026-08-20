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

Available on every command:

| Option | Short | Meaning |
|---|---|---|
| `--cwd <path>` | — | Change the working directory (origin for config resolution) |
| `--config <path>` | — | Explicitly specify the config file location |
| `--log-level <level>` | — | `debug` / `info` / `warn` / `error` (default: `info`) |
| `--no-color` | — | Disable colored output |
| `--help` | `-h` | Show command-specific help |

Top-level only:
| Option | Short | Meaning |
|---|---|---|
| `--version` | `-v` | Show version |

## 4. `aburi init`

Generates `aburi.json` from autodetect results.

### 4.1 Signature

```
aburi init [--output <path>] [--force] [--with-suggestions]
```

### 4.2 Options

| Option | Meaning |
|---|---|
| `--output <path>` | Output destination (default: `./aburi.json`) |
| `--force` | Overwrite an existing file |
| `--with-suggestions` | Include enable candidates for plugins matching detected frameworks as JSONC comments |

### 4.3 Behavior

1. Detect the workspace root ([`component-detect.md`](./component-detect.md) §2.1)
2. Run each detector (§3)
3. Convert results into Component candidates
4. Generate JSON and write it to `--output`
5. Print a summary to stdout

### 4.4 When the File Already Exists

- Without `--force` → exit with an error (exit 2): `Use --force or specify another path`
- With `--force` → overwrite; warning goes to stderr

### 4.5 Exit Codes

| code | Meaning |
|---|---|
| 0 | Generation succeeded |
| 1 | Autodetect failure (permissions, etc.) |
| 2 | Existing file present without `--force`, or invalid `--output` |

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
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
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
           [--no-respect-gitignore]
           [--ignore <glob>]
```

### 5.2 Options

| Option | Meaning |
|---|---|
| `--output-dir <path>` | Output directory (default: `config.output.dir` or `out`) |
| `--format <json\|md\|both>` | Output format (default: `both`) |
| `--no-md` | Shortcut for `--format json` |
| `--no-json` | Shortcut for `--format md` |
| `--strict` / `--no-strict` | Override `config.strict` |
| `--discover` | `--no-strict` + record undeclared vocab to `out/aburi-vocab-discovered.json` |
| `--quiet` | Suppress progress output; stdout carries the final summary only |
| `--compact` | Compact the JSON to a single line |
| `--concurrency <n>` | Parser concurrency (default: CPU - 1) |
| `--no-respect-gitignore` | Equivalent to `config.respectGitignore: false` |
| `--ignore <glob>` | Append to `config.ignore[]` (repeatable) |

### 5.3 Behavior

1. Resolve the config
2. Load plugins and build the registry
3. Walk the workspace, parsing each file in parallel
4. Extraction pipeline: drop list → tag propagation → effect classification → fingerprint → Symbol finalization
5. Write `<output-dir>/ir.json` + `<output-dir>/workspace.md` + `<output-dir>/components/*.md`
6. Print a one-line final summary to stdout

### 5.4 Exit Codes

| code | Meaning |
|---|---|
| 0 | Extraction succeeded |
| 1 | Extraction error — a file the scan could not read. A source file that is simply *gone* by the time the scan reads it is skipped rather than fatal — a concurrent build can do that, and a rerun is the fix — but a permission, descriptor or IO failure still ends the run, because absorbing it would let the same commit produce a different Document on a different day. A file the language plugin *could* read and refused to parse is not this: it is withdrawn and the code stays `0` (lang-plugin.md §7.1) |
| 2 | Config error (schema violation, resolution failure) |
| 3 | Plugin error (load failure, manifest violation, a plugin exception that withdrew a file, undeclared vocab detected in strict mode) |

### 5.5 stdout Example

```
✓ Loaded 3 plugins (1 lang, 1 framework, 1 effects)
✓ Parsed 1234 files in 12.4s
✓ Extracted 542 kept · 87 dropped symbols
✓ Wrote out/ir.json + out/workspace.md + 3 component files
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
⚠ Config /repo/apps/web/aburi.json sits below the workspace root /repo. …
⚠ 3 file(s) had recoverable parse errors.
⚠ 1 file(s) could not be parsed and were left out of the IR.
⚠ 5 file(s) contributed no Symbols: over-size=3, parse-failed=1, extraction-failed=1
⚠ over-size (3) — larger than maxFileSizeBytes. Raise the budget, or leave them out with ignore.
    vendor/bundle.js: 2100000 > 1048576
    vendor/legacy.js: 1400000 > 1048576
    public/data.js: 1100000 > 1048576
⚠ parse-failed (1) — the language plugin refused the source. Deterministic: fix the file, or the plugin.
    src/broken.ts: parse reported a non-recoverable error at 12:4 — unterminated string
⚠ extraction-failed (1) — a plugin threw while extracting. This is the reason the run does not exit clean.
    src/route.ts: qualified name "{ GET, POST }" contains the non-identifier segment "{ GET, POST }"
```

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
`parse-timeout` at `parseTimeoutMs` and a re-run, `unreadable` at permissions or a tree that was
changing under the scan, `unroutable` at a bug in the plugin set, `parse-failed` at the source,
`extraction-failed` at the plugin — and one neutral line said none of it. The re-run /
fix-something split is the one `SkippedFile.reason` draws in the IR schema.

Reasons appear in a fixed order — `over-size`, `unreadable`, `unroutable`, `parse-failed`,
`parse-timeout`, `extraction-failed` — in the census and in the groups alike, so the groups
arrive in the order the census named them and neither depends on where in the workspace the
losses happened to sit.

The listing is capped at ten files **per reason**, with a "…and N more" tail. Per reason rather
than across the whole listing because one shared budget belongs to whichever reason lost the
most files, and that is not the reason a reader most needs named: a hundred over-size files
would push the one file a plugin threw on — the only reason that moves the exit code to `3`
(§5.4) — inside the tail, leaving a non-zero status with nothing on screen to account for it.
Every other reason leaves the code at `0`.

`extraction-failed` is listed by that rule like any other reason rather than by one of its own.
Its files were listed twice while it had its own clause: the message a plugin threw with is
written to both `skipped[].detail` and `extractionFailures[].message` at a single site in the
scan. `ScanReport.extractionFailures` is unchanged — it still carries the error's `code`, and it
is still what decides the exit code and what the `diff` fault clause counts.

Where the lines come from is part of the contract. `runScan` writes them to a sink its caller
supplies, so all three commands that scan report them, rather than one command's wrapper
printing them while the other two discard the report. A caller that supplies no sink gets no
incident report.

That is not the same as silence. The run's `Logger` is a separate channel — per file rather
than per run, governed by `ABURI_LOG_LEVEL` (§11), and still writing to `process.stderr`
whatever streams the caller injected. An embedded scan with no sink is quiet, not mute, and
routing that channel to the caller is a known gap rather than something this contract covers.
It is also why the files above are listed by the CLI itself rather than left to that channel:
at `ABURI_LOG_LEVEL=error` the per-file lines are gone, and for `over-size`, `unroutable` and an
`unreadable` raised during discovery there is no `Logger` line to lose — those three are decided
before extraction and are not logged at all, so the report is their only account.

A command that runs more than one scan labels them, after the glyph, with the scan the line
came from:

```
⚠ base ref "main": 3 file(s) had recoverable parse errors.
```

`⚠` starts every line that stands on its own. The only lines without it are the indented
per-file listing and its `…and N more` tail, which belong to the line above them and are
attributed by it.

The warnings precede the stdout summary in a merged view (a terminal, `2>&1`, an Actions log),
where before the reporting moved they followed it. Deliberate: the last thing on screen is then
the kept / dropped line and the artifact paths, which is the part a reader acts on.

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
| `--head <path>` | Head IR file path |
| `--output-dir <path>` | Destination for diff.json / diff.md |
| `--format <json\|md\|both>` | Output format |
| `--filter <kinds>` | Comma-separated restriction to change kinds (`added,removed,changed,moved,moved+changed`) |
| `--fail-on <kinds>` | Exit 3 if even one change of the given kinds (status granularity) exists (for CI gates) |
| `--quiet` | Limit stdout to a single final summary line |

### 6.3 Arguments

Ref forms:
- `main..HEAD` — base=main, head=HEAD
- `v1.2.0..v1.3.0` — tag comparison
- `abc123..def456` — direct commit specification

If git is unavailable, pass existing IR files via the `--base / --head` pair.

### 6.4 Behavior

With refs:
1. **Pre-validation** (§6.4.1)
2. Create a temporary git worktree and check out the base ref
3. Run `aburi scan` on the base and store the IR temporarily
   - **Config used**: apply the **head-side `aburi.json`** to the base scan as well (the base is interpreted through the head's view; a stale config remaining in the base is ignored)
   - Rationale: using the config as of the base ref would make "config change = the entire IR changes", breaking the diff. Fixing the view to the head automatically resolves config differences
   - A future `--base-config <path>` may be provided to override this (planned — see the [roadmap](../roadmap.md))
4. Run `aburi scan` on the head (the original cwd)
5. Compare the two IRs and compute the diff ([`diff-algorithm.md`](./diff-algorithm.md))
6. Write `<output-dir>/diff.json` + `<output-dir>/diff.md`
7. Print a one-line summary to stdout
8. Clean up the worktree

With file inputs: skip steps 1-3 and start at step 5.

### 6.4.1 Git Pre-Validation (Ref Form)

Before creating the worktree, the following checks run in order; on failure, exit 1 with a concrete remediation message on stderr:

| Check | Failure message |
|---|---|
| `git rev-parse <base>` succeeds | `Base ref '<base>' not found. If this is a CI shallow clone, run: git fetch --deepen=50 origin <base>` |
| Repository is not shallow (`git rev-parse --is-shallow-repository` is `false`) | `Repository is shallow. aburi diff requires base ref history. Run: git fetch --unshallow` |
| Sparse-checkout is disabled (`git config core.sparseCheckout` is `false` or unset) | `Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable` |
| `git submodule status` is empty (submodules are not yet supported) | `Submodules detected: <list>. Submodule-aware diff is not yet supported.` (warning; continue) |
| On Windows, trial-check whether the base ref contains symbolic links | `Symbolic links in working tree may fail to materialize in worktree on Windows.` (warning; continue) |

#### 6.4.1.5 Plugin Dependency Resolution at the Base Ref

When scanning the base ref for `aburi diff <base>..<head>`, Aburi **shares the head's `node_modules`** (the worktree only materializes the base sources at a separate path; dependency resolution uses the original cwd's `node_modules`).

- **Rationale**: since §6.4 decided to "apply the head's `aburi.json` to the base scan as well", the plugin set also comes from the head. Reinstalling from the base ref's `package.json` for the base scan would explode build time, and `--frozen-lockfile` does not work on shallow clones
- **Known limitation**: when the base ref's sources cannot be extracted with the head's plugins (e.g. the base uses syntax from an older framework version and the head's framework plugin only supports the newer one), parsing/extraction may fail
  - This is a consequence of the "IR generator is pinned to the head environment" design
  - On failure, the affected file is skipped with a warning log
- The request "apply the base ref's contemporaneous plugin set" is under consideration as `--base-plugins <path>` for a future release (see the [roadmap](../roadmap.md))

#### 6.4.2 GitHub Actions Guidance

Required setup when using `aburi diff` in CI:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0    # full history (aburi diff fails on shallow clones)
```

Or `fetch-depth: 50` or more, at a depth that includes the base ref. The default of `1` cannot be used.

### 6.5 Exit Codes

| code | Meaning |
|---|---|
| 0 | Diff computed successfully (regardless of whether differences exist) |
| 1 | Computation error (invalid IR, git error) |
| 2 | Argument error (`<base>..<head>` syntax violation; one of `--base/--head` missing) |
| 3 | Changes matching `--fail-on` were detected (CI gate), or one of the two scans this command ran did not exit clean (§5.6) |

The second cause is about greenness, not about counts. A file a plugin threw on is recorded in
`stats.skippedFiles`, so its Symbols already classify as `unknown` rather than as deletions and
the diff overstates nothing. The exit code is what would be wrong: the same workspace makes
`aburi scan` exit `3`, and asking it for a diff instead must not turn it green.

A fault at the **base** ref gates as well. That is a policy rather than a side effect, and it
has a cost — a broken base reddens every diff taken against it until the base moves — but a
comparison with a broken half is not evidence about the half that worked.

It gates on the scan's exit code, not on a named incident. A plugin exception is the only reason
that reaches it today and §5.4 leaves open that others may follow; the diagnostic wording is
derived from what the scan actually reported, so a second reason arrives with the code right and
the message still true.

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

A file skipped by **both** scans produces no `unknown` entry — there are no Symbols from it in either document, so the matcher has no leftover to classify. It is reported at document level instead: `diff.json` carries the path and each scan's reason in `notCompared[]`, and `diff.md` lists it under `## 🚫 Not compared` ([`diff-algorithm.md`](./diff-algorithm.md) §6.3). The stderr line stays, deliberately shorter than the artifact — a count and a capped list of paths, no reasons — because it is the cover note for whoever is watching the command, and a terminal line that grows with the size of a workspace's blind spot stops being read.

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
`extraction-failed`, so file mode can see that a plugin threw when a document was written even
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
| Delta granularity | `api-changed` / `logic-changed` / `syntax-changed` |
| Direction granularity | `dropped-toggled:to-dropped` / `dropped-toggled:to-kept` |
| Count threshold | `<value>:><N>` (e.g. `dropped-toggled:>10` fires when the count exceeds 10) |

Multiple values may be given, comma-separated.

#### Uses of Direction-Specific fail-on

`--fail-on dropped-toggled:to-kept` detects "symbols previously treated as dropped became kept". Useful for deliberate review of drop-rule relaxation.
The inverse, `dropped-toggled:to-dropped`, detects "symbols that were kept became dropped" (e.g. checking the blast radius of a DTO consolidation).

#### Uses of Count Thresholds

In cases where a drop-rule change legitimately fires `dropped-toggled` in bulk (e.g. changing all DTOs), a plain `--fail-on dropped-toggled` misfires. A threshold such as `--fail-on dropped-toggled:>50` — "block only when there are more than 50" — is the practical choice.

#### Evaluation Rules

- Status granularity (`changed`, etc.): fires if even one Symbol has the given status
- Delta granularity (`api-changed`, etc.): fires if even one Symbol has status `changed` or `moved+changed` with the corresponding `delta.<axis>Changed: true`

Examples:

```bash
aburi diff main..HEAD --fail-on api-changed
# exit 3 if even one symbol has delta.apiChanged: true
# changed symbols where only logic changed, and moved (status only), have no effect

aburi diff main..HEAD --fail-on api-changed,removed,dropped-toggled
# fires on API change OR removal OR drop-rule fluctuation
```

This allows fine-grained CI gates, making operational policies such as "only API changes require approval, logic changes are warnings" possible today.

## 7. `aburi explain`

Shows details of a single Symbol / file / pattern match.

### 7.1 Signature

```
aburi explain <id-or-pattern> [--output <path>] [--ir <path>] [--no-rescan] [--debug-resolution]
```

### 7.2 Arguments

`<id-or-pattern>` is one of:
- **Full Symbol id** — the string contains `#` and matches the `<language>:<path>#<qname>` form → direct lookup
- **File path** — the string contains `/`, contains no `#`, and either is an existing file or is a path the IR names in `stats.skippedFiles` (§7.6) → show all Symbols in that file
- **Partial-match pattern** — anything not matching the above → collect candidates by **case-sensitive substring match** against each Symbol's qualified name (`Symbol.name`)

#### 7.2.1 Exact Definition of Partial Matching

- **case-sensitive** (`getUser` and `getuser` are distinct)
- **substring match** on `Symbol.name` only (= a partial match against the whole qualified name; `Service.create` hits `InvoiceService.createInvoice`)
- **no glob support** (patterns like `*Service` are under consideration for a future release — see the [roadmap](../roadmap.md))
- If multiple candidates match, exit 2 + candidate list on stdout

### 7.3 Options

| Option | Meaning |
|---|---|
| `--output <path>` | Write to a file (default: stdout) |
| `--ir <path>` | Use an existing IR file (default: `out/ir.json`, or trigger a scan if missing) |
| `--no-rescan` | Do not rescan even if the IR file is stale |
| `--debug-resolution` | Append a `## Call resolution` table: one row per call site with the resolved callee, or the [`call-resolution.md`](./call-resolution.md) §8.1 bucket that explains the `null`, plus the competing candidates for `ambiguous`. Those buckets are per-run diagnostics that the IR deliberately does not persist, so the flag **always rescans** and is rejected (exit 2) alongside `--no-rescan` or `--ir`. It is a reporting flag, not a tuning knob — no IR or diff content changes |

### 7.4 Behavior

1. Read the IR (invoke `aburi scan` internally if missing)
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
| 2 | Multiple candidates; disambiguation required |
| 3 | The answer would not be safe: the scan this command ran did not exit clean (§5.6), or the document names the file the question asked about as one it never analysed (§7.6) |

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

128+N is for fatal signals (Aburi itself does not use it).

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
| `ABURI_LOG_LEVEL` | Equivalent to --log-level |
| `NO_COLOR` | If set, disable coloring (standard convention) |
| `FORCE_COLOR` | If set, force coloring on (standard convention) |
| `CI` | If set, CI mode (§12) |

Precedence: CLI flags > environment variables > config file.

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
5. Repeat 3-4 recursively in parent directories (up to the workspace root)
6. autodetect (works with no config present)
```

Passing `--cwd` changes the cwd and therefore the search origin.

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
  --cwd <path>           Set working directory
  --config <path>        Override config file location
  --log-level <level>    debug | info | warn | error
  --no-color             Disable colored output
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
| CL9 | `aburi diff main..HEAD --fail-on changed` with changes | exit 3 |
| CL10 | `aburi diff` with missing arguments | exit 2 |
| CL11 | `aburi explain <ambiguous>` | exit 2, candidate list on stdout |
| CL12 | `aburi vocab who-owns <unknown>` | exit 1 |
| CL13 | `aburi vocab list --json` | machine-readable JSON, exit 0 |
| CL14 | Piping stdout (`aburi scan --quiet | wc -l`) | Readable without escape sequences |
| CL15 | `NO_COLOR=1 aburi scan` | No coloring |
| CL16 | `CI=true aburi scan` | Progress animation suppressed |
| CL17 | `--log-level debug aburi diff` on error | Stack trace on stderr |
| CL18 | `aburi --config ./custom.json scan` | Uses the specified config |
| CL19 | `aburi explain <name>` where a plugin threw during the rescan | exit 3, incident lines on stderr |
| CL20 | `aburi diff main..HEAD` where a plugin threw at the base ref | exit 3 with no `--fail-on` clause, base-labelled lines on stderr |
| CL21 | `aburi explain src/route.ts --ir <ir>` where that IR names `src/route.ts` in `stats.skippedFiles` | exit 3, the file and its skip reason on stderr, nothing on stdout |
| CL22 | `aburi explain <pattern>` with no match, against an IR that skipped files | exit 1, `No matches` plus a line counting them |

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

Checking out the base ref would require stashing the current work, risking accidental loss of uncommitted changes. With git worktree, the base can be materialized at a separate path while the head's working directory is preserved.

### 18.5 Partial Matching in `aburi explain`

Typing the full id every time is burdensome. Returning candidates on a partial match and disambiguating when there are several is the practical UX.
In the majority of cases without ID collisions there is 1 hit; ambiguity is an explicit error.

### 18.6 Why `aburi vocab` Is a Standalone Subcommand

Vocab is a query target independent of the IR. A standalone `aburi vocab` command has higher discoverability than a flag like `aburi scan --show-vocab` (it also appears on its own in the help output).

### 18.7 Why Environment Variables Substitute for CLI Flags

In CI / Docker / Makefiles, configuring via env is easier than threading flags through. Standard conventions (`NO_COLOR` / `CI`) are respected, and Aburi-specific envs (`ABURI_*`) are provided as well.

### 18.8 Why Planned Features Are Reserved

Reserving the names `aburi watch` / `aburi doctor` / `aburi serve` today prevents name collisions and compatibility breaks when they are added later. They are not implemented, but are documented.
