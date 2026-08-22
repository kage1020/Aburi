# @aburi/cli

## 0.3.0

### Minor Changes

- 309f093: Withdraw the file a plugin threw on, instead of the whole run

  `lang-plugin.md` §7.2 has always said what should happen when extraction throws:

  > - If `extractSymbols` / `walkBody` / `normalizeAst` throws → skip the entire file, warning log
  > - The extraction pipeline as a whole does not stop (prevents one file's bug from halting all IR generation)

  Neither `scan.ts` nor `pipeline.ts` contained a single `try`, so it never did. One throw
  discarded every file's results and the run produced no IR at all:

  ```ts
  // src/route.ts — an Auth.js route file, and legal TypeScript
  export const { GET, POST } = handlers;
  ```

  The destructuring pattern's text reaches `makeSymbolId` as a qualified name, the id grammar
  refuses it, and `scan()` exits non-zero having written nothing. A `src/ok.ts` beside it produces
  nothing either; delete the one file and the same run succeeds.

  ## What happens instead

  Any plugin call that throws for a file — `parseFile`, `extractSymbols`, `walkBody`,
  `normalizeAst`, a framework `classifySymbol`, an effect `classify` — withdraws that file. The
  run continues, and the file is accounted for twice:

  - `ScanResult.skipped` gains `reason: "extraction-failed"`, so it is named in the list that
    answers "why is this file missing from the IR";
  - `ScanResult.extractionFailures` is a new `{ file, message, code? }[]` carrying what the plugin
    actually said, the way `parseTimeouts` carries numbers `skipped` has nowhere to put. The CLI
    lists the first ten on stderr with the file and the message, capped so a plugin that rejects
    every file cannot scroll the rest of a CI log away.

  A file that is _gone_ by the time the scan reads it — discovery lists the workspace up front, and
  a concurrent build can delete a listed path before the loop reaches it — is skipped as
  `"unreadable"`, the reason discovery already uses for the same condition, rather than ending the
  run as it did before. **Every other read failure still ends the run**: a permission the checkout
  got wrong, an exhausted descriptor table, failing storage. Those depend on how the machine was
  feeling, and absorbing them would let one commit produce a different Document on a different day
  and still exit 0, which is the opposite of what a byte-stable canonical document is for.

  Unlike a file abandoned for its `parseTimeoutMs` budget, a thrown file loses its recoverable
  parse errors: the pipeline result never materialized. The thrown message stands in for them.

  ## Some throws are still fatal

  An error whose code names a fault in the plugin _set_ rather than in the file propagates and ends
  the run:

  - `scan-plugin-misconfigured` — an effect plugin returning a Promise from the synchronous
    `classify`, a language plugin emitting Symbol ids with no language prefix at all;
  - `invalid-language-id` — the prefix is present but is not a legal `LanguageId`, which comes from
    the plugin's own `languageId` and so is the same on every Symbol it emits;
  - `vocab-undeclared` — an effect or extKind id the emitting plugin's manifest does not claim.

  Each repeats for every file, so absorbing them would report the workspace as broken instead of
  the plugin, and would replace one precise sentence about the manifest with a file count.

  Everything else describes the file and is absorbed: `anonymous-symbol-id-attempted` and
  `invalid-symbol-id` come from what a declaration is named, `non-posix-path` from where it lives.
  The check reads the error's `code` rather than its class, because `vocab-undeclared` is a
  `RegistryError` and `@aburi/core` does not depend on `@aburi/plugin-registry`.

  A plugin-wide bug carrying none of those codes now presents as one failure per file rather than
  one crash. That is the intended shape rather than a regression — every file named, the messages
  identical, the count the whole workspace — though it is a weaker diagnostic than a code that says
  outright what is wrong.

  `ScanResult.extractionFailures[].code` carries the thrown error's own code where it had one, so a
  consumer can separate "this source is something the plugins cannot express" from "a plugin
  crashed" without matching on prose.

  ## `aburi scan` exits 3 when a file was dropped this way

  Without this the change would be a loudness regression: a guard firing would go from "exit 1, no
  output" to "exit 0, output written, a line on stderr". `cli-spec.md` §5.4 already assigns `3` to
  a plugin error for `scan`, and a reviewer now gets both the partial IR _and_ a non-zero code,
  where a thrown guard previously gave them neither.

  The scope is exactly `extractionFailures`. Over-size, unroutable and timed-out files keep exiting
  `0` — whether they should gate, and behind what threshold, is a separate open question.

  `ScanReport` gains `extractionFailures`, and the stderr block names the count on its own line so
  a reader handed a non-zero status can tell which of the counts earned it.

  ## Contracts restated rather than changed

  `effect-plugin.md` EP3a and the `plugin-input` guards said a contract violation "fails the scan".
  It now fails the _file_. EP3a's reason for refusing to degrade — that a silently unclassified
  call turns a parser bug into a quietly under-populated IR — is untouched by this: a withdrawn
  file is counted, named, quoted back with the guard's own message, and reflected in the exit code.
  Silence was the objection, and there is none here.

  `SkippedFile.reason` widens by one member, which is breaking for an exhaustive `switch` over it.

  ## Two things this makes visible rather than fixes

  A withdrawn file leaves no trace **inside** the IR. `skipped` and `extractionFailures` are
  siblings of `ir`, not part of it, so `out/aburi.ir.json` records only that `parsedFiles` is below
  `totalFiles` — the same gap an over-size file leaves. A `diff` against a healthy baseline
  therefore reports the withdrawn file's Symbols as `removed`, and `--fail-on removed` trips with
  the wrong explanation. Before this change there was no IR to be misled by; now there is a
  complete-looking partial one, and the exit code is the only signal, which does not travel with
  the artifact. The other withdrawal reasons have the same hole and have had it all along.
  Tracked separately.

  `export const { GET, POST } = handlers` — an ordinary Auth.js route file — is a reachable trigger,
  so a repository containing one now exits 3 on every scan where it previously exited 1. The gate is
  reporting a real loss rather than causing one, and the remedy is the id-grammar bug behind it
  rather than this boundary.

- 4c2d5aa: Record what the scan lost, and stop calling it removed API

  A file the scan gave up on left no trace **inside** the IR. `ScanResult.skipped` and
  `ScanResult.extractionFailures` are siblings of `ir`, and `writeCanonicalIR` serialises `ir`
  alone, so `out/aburi.ir.json` said only that `parsedFiles` was below `totalFiles` — which is
  equally true of an over-size file, a timed-out one and a withdrawn one, and names none of
  them.

  The next `aburi diff` then read every Symbol in that file as deliberately deleted API:

  ```
  scan @ main       → 400 symbols
  scan @ PR branch  → src/route.ts withdrawn, 380 symbols
  aburi diff        → 20 symbols "removed"
  --fail-on removed → trips, reporting an API deletion nobody made
  ```

  The scan's exit code was the only signal, and an exit code does not travel with the
  artifact. `parse-timeout` was the sharpest case: whether a file times out depends on how
  loaded the machine was, so the same commit produced the phantom on one run and not the next.

  ## `stats.skippedFiles[]`

  The Document now names them: `{ path, reason }[]`, sorted by path, one entry per file the
  scan stopped working on, whatever stopped it. The name is the one `component-detect.md`,
  `drop-list.md` and `lang-plugin.md` have each pointed at as planned.

  Class B per `ir-schema.md` §1.1 — the key is omitted when nothing was lost, so its presence
  answers "did this run drop anything" on its own, and absence _with_ `totalFiles > parsedFiles`
  identifies a document written before the field rather than a clean run.

  **No `detail`.** The scan carries one per entry — the size, the elapsed, the message a plugin
  refused the file with — but the `unreadable` detail is an OS error message containing the
  **absolute** path, and a canonical document whose bytes depend on where the repository was
  checked out is not the byte-stable artifact everything downstream assumes.

  Integrity **invariant #21**: when present, `skippedFiles.length === totalFiles - parsedFiles`
  and no path appears twice. This is a **read-side** check — inside Aburi's own scan both sides
  reduce to the same sum of the same two counts, so it cannot fire on a document Aburi wrote.
  What it guards is a document arriving through `readIR`, hand-edited or from another generator,
  that `aburi diff` is about to read to decide an absent Symbol is a loss rather than a deletion.
  Conditional on presence, because a document that predates the field cannot satisfy it and its
  absence is itself the answer.

  It does not cover a file that parsed successfully and yielded no Symbols: counted in
  `parsedFiles`, in no array, satisfying the check, and its Symbols still reported as removed.
  Withdrawal takes a plugin saying so, so a plugin that swallows its own error and returns an
  empty Symbol list withdraws nothing.

  `workspace.md` gains a "Files not analysed" section grouping the paths by reason, so a reader
  holding only the Markdown sees the same thing.

  ## `status: "unknown"`

  `aburi diff` reads that list. A leftover Symbol whose `source.file` the _other_ document never
  analysed is no longer `removed` (or `added`) but `unknown`, carrying `absentFrom` — the
  document that lost the file, so `head` reads as "this may still exist" and `base` as "this may
  not be new" — and the skip `reason`, which is what decides the reader's next move.

  Three properties this rests on:

  - **Classified after the five matching stages, never before.** A Symbol that moved _out of_ a
    lost file into a file the other document has is matched by stage 3 or 4 and stays `moved` —
    that document holds real evidence for it. Filtering the base list up front would throw the
    answer away.
  - **Both directions.** A file fine at head and withdrawn at base makes phantom `added` entries
    exactly as the reverse makes phantom `removed` ones.
  - **`dropped` leftovers keep their counters.** They produce no `symbols[]` entry on either
    side today and nothing gates on them, so `droppedAdded` / `droppedRemoved` still count them
    rather than gaining entries where there were none. Stated rather than silently different.

  A status of its own rather than the alternatives: suppression hides a Symbol that may
  genuinely have been deleted, and `removed` plus a flag shows an API deletion to every reader
  that does not know to look — including `--fail-on removed`, which is the whole reason the
  phantom mattered.

  `SymbolChange` gains a member, which is breaking for an exhaustive `switch` over `status`.
  `Summary.unknown` is optional rather than required, so a diff written before the counter stays
  schema-valid; `--fail-on unknown` counts the entries rather than reading it, so the gate
  answers about the document rather than about which writer produced it.

  ## What a reader sees

  ```
  ⚠ head IR reports 3 file(s) it did not parse but has no stats.skippedFiles to name them, …
  ```

  when a document dropped files but predates the field. `buildDiff` cannot invent the list —
  inferring it from `totalFiles > parsedFiles` would attach the doubt to whichever Symbols
  happened to be missing — so it reports what it can see, and the CLI says what it could not
  check. Both sides are examined.

  `diff.md` gains an `❔ Unknown` section directly after Removed, naming the file, the side that
  lost it and why. **Both** summary lines — the word form in `diff.md` and the glyph form on
  stdout — grow `· ?N unknown` when there is one, and neither carries a permanent `?0` when there
  is not. The glyph line matters most: with `stats.skippedFiles` present on both sides the stderr
  warning cannot fire, so it is the only place a run that lost a file says so without
  `--fail-on unknown`. `aburi diff` now renders it through
  `@aburi/markdown-projection`'s `projectDiffSummaryLine` rather than a byte-identical private
  copy, which is how the two came to disagree.

  `workspace.md`'s header reports `parsedFiles` beside `totalFiles` whenever they differ, so a
  document that lost files but predates `stats.skippedFiles` no longer renders byte-identically
  to a clean scan — the projection is a pure function with no stderr to fall back on.

  A file skipped by **both** scans produces no `unknown` entry: neither document holds Symbols
  from it, so the matcher has no leftover to classify. Most skip reasons are deterministic
  properties of the file, which makes symmetric loss the ordinary case rather than the
  exceptional one, and the diff would otherwise look exactly like one that compared the file and
  found it unchanged. `aburi diff` names those paths on stderr, capped. Representing them inside
  `diff.json` is left open: the only thing to say about such a file is that neither side read it,
  which is a statement about the run rather than about a Symbol.

  ## Not closed by this

  `aburi scan` still exits `0` when a plugin refuses every file in the workspace — the document
  now says so, but nothing gates on it.

  `aburi explain` and `aburi diff` still discard the incident report of the scans they run
  themselves, so a Symbol in a file the scan refused is answered with `No matches` rather than
  with a reason.

  `dependencies[]` is projected from the call graph, so a lost file's Symbols take their edges
  with them and `summary.depsRemoved` reports exactly the confidently-wrong deletion this change
  fixed for `symbols[]`. `unknown` is a `symbols[]` status only.

  Each of the three is tracked as its own issue.

- ec9fc24: Report a scan's incidents from wherever the scan happened, and let its exit code out

  `aburi explain` and `aburi diff` run a full scan of their own and threw the report away. The
  incident reporting was called from one place — the `scan` command's action — so a file that was
  over-size, unroutable, unreadable, timed out, withdrawn by its parse, or dropped because a plugin
  threw was silently absent from what those two commands answered with. `ScanReport.exitCode` was
  discarded along with it, so not even the `extraction-failed` gate fired for them.

  On a fixture whose language plugin throws on one file and refuses another:

  ```
  $ aburi scan
  ⚠ 1 file(s) could not be parsed and were left out of the IR.
  ⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1
  ⚠ 1 file(s) were dropped because a plugin threw while extracting them.
      boom.stub: plugin exploded
  EXIT=3

  $ aburi explain bad_stub
  No matches for "bad_stub".
  EXIT=1                        # nothing on stderr about either file

  $ aburi diff main..HEAD
  +0 -0 ~0 ↔0 ⤴0
  EXIT=0                        # both scans hit the same plugin exception
  ```

  The reporting moves out of the command wrapper and into `runScan`, behind an optional
  `ScanOptions.incidents` sink. It is the scan's incident, so it belongs to the scan rather than to
  one of its three callers; a caller that supplies no sink gets no incident report. That is not the
  same as silence — the run's `Logger` is a separate, per-file, `ABURI_LOG_LEVEL`-governed channel
  that still writes to `process.stderr` whatever streams a caller injected, and routing it to the
  caller remains a known gap.

  `aburi diff` labels each of its two scans — `base ref "main"` and `head (working tree)` — because
  the same incident means different things at each end, and because §6.4 scans the working tree as
  the head whatever the ref spec calls it. The label sits after the glyph, so `⚠` starts every line
  that stands on its own; the only exceptions are the indented per-file listing and its
  `…and N more` tail, which belong to the line above them.

  Two visible side effects of the move:

  - In a merged view (terminal, `2>&1`, an Actions log) the warnings now precede the stdout summary
    where they used to follow it. Per-stream bytes are unchanged. Deliberate: the last thing on
    screen is then the kept / dropped line and the artifact paths.
  - The LSP request census gained the glyph and the label. It has its own condition and fires when
    neither LSP line above it did, so indented and glyphless it was the one warning `⚠` did not
    start — and the one nothing could attribute to a side in a two-scan diff.

  **The exit code is about greenness, not about counts.** Since `stats.skippedFiles` landed, a
  withdrawn file's Symbols classify as `unknown` rather than as deletions, so the diff was already
  honest about what it did not know. What was wrong is that a workspace no plugin can parse turned
  green by being asked for a diff instead of a scan. Both commands now inherit
  `ScanReport.exitCode`, so a scan that did not exit clean exits `3` from all three. The condition
  is the exit code rather than a named incident, and the diagnostic wording is derived from what the
  scan reported — so a second gating reason, which `runScan` says outright may come, arrives with
  the code right and the message still true.

  Three decisions worth naming rather than leaving to be inferred:

  - **A fault at the base ref gates too.** A broken base reddens every diff taken against it until
    the base moves. Concretely: the reachable trigger with the in-tree TypeScript plugin is
    `export const { GET, POST } = handlers`, and the throw comes from the core id grammar rather
    than from a third-party plugin. The GitHub Action propagates the status, so a repository using
    that idiom gets a red check with no `--fail-on` configured, and stays red until the base branch
    moves. That cost is real and the answer is still that a comparison with a broken half is not
    evidence about the half that worked — the fix is the id-grammar defect, which is filed.
  - **`--base` / `--head` warns and does not gate.** `stats.skippedFiles[].reason` persists
    `extraction-failed`, so file mode can see that a plugin threw when a document was written even
    though it never watched it happen, and it now names those paths. It does not fail: that fault
    had its exit code in the run that hit it, and failing here would red a job for someone else's
    incident on documents the caller pinned deliberately. `DiffReport.faultedScans` is `null` in
    this mode rather than empty, because "ran no scan" is not "ran two clean scans".
  - **For `explain`, exit `3` outranks the outcome.** A `single` hit may have had a competing
    candidate in the withdrawn file and should have been `2`; a `not-found` may be describing the
    withdrawal rather than the workspace. That last case is the headline one — `No matches` is
    otherwise indistinguishable from "that Symbol does not exist".

  `aburi diff` also gained a line with no counterpart in the artifact. A file whose parse reported
  _recoverable_ errors reached the IR rather than `stats.skippedFiles`, so nothing marks it and
  nothing about it becomes `unknown` — yet those errors may have cost it a declaration, leaving its
  Symbol set short and moving `added` / `removed` with no file having gone missing. Only ref mode
  can say this: `parseErrorCount` is a property of the scan, not of the document it wrote.

  Two robustness fixes fall out of the same reading. A sink that throws — `aburi scan 2>&1 | head -1`
  closes the pipe — can no longer turn the gate into a runtime error, because the report is complete
  and on disk by the time it is described. And the temporary-directory removal in `aburi diff`'s
  `finally` is caught and warned instead of replacing whatever exception was in flight with an fs
  error against a path the caller never named.

  Verification: 27 tests in `packages/cli/test/scan-incidents.test.ts`, driven by a language plugin
  the fixture writes into the workspace — no in-tree plugin will refuse a file or throw on demand.
  The ref-form tests materialise the base worktree for real from the injected `GitRunner`, so both
  scans have something to scan. One test pins `aburi scan`'s injected stderr byte-for-byte, which is
  what keeps the move from quietly changing what a reader sees; the lines the run's `Logger` writes
  to the real `process.stderr` land outside that capture, and the test says so.

- bc3816c: Discover `aburi.json` from `cwd`, not from the detected workspace root

  `runScan` handed the marker-detected workspace root to `loadConfig`, so discovery could
  only ever walk _upwards from the root_. A config below it — the normal case for a package
  inside a monorepo — was never read. The run then fell through to autodetect, resolved no
  language plugin, reported every file as unroutable, and wrote an empty IR at exit 0, which
  silently makes every downstream `--fail-on` gate pass.

  - `--config` **and `ABURI_CONFIG`** relative paths now resolve against `cwd`, matching
    `--output-dir`, `--base`, `--head`, `--ir`, `init --output` and `explain --output`. Both
    feed the same code path, so a CI job that exports a relative `ABURI_CONFIG` at the repo
    root and then changes directory reads a different file than before — if one exists there.
  - `ScanReport` gains `configSource` and `workspaceRoot`. Once discovery starts at `cwd`,
    which config won is no longer deducible from the arguments.
  - `aburi scan` warns on stderr when the config sits below the workspace root. Discovery is
    anchored to `cwd`, but everything inside the config — `ignore`, `components[].roots`,
    relative plugin refs — and file discovery itself are anchored to the workspace root, so a
    package-local `ignore: ["src/**"]` matches the _root's_ `src` and the scan still covers
    the whole workspace.

- c3654c3: Stop answering "No matches" out of an IR that says it never read the file

  `aburi explain` reports the incidents of a scan it runs itself. Reading an IR off disk it runs
  no scan, so there is nothing live to report — but the document it read carries
  `stats.skippedFiles`, and the answer ignored it:

  ```
  $ aburi scan
  ⚠ 1 file(s) could not be parsed and were left out of the IR.
  $ aburi explain handleRequest --ir out/aburi.ir.json
  No matches for "handleRequest".
  EXIT=1
  ```

  `src/route.ts` declares `handleRequest`, the IR says `src/route.ts` was never parsed, and the
  answer asserts the Symbol does not exist. Every fact needed to say otherwise was in the file
  that had just been read. `--ir` and `--no-rescan` exist so a CI job can question a pinned
  artifact without re-scanning, which is exactly the path where nobody is watching a live scan's
  stderr — so it is the path where the document has to speak for itself.

  **One principle decides every case.** The answer is `unknown` (exit 3) when the document
  positively identifies the file the question named as one it never analysed; it stays "not found"
  (exit 1) with a qualifying line when the doubt is diffuse. The id arm reads the `<path>` segment
  of the id, the file arm reads the argument, and the pattern arm names no file at all.

  ```
  $ aburi explain src/route.ts --ir out/aburi.ir.json
  Cannot answer "src/route.ts": this IR never analysed src/route.ts (parse-failed), so it cannot say what that file declares.
  EXIT=3
  ```

  Exit 3 already meant "this answer is not safe" — until now only because the scan this command
  ran did not exit clean. The second route says the same thing about different evidence, and it is
  narrower: the scan is intact, and only the question that named the withdrawn file is
  unanswerable.

  **What follows from the principle**

  - **The file arm no longer requires the path on disk**, only that the document names it in
    `stats.skippedFiles`. Requiring it locally would have dropped the motivating case — a pinned
    artifact read in a tree that need not hold the same files — into the pattern arm.
  - **The check runs on a miss only, so a hit is never qualified.** A hit is the document speaking
    about a Symbol it holds, and an `over-size` file is skipped by every run of a workspace, so
    caveating hits would caveat that workspace's every answer forever. This is also what answers
    an id whose `<path>` segment and `symbols[].source.file` disagree, as a re-export or a
    generated file produces: the Symbol is right there.
  - **The id arm asks the id grammar rather than the `#` it dispatches on.** `symbolIdFile` is new
    in `@aburi/core`, beside the grammar it runs, and returns `null` for anything `makeSymbolId`
    would have refused — so a typo that happens to contain a skipped path names no file and gets
    the diffuse line instead of a positive claim about coverage.
  - **A document predating `stats.skippedFiles` gets the diffuse line in every arm.**
    `totalFiles > parsedFiles` with no list can be counted but never tied to the file that was
    asked about. `aburi diff` warns about the same shape per side.
  - **The file arm's key is normalised into the space the document is in.**
    `stats.skippedFiles[].path` and `symbols[].source.file` are NFC by schema and by invariant
    #19; the argument is whatever the shell handed over, and a name carrying a combining mark
    survives an archive or a rename in decomposed form. Both of the arm's lookups key on that one
    string, so the same fix ends the older defect where a decomposed argument found none of a
    file's Symbols and was told it had no matches.

  The diffuse line is a count and a pointer at `stats.skippedFiles`, not a list. The question was
  about one Symbol; answering it with an inventory of the run buries it.

  **The library surface.** `ExplainOutcome` gains an `unknown` member whose `exitCode` is typed
  to the gate alone, and `not-found` gains a `coverage` field carrying either the lost entries
  themselves or, for a document that cannot name them, a count. Facts rather than prose: the
  wording lives in the CLI wrapper, the only layer that knows it is talking to a person, and the
  non-empty entry list is what keeps the number it prints from drifting from the list it
  describes. The wrapper's switch is exhaustive, so a later member is a type error rather than a
  command that exits on a code with nothing written to explain it.

  **`@aburi/core`.** `symbolIdFile` is new. Invariant #21 gains a clause that does not depend on
  `stats.skippedFiles` being present: `parsedFiles` never exceeds `totalFiles`. For a document
  that omits the list, the subtraction is the only trace of a loss there is — a reader taking a
  negative difference for a count reads it as "nothing was lost", which is the assertion of
  absence the enumeration exists to prevent, arrived at from the other side. A document with that
  shape is now refused by `readIR` instead of interpreted downstream; no Aburi scan can produce
  one.

  Verification: 28 tests in `packages/cli/test/explain-coverage.test.ts`, covering each arm on
  both sides of the principle, plus four in `@aburi/core` for `symbolIdFile`'s accept/reject table
  and the new invariant clause. Two exist for the miss-only rule: a Symbol whose id names a
  skipped file while its `source.file` names another, and a listed path that still carries the
  Symbols it was asked for. One pins that a live scan which withdrew a file benignly, and
  therefore stayed green, still reaches the new exit 3, with a control case proving the scan was
  green.

- da20510: Open a file by the name the filesystem gave it, not the one the Document records

  `toDocumentPath` normalizes a path to NFC on the way into the Document (ir-schema.md §1.2), and
  three sites then handed that normalized string back to the operating system: the `stat` in
  discovery, the `readFile` in the scan orchestrator, and the `file://` URI the LSP pass tells a
  language server to open. A filesystem that stores the name it was given — NTFS, ext4 — does not
  answer to the normalized spelling, so a file whose name was not already in NFC was reported
  `unreadable`, with an `ENOENT` naming a path almost but not quite the one on disk.

  `DiscoveredFile` now carries both: `path` for the Document and `fsPath` for whatever opens the
  file. Only `path` reaches a Symbol id, so nothing about the artifact changes for a workspace
  whose names are all ASCII.

  **Two spellings of one name are reported instead of ending the scan.** Both normalize to one
  Document path, so the pipeline read one file twice and minted its Symbol id twice — and
  `assertIRIntegrity` ended the run on `[#1] duplicate Symbol id`, naming neither file. Every
  claimant is now withdrawn and reported on `ScanResult.unrepresentableFiles`, which grew a
  `reason` to say which of the two things happened; `aburi scan` prints a section per cause and
  exits 3. The collision section spells each name out by codepoint, because the two print
  identically in a terminal.

  `EnrichmentInput.fileContents` becomes `ReadonlyMap<string, { content, fsPath }>` for the same
  reason the read changed: a `file://` URI is a filesystem address. One entry rather than a second
  map keyed the same way, so "a file that was read has a spelling on disk" holds by construction
  instead of by agreement. A caller of `enrichWithLsp` outside the core passes `fsPath: path` for
  any name already in NFC, which is every ASCII one.

- cafd4b8: Stop reporting success for a scan that read almost none of the workspace

  `runScan`'s exit code was `extractionFailures.length > 0 ? GATE : SUCCESS` and nothing about
  coverage reached it. A run that discovered 1200 files and withdrew every one of them wrote
  `out/aburi.ir.json`, exited `0`, and diffed against the next one as `+0 -0 ~0` — passing every
  `--fail-on` gate. The one guard that existed, `requireLanguagePlugin`, closes a single route to
  that shape and says in its own docblock why the shape is dangerous: it is a **success**, so the
  run that lost the workspace is the one that looks healthiest.

  **`parsedFiles === 0` now exits `3`**, with the line that accounts for the code printed above
  the census that is its evidence:

  ```
  ⚠ 1200 file(s) discovered, 0 parsed — 1200 as parse-failed. The IR is empty and will diff clean against any other empty IR.
  ⚠ 1200 file(s) contributed no Symbols: parse-failed=1200
  ⚠ parse-failed (1200) — the language plugin refused the source. Deterministic: fix the file, or the plugin.
      src/a.ts: parse reported a non-recoverable error at 1:1 — unexpected token
      …
  ```

  Two wordings from one condition, because the first move differs. Discovering nothing is a
  question about the config — `ignore`, `.gitignore`, `components[].roots`, whether a loaded plugin
  claims any extension here — so that line names those. Discovering files and parsing none is a
  question about whatever withdrew them, so that line names the reason that took the most, ties
  broken by the reason enum's order so the sentence does not depend on the order of the walk.

  **A workspace can set a floor above zero: `minParsedFileRatio` in `aburi.json`.** Absent by
  default. Where the line sits between "lost some files" and "lost the workspace" depends on the
  repository, and a default would red a build for a judgement nobody made. Set it and the scan
  gates when `parsedFiles / totalFiles` falls below it — `<`, not `<=`, the reading `--fail-on`'s
  thresholds already use. A floor of `0` is refused by the schema: nothing can fall below it, so
  the key would be a policy that does nothing.

  `@aburi/config` is released alongside the CLI because the key lives in `aburi.config.v1.json`,
  which that package inlines at build time and validates with `additionalProperties: false` at the
  root. The CLI bundles `@aburi/config` as an external, so a CLI published against the previously
  released config would reject a correct `minParsedFileRatio` with exit 2 — while the monorepo
  suite, which reads the workspace schema, saw nothing wrong.

  **The floor counts every skip reason.** `parse-timeout` is the one whose loss varies by machine,
  and so the one a floor is usually reached for, but it is not the only one that hides a blind
  spot: which reason produced the loss decides the fix, not whether coverage collapsed. Every
  reason is named per file directly below either way.

  **`keptSymbols` plays no part.** A file that parses cleanly and declares nothing is counted as
  parsed, which is correct — a repository of configuration and tests is not a failed scan — so a
  Symbol count says something about the code where `parsedFiles` says what this policy is about.

  **One construction.** `ScanReport` gains `parsedFiles` and `coverageFault`, computed once. The
  exit code derives from it, the incident report renders it, and `aburi diff` names it as the cause
  of its own exit, so the three cannot disagree about whether the run was green.

  **`aburi diff` names it.** `warnOnScanFault` said its wording comes from what the scan reported
  rather than from the gate condition "so a second reason arrives with the code right and the
  message still true", and fell back to `The base scan did not exit clean`. This is that second
  reason, and it now reads `The base scan parsed none of the 1200 file(s) it found`. A plugin
  exception is named first when both apply: a scan that threw on every file has the coverage fault
  as a consequence of it rather than as a second finding.

  The IR is written under both gates, as it already was for a plugin exception — a reviewer gets
  the partial artifact and a non-zero code rather than neither.

- 667f9b7: Say which files a scan lost and what to do about each, instead of a bare histogram

  The stderr report named how many files contributed no Symbols and never which, let alone why:

  ```
  ⚠ 412 file(s) contributed no Symbols: parse-timeout=412
  ```

  `@aburi/core` writes a `detail` on every entry it produces — the size against the cap, the parse
  error that refused the file, the `readFile` errno, the message a plugin threw — and
  `summariseSkipped` took `readonly { reason: string }[]`, so the path and the detail were dropped
  structurally before the line was built. The same run now reads:

  ```
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

  **The listing is the only account there is, for half the reasons.** `over-size`, `unroutable`,
  and an `unreadable` raised during discovery are decided before extraction and are not logged at
  all; the other three log per file through the run's `Logger`, which `ABURI_LOG_LEVEL=error`
  silences and which never reaches a caller who injected its own streams. Turning down log noise in
  CI used to remove the only record of which files were lost — and for a file withdrawn by its
  parse, the skip detail is the only account of the error that refused it, since counting that
  error among the recoverable ones would call it something the plugin did not.

  **One line per reason, because they want different answers.** `over-size` points at
  `maxFileSizeBytes`, `parse-timeout` at `parseTimeoutMs` and a re-run, `unreadable` at permissions
  or a tree that was changing under the scan, `unroutable` at a bug in the plugin set, and the two
  extraction reasons at the source and at the plugin. The re-run / fix-something split is the one
  `SkippedFile.reason` already draws in the IR schema, rather than a second vocabulary. The advice
  and the order both come from one `Record` over the reason union, so a reason added to the schema
  stops the build instead of printing a group with nothing to say — or, had the order been a list,
  compiling and quietly leaving that reason's files out of a report whose census still counted
  them.

  **Ten files per reason, not ten across the listing.** One shared budget belongs to whichever
  reason lost the most files, and that is not the reason a reader most needs named: a hundred
  over-size files would push the one file a plugin threw on — the only reason that moves the exit
  code to `3` — inside `…and N more`, leaving a non-zero status with nothing on screen to account
  for it.

  **`extraction-failed` is listed by that rule rather than by one of its own.** It had a separate
  clause with its own listing, which meant its files were named twice: the scan writes the thrown
  message to both `skipped[].detail` and `extractionFailures[].message` at a single site.
  `ScanReport.extractionFailures` is unchanged — it still carries the error's `code`, still decides
  the exit code, and is still what the `diff` fault clause counts.

  **Reasons are reported in a fixed order** — `over-size`, `unreadable`, `unroutable`,
  `parse-failed`, `parse-timeout`, `extraction-failed`, the order the schema's `reason` enum
  declares — in the census line and in the groups alike. Insertion order is scan order, so the census
  used to list its reasons in an order that depended on where in the workspace the losses happened
  to sit.

  **In `@aburi/core`, a timed-out file's detail now names the numbers.** It read
  `extraction exceeded parseTimeoutMs`, a restatement of the reason, while the elapsed and the
  budget — the pair that decides whether to raise the budget or go and look at the file — sat only
  in the log line beside it. A machine-dependent number is safe there because `detail` is never
  projected into the Document; `stats.skippedFiles[]` still carries `path` and `reason` only, which
  is what keeps two checkouts of one commit byte-identical.

- 54881d5: Withdraw a file its language plugin refused to parse

  `ParseError.recoverable` has been documented since the plugin types were written:

  ```ts
  /** false → core skips this file. */
  recoverable: boolean;
  ```

  `lang-plugin.md` §7.1 said the same, in more detail: _"the file is skipped, excluded from
  stats.parsedFiles, warning log"_. No non-test code in `packages/**` read the field — every
  occurrence was a write. What actually withdrew a file was `ParseResult.tree === null`, a
  separate signal a plugin sets independently.

  So a plugin following the documented contract — return the tree you managed to build, mark
  the error `recoverable: false` to say "do not use this file" — got its file extracted
  normally. No error, no warning; the instruction was ignored.

  `@aburi/lang-typescript` never noticed. The only `recoverable: false` it emits is paired
  with a null tree, so the real gate fired anyway, and a plugin reasoning from the type
  doc rather than from that coincidence got different behaviour from the one it asked for.

  ## What happens instead

  The two signals are read as one condition. A file is withdrawn when its parse returned no
  tree **or** reported any error marked non-recoverable:

  - no Symbols reach the IR, and `extractSymbols` / `walkBody` / `normalizeAst` are never
    called for it;
  - `ScanResult.skipped` gains an entry with `reason: "parse-failed"`, whose `detail` quotes
    the refusing error's message and position. With no tree and no such error it quotes the
    first recoverable one instead, because a withdrawn file is excluded from the CLI's
    recoverable-error count and this line is then the only place its errors can be read;
  - `stats.parsedFiles` excludes it while `stats.totalFiles` still counts it;
  - the core logs a warning.

  Its **parse errors are still reported** on `ScanResult.parseErrors`, for the reason a
  timed-out file keeps its own: they are diagnostic rather than IR, and here they are the
  entire account of why the file went. Its **import edges are kept** — a file whose contents
  could not be used still told us truthfully what it imports, the one place this differs from
  a file abandoned on its `parseTimeoutMs` budget, which is being withdrawn deliberately.

  Reading the flag also gives a plugin something it did not have: a way to reject a file it
  _could_ parse — a wrong-dialect source, a generated blob — without fabricating a null tree
  to be heard.

  ## The two other halves of that sentence

  The doc promised three things and the code delivered one, _including for the null-tree case
  it did implement_: a file with no tree was excluded from `parsedFiles` and otherwise
  invisible — no `skipped` entry, no warning. Both now happen for both conditions, so
  `ScanResult.skipped` finally answers "why is this file missing from the IR" exhaustively.

  That makes the count derivable from the list, so the counter beside it is gone. On the public
  surface the identity is now `stats.parsedFiles = stats.totalFiles - ScanResult.skipped.length`:
  one subtraction, where before a withdrawn file was both listed and counted and would have been
  netted out twice, reporting two files lost for one.

  What the length has to mean is _at most one entry per file_, which rests on every branch that
  records a skip ending the file's turn in the loop.

  `SkippedFile.reason` widens by one member, which is breaking for an exhaustive `switch`
  over it. `ScanReport.skipped[].reason` is narrowed from `string` to that union, so the CLI
  report now fails to compile if a member is renamed rather than silently reporting zero.

  `ParseError.recoverable` is read as exactly `false`, not as a falsy value. Plugins arrive as
  plain JavaScript through a `PluginRef`, and a plugin that simply omits the key would otherwise
  have every file it reported any parse error on withdrawn, silently and at exit `0`. Read
  literally, such a plugin is left where it was before the field was read at all.

  ## The CLI stopped calling a refusal recoverable

  `⚠ N file(s) had recoverable parse errors.` counted every file on `ScanResult.parseErrors`,
  which now includes files withdrawn _for an error that said it was not recoverable_. The
  counts are split:

  ```
  ⚠ 3 file(s) had recoverable parse errors.
  ⚠ 1 file(s) could not be parsed and were left out of the IR.
  ```

  `ScanReport.parseErrorCount` counts files whose errors the plugin called recoverable; the new
  `ScanReport.parseFailureCount` counts the ones it refused. The split is by what the plugin
  said rather than by what reached the IR — a file abandoned on its `parseTimeoutMs` budget is
  counted on the first line and is not in the document, because its errors really are all
  recoverable and they are the reason that path keeps them.

  `aburi scan` stays at exit `0`. An unparseable file is a property of the source, like an
  over-size or timed-out one; `extraction-failed` remains the only reason that gates
  (cli-spec.md §5.4). The same row promised exit `1` on a "cascade of unrecoverable parse
  errors", which nothing implemented and which this change contradicts outright; it now
  describes the read failures that really do end the run.

- dbdc8aa: Refuse a backslash in a filename instead of rewriting it into a path separator

  `toDocumentPath` and `toPosixRelative` began by rewriting every `\` into `/`, before any
  validation ran. A backslash is a legal POSIX filename character, so a file named
  `weird\name.ts` was silently renamed to `weird/name.ts`: the Symbol ids built beside it named
  a path nothing can open, and `a\b.ts` beside `a/b.ts` collapsed onto one path, which invariant
  #1 reported as duplicate ids rather than as the filenames that produced them. The shared path
  rule has always refused the character and has a message for it; nothing reached the check,
  because the rewrite spent the character first.

  The two entry points now normalize NFC and validate what they are given. Converting a native
  path is the caller's job, because only the caller knows it holds one — `toRelativePosix` in
  `workspace.ts` shows the shape, rewriting on the platform separator, which is a separator
  exactly where a filename cannot hold one.

  **Migration.** A caller passing a native path to either entry point must convert it first:

  ```ts
  import { sep } from "node:path";
  toDocumentPath(sep === "/" ? nativePath : nativePath.split(sep).join("/"));
  ```

  Nothing in this repository needed the change: the file walk takes its paths from `glob`, which
  returns POSIX separators on every platform.

  `aburi scan` reports such a file and exits 3. It cannot be recorded on `stats.skippedFiles`,
  because that path is held to the same rule, nor counted in `stats.totalFiles` without being
  recorded, because integrity #21 pins the skip list's length to `totalFiles - parsedFiles`. So it
  leaves the census the way a file no plugin claims does, and `ScanResult.unrepresentableFiles`
  plus the stderr paragraph built from it are the run's only account of it — which is why the exit
  code moves. `aburi explain` answers for one of these files without consulting the document, since
  no document could hold it.

  `aburi diff` names it as the fault for the side that has it, in ref mode, where it runs the
  scans. `--base` / `--head` reads two documents and neither records the file, so a rename into
  such a name reads as deletions there: `dependencySideView` builds its lost-file set from
  `stats.skippedFiles`, which this file is absent from by construction. That is a limit of the
  frozen path grammar rather than of the diff, and is recorded as a v2 shape in `ir-schema.md`
  §15.4.

- 85ade16: Give paths and qualified names one grammar, applied everywhere they are read

  Four places asked overlapping questions about the same strings and answered differently, so
  a value could pass every gate and break something that trusted it.

  **One path rule.** IR integrity invariant #10 carried its own copy of the workspace-relative
  path rule, and that copy checked only backslashes and absolute prefixes. An IR whose
  `symbols[].source.file` read `../../../../etc/passwd.ts` — or whose `components[].roots` /
  `workspace.managers[].roots` pointed above the workspace — produced zero violations, while
  `readIR` uses `assertIRIntegrity` as its only validation gate. `workspace.root` anchors every
  path in a Document, so a path that ascends past it names something the Document has no way
  to be about. Invariant #10 now calls `posixWorkspaceRelativeViolation`, the rule the Symbol
  id constructor calls, and the shared rule additionally rejects an empty path, a
  drive-relative `C:a.ts`, and a `.` segment — `./src/a.ts` beside `src/a.ts` is one file with
  two spellings, and by §3.1 that is one file with two Symbol ids that invariant #1 cannot see
  as a duplicate.

  A file path keeps the two restrictions that belong to the id rather than to the path: it
  holds neither `:` nor `#` (the id is split on the first of each), and it is never the bare
  `.`, which names the workspace root. `toPosixRelative` applies those too, since everything
  it returns becomes a `source.file` and the file segment of an id.

  **One qualified-name rule, applied to both places one is stored.** `makeSymbolId` dropped
  empty segments before validating them, so `A.`, `A..B`, `.` and `::` all built ids and
  satisfied `isSymbolId`. Separately, `Symbol.name` carries a qualified name of its own and
  nothing checked it at all — and it, not the qname inside the id, is what `apiFingerprint`
  and the framework classifiers hand to `lastQnameSegment`, which throws on an empty leaf.
  Both are now covered: the constructor refuses an empty segment, and invariant #17 checks
  `symbols[].name` alongside `symbols[].id`.

  **Producers that could break the tightened rules.** Two existed, and both now report against
  the input rather than the Document:

  - Glob patterns may ascend (`packages: ['../shared/*']`), and the matches became
    `workspace.managers[].roots` entries containing `..`. The file walk never followed them —
    it globs under the workspace root — so those packages contributed no Symbol, and the entry
    described a directory the scan never opened. `detectManagers` now refuses such a manifest
    with `workspace-root-outside`, naming the tool and the root. Continuing would have produced
    a Document silently missing packages the user declared.
  - The config schema's `RelativePath` constrains only `minLength` and "no backslash", so a
    `components[].roots` entry of `"../shared"` was schema-valid and copied into the IR
    verbatim. It is now checked where the config is read, so it is reported against
    `components[id=…].roots` in the config with the input-error exit code, instead of
    surfacing as an integrity violation blaming the Document at the end of the scan.

  Workspace and component roots are also normalized to Unicode NFC, matching
  `symbols[].source.file`, so one directory is not spelled two ways within one Document.

  `@aburi/core` newly exports `posixWorkspaceRelativeViolation`, `isQualifiedName` and the
  `GrammarViolation` type, so a consumer building an IR can apply the same rules the integrity
  checker will.

- 14bdb6b: Separate the `LanguageId` and `PluginRef` vocabularies

  `aburi.json` uses the key `languages` at two nesting levels with two different
  vocabularies: the top-level array holds plugin refs the loader resolves as module
  specifiers, while `components[].languages` holds `LanguageId`s constrained to
  `^[a-z][a-z0-9]*$`. Both writers conflated them.

  - `LanguagePlugin` gains a required `languageId` field. `@aburi/core` projects it into
    `IR.workspace.languages`, which previously received `manifest.name` and therefore
    emitted `"lang-typescript"` — a value that fails the frozen `aburi.ir.v1` schema for
    every first-party plugin. Third-party language plugins must add the field.
  - `LanguageId` is now a branded type constructed through `makeLanguageId` (exported from
    `@aburi/core`), so a manifest name can no longer be assigned where a language id belongs.
  - `aburi init` writes plugin manifest names (`lang-typescript`, `framework-nestjs`) in the
    top-level arrays and keeps `LanguageId`s inside `components[]`. It previously wrote
    detector ids, so the loader looked for the non-existent `@aburi/ts` package and the
    documented `init` then `scan` quick start failed on every project.
  - `InitReport` gains `unmappedLanguages` / `unmappedFrameworks`, and the CLI warns about
    them. A detected language with no first-party plugin leaves `languages` empty, which is
    otherwise invisible until the next command stops.
  - `--with-suggestions` names the language plugin first, per `cli-spec.md` §4.6: it is a
    hard requirement for the next `aburi scan`, where a framework plugin only widens
    classification.
  - `aburi scan` refuses to run when no language plugin resolves, instead of writing an IR
    with zero Symbols and an empty `workspace.languages` at exit 0. That document fails the
    schema's `minItems: 1`, and two of them diff to `+0 -0 ~0` — so every `--fail-on` gate
    downstream passed regardless of what changed.
  - New integrity invariant #18: `workspace.languages` is non-empty, every entry satisfies
    the `LanguageId` grammar, and every `Symbol.language` appears in it. It also covers an IR
    read off disk, which `readIR` brands without validating.

### Patch Changes

- e2dab93: Establish the Document's shape before the invariants assume it

  `checkIRIntegrity` took an `IR` and dereferenced its way through the Document. `readIR`
  brands a parsed JSON object after checking `$schema`, so in practice the checker is the only
  gate a Document read off disk passes — and it assumed the thing it was being asked to
  establish. Fourteen shapes that survive that gate produced a `TypeError` instead of a
  violation list, among them a missing `workspace`, a `stats.callResolution` of `null`, a
  non-string entry in `components[].roots`, and a `derivedFrom` of `null`.

  The CLI wrapped each as `config-error`, so a user was told the IR failed to load and not
  which invariant broke — which is the one thing the invariant list exists to say.

  **Invariant #20** is the Document's shape as `aburi.ir.v1` requires it: every `required`
  field, of the declared kind, at every depth. It names the record and the field:

  ```
  [#20] symbols[0]: "fingerprint" is absent, not an object
  [#20] document: "workspace" is absent, not an object
  [#20] components[0].roots[0]: entry is a number, not a string
  ```

  Three decisions worth stating:

  - **The scope is the schema's requirements, not "the fields the invariants read".** `readIR`
    brands its result `IR` on the strength of this check, so what #20 establishes is what that
    brand asserts. A narrower check would hand `@aburi/diff` a Document with no `fingerprint`
    and let it fail on `b.fingerprint.logic`, outside anyone's error handling and with no file
    or field named.
  - **The restatement is checked, not trusted.** A test reads `schema/aburi.ir.v1.json` and
    fails on a `required` entry with no counterpart in the spec, on a spec field the schema
    does not declare, and on a structural definition the spec omits entirely.
  - **#20 is reported alone.** The nineteen relational invariants are statements about a
    Document; a value that fails #20 is not one.

  `checkIRIntegrity` and `assertIRIntegrity` now take `unknown`. Every other caller holds a
  typed `IR` and is unaffected; the caller these exist for holds a parsed JSON object, and
  declaring `IR` had them assert what they were being asked to establish. `readIR` brands
  after the check rather than before, and its own array pre-check is gone — #20 covers it, and
  a duplicate is only a second place for the answer to drift.

  Also fixed by the same shape guarantee: four invariants that a mistyped field silently
  disabled rather than crashed. `dropped: "true"` skipped #5 entirely, `derivedFrom: 5` passed
  #11 because `(5).length` is `undefined`, and `workspace.languages: [null]` passed #18 because
  the grammar regex coerced `null` to the string `"null"`.

- fc8f3c9: Implement `config.parseTimeoutMs`, which the schema had documented and nothing read

  `parseTimeoutMs` appeared only in `aburi.config.v1.json` and the type generated from it.
  Setting it changed nothing, so the one lever a user had against a file that would not finish
  did not exist.

  It is now a per-file budget over parse + extract + walk, per lang-plugin.md §7.1.2, defaulting
  to the schema's 5000 ms and clamped up to its 100 ms minimum. The budget is **cooperative**,
  for the same reason the classify budget is (effect-plugin.md §5.1.1): `extractSymbols` and
  `walkBody` are synchronous plugin calls, and nothing can interrupt one that has started. It is
  read where control is back in the pipeline — after `parseFile`, after `extractSymbols`, and
  before each candidate's walk — so what it guarantees is that an over-budget file is handed no
  further work. A file costs at most its budget plus one stage, and a single enormous candidate
  can still overrun by however long that candidate takes.

  An over-budget file contributes nothing to the IR: no Symbols, no import edges. Keeping
  whichever Symbols it finished first would make the Document depend on how fast the machine was
  that day, so the outcome is binary per file. Its **parse errors are still reported**, because
  they are diagnostic rather than IR and because backtracking over malformed input is a common
  reason for a slow parse — a run that swallowed them would send the reader to raise the budget
  when the fix is the syntax.

  Such a file lands in `ScanResult.skipped` under a new `reason: "parse-timeout"` and again on
  `ScanResult.parseTimeouts` with the budget and the elapsed beside it, is left out of
  `stats.parsedFiles` while still counting toward `stats.totalFiles`, and warns in the shape
  lang-plugin.md §7.1.1 uses for the size cap:

  ```
  Skipped src/generated/client.ts: extraction reached 7413ms, exceeding parseTimeoutMs (5000ms). Override with config.parseTimeoutMs.
  ```

  Skipping on wall clock does mean the IR can differ between a fast machine and a slow one, at
  file granularity. That is inherent in asking for a time budget rather than introduced here; a
  run that needs reproducibility across machines sets the budget high enough that nothing reaches
  it. The tests accordingly never assert that something finished in time — a stub plugin
  deliberately spends the budget, so the over-budget cases can only fail in the direction of a
  machine spending more.

  `@aburi/core` also exports `startParseDeadline`, `ParseDeadline`, `ParseTimeoutEvent`,
  `DEFAULT_PARSE_TIMEOUT_MS` and `PARSE_TIMEOUT_MIN_MS`. `SkippedFile.reason` gains a fourth
  member, so an exhaustive `switch` over it needs a new arm. The CLI's skip summary no longer
  says "skipped during discovery": two of the four reasons are decided after it.

- 1e59445: Decide a file the scan cannot open the same way at both stages that open one

  Two calls in a scan open files: discovery's `stat` on every candidate, and the `readFile` the
  orchestrator does just before extraction. They disagreed about what a failure meant. The
  orchestrator absorbed only `ENOENT` and re-threw the rest, and said why — a permission the
  checkout got wrong or an exhausted descriptor table depends on how the machine was feeling, so
  absorbing it lets one commit produce a different Document on a different day. Discovery
  recorded every errno as a skipped file, so the identical `EACCES` on the identical machine
  either ended the run or quietly shrank the IR, according to which of the two calls happened to
  reach the file first. Nothing gated the second outcome: `minParsedFileRatio` is unset by
  default, so the run exited `0`.

  One predicate now decides both. It holds `ENOENT` and `ENOTDIR`, because the operating systems
  disagree about what to call one event: replacing a directory with a file while a scan runs is
  answered `ENOTDIR` on POSIX and `ENOENT` on Windows, and a predicate holding only `ENOENT` made
  the same act fatal on one platform and benign on the other. Everything else propagates out of
  `discoverFiles` as the operating system raised it, which is what the orchestrator already did,
  and reaches the CLI's exit code `1`.

  So `unreadable` now means one thing wherever it appears — the file stopped being one while the
  scan ran — and `aburi scan`'s advice for it no longer sends the reader to check permissions,
  which after this change cannot have caused it.

  **`describeThrown` no longer answers a thrown empty string with an empty string.** It exists to
  replace a plugin's silence, and `throw ""` produced exactly that, one step further in: the
  value lands on `skipped[].detail` and `extractionFailures[].message`, where nothing separates
  "the plugin said nothing" from "nobody recorded anything". The guarantee is now non-emptiness
  and it is enforced on the result rather than inside the chain, since an object whose `toJSON`
  returns `undefined` and whose `toString` returns `""` reaches the end and comes back empty too.
  Discovery's `stat` detail and the `.gitignore` read failure both go through it, replacing an
  unguarded `(error as Error).message` that left `detail: undefined` for a non-`Error` throw and
  a third copy of the same chain.

- 8ce6ed4: Record a filename Aburi cannot build an id from, instead of ending the scan on it

  `discoverFiles` called `toPosixRelative` outside any `try`. That constructor runs the **Symbol
  id** path grammar, which refuses `:` and `#` — both legal POSIX filename characters, and `#`
  legal on Windows and macOS too. One such file anywhere in the tree threw a `CoreError` naming the
  id constructor, and the whole walk died with it. Further down that same loop, a file that cannot
  even be `stat`ed is recorded on `skipped[]` and the walk continues.

  Both are "one file cannot be handled". They now reach the user the same way:

  ```
  ⚠ 1 file(s) contributed no Symbols: unroutable=1
  ⚠ unroutable (1) — no route into the IR exists for them, decided before either was read. …
      src/od#d.ts: its path segment "od#d.ts" contains "#", which a Symbol id is split on, so nothing declared in this file could be given an id
  ```

  **The Document names it.** `stats.skippedFiles[].path` is held to the shared path rule
  (integrity #10), which admits both characters — only the _id_ grammar refuses them. So the file
  is counted in `totalFiles`, excluded from `parsedFiles`, and listed by path, and everything built
  for lost files answers honestly with no change: `aburi explain` says the IR never analysed it, and
  `buildDiff` puts it in `notCompared[]` when both revisions lost it.

  `@aburi/types` is released with it: the reason's description in `aburi.ir.v1.json` is mirrored
  into `packages/types/src/generated/ir.ts` by codegen, and that package is published. Only
  descriptions changed, so the bump is a patch.

  **Reason: `unroutable`, generalized.** Two producers, one meaning — _no route into the Document
  exists for this file, decided before it was read._ The router refusing an extension and the id
  grammar refusing a name are the same answer with different causes; the skip `detail` says which,
  and a reader with only the Document can tell from the path, since the second cause is visible in
  it and `detail` is deliberately not projected. A distinct `unnameable` would be the better model and is not available: `reason` is a
  closed `enum` in `aburi.ir.v1.json` and, by `$ref`, in `aburi.diff.v1.json`, so a document
  carrying a new value is rejected by any validating reader. Recorded as a v2 shape in
  `ir-schema.md` §15.4 with that reasoning.

  **The subject is the offending path segment, not the file.** A separator in a directory name
  disqualifies every file beneath it, and none of those filenames is at fault — `src/v#1/util.ts`
  is fixed by renaming `v#1`, and a line blaming `util.ts` sends the reader to rename the wrong
  thing. When the basename is the offender the two coincide.

  **`toDocumentPath` beside `toPosixRelative`.** The path rule and the id rule are now separate
  entry points, because the two answers call for different responses. A path that is not
  workspace-relative at all is a caller handing over something from outside what the Document
  describes, and there is nothing to record — still fatal. A path that merely cannot host an id is
  one file to skip, and the skip entry names it using exactly the rule that will accept it.
  `symbolIdSeparatorSite` answers the second question without an exception and names the segment
  that holds the separator, and the id grammar enforces the rule through the same helper so the two
  cannot drift. `toPosixRelative` now has no caller inside this workspace — the walk records rather
  than refuses, and `makeSymbolId` runs the rule where the id is minted — but it stays as public
  API for a caller that wants the refusal up front.

  **`aburi explain` stops claiming a `#` argument that is not an id.** `cli-spec.md` §7.2 has always
  said the id arm applies to a string that "matches the `<language>:<path>#<qname>` form"; the
  implementation took any `#` and answered "no such Symbol id" for it. That was invisible while no
  `#`-named file could be in a document — and it would have made the file arm unreachable for
  exactly the files this change adds. The id arm now claims the argument only when it is one, and
  §7.2's file arm loses its "contains no `#`" clause, which the same change falsifies.

- b8763eb: Make Unicode normalization total across every comparison the IR makes

  Ids and paths were normalized to Unicode NFC at the points where they enter the process, so
  the string held in memory and the string written to disk are one string. Several values that
  decide an order or an identity were not, and the missing halves were quiet.

  `effects[].target` is the clearest. `propagateEffects` orders propagated entries by
  `(id, target)`, integrity invariant #11 verifies that order against the in-memory value, and
  `serializeCanonical` writes the normalized one — so a Document could satisfy the sort
  invariant and land on disk violating it. The two spellings of `é` sort on opposite sides of
  `z`, so this is an inversion, not a near-miss.

  The rest are comparisons where one side is normalized and the other is not. That is worse
  than neither being normalized, because it turns a match into a miss:

  - `signature.inputs[].name` is compared against a call's head segment to decide that a
    parameter shadows a Symbol of the same name. A miss emits an edge to an unrelated Symbol,
    which then carries effects through propagation.
  - `ImportEdge.namespaceBinding` / `symbols[]` / `source` decide import-scope resolution. A
    miss puts the call in the `no-match` diagnostic bucket instead of `external` — the state
    that sends a reviewer looking for a typo that does not exist.
  - The `suppress` / `keep` / `dropCallees` prefixes decide whether a call is dropped. A miss
    leaves nothing in the Document to trace it back from.
  - `components[].publicApi` is deduped and sorted at collection and compared across revisions
    by `@aburi/diff`, whose base side came off disk normalized. A mismatch reports a
    `publicApiChanged` for a component nobody touched.

  All of them are now normalized where they enter: the scan pipeline's plugin boundary,
  `buildDropCFilter`, `normalizePackagePath`, and the CLI's config-component path.

  **The rule now has one home.** `ir-schema.md` §1.2 states it — every string in a Document is
  NFC, why that is load-bearing for both ordering and identity, the entry points where it is
  established, and why it is NFC and not NFKC (compatibility folding rewrites text rather than
  respelling it, collapsing distinct ids and misquoting source). The explanation had been
  repeated across `canonical.ts`, `id.ts`, `workspace.ts` and their tests; those now reference
  the section. §1 no longer says "alphabetical" and "UTF-16 code unit" in the same breath, and
  §9.4 states the propagated-effect ordering that made `target` a sort key in the first place.

  **Invariant #19** makes it checkable on a Document read off disk: `source.file`,
  `effects[].target`, `calls[].target`, `components[].roots`, `components[].publicApi`,
  `workspace.managers[].roots` and both `dependencies[]` endpoints. Ids and `Symbol.name` are
  left to #17 — all three grammars are ASCII-only, so a non-NFC value fails the grammar first
  and reporting it twice would have the reader chase one string twice. Strings the Document
  quotes are excluded for the opposite reason: their spelling decides nothing, and normalizing
  a quotation would misquote it.

  Normalization violations now name both spellings by code point. They render identically by
  definition, so the old message showed a string that looked correct beside the claim that it
  was not. The Symbol id constructor's version of the same message was fixed with it.

- Updated dependencies [e2dab93]
- Updated dependencies [e7b886e]
- Updated dependencies [309f093]
- Updated dependencies [fc8f3c9]
- Updated dependencies [630460f]
- Updated dependencies [f73eb46]
- Updated dependencies [4c2d5aa]
- Updated dependencies [a5ffc07]
- Updated dependencies [916eae2]
- Updated dependencies [1e59445]
- Updated dependencies [459394f]
- Updated dependencies [c825c74]
- Updated dependencies [14d3aa7]
- Updated dependencies [8ce6ed4]
- Updated dependencies [6d3d390]
- Updated dependencies [c3654c3]
- Updated dependencies [4a4296e]
- Updated dependencies [da20510]
- Updated dependencies [b8763eb]
- Updated dependencies [cafd4b8]
- Updated dependencies [39ef5b9]
- Updated dependencies [667f9b7]
- Updated dependencies [54881d5]
- Updated dependencies [37715cd]
- Updated dependencies [722903a]
- Updated dependencies [dbdc8aa]
- Updated dependencies [85ade16]
- Updated dependencies [14bdb6b]
  - @aburi/core@0.3.0
  - @aburi/diff@0.3.0
  - @aburi/markdown-projection@0.3.0
  - @aburi/types@0.3.0
  - @aburi/plugin-registry@0.3.0
  - @aburi/config@0.2.0

## 0.2.0

### Minor Changes

- b2f4382: Give `SymbolId`, `ComponentId`, and `SliceId` separate identities instead of three names for `string`.

  Aburi mints three kinds of identifier and each owns a namespace, but all three were the
  same type. `SymbolId` and `ComponentId` were bare aliases of `string`
  (`aburi.ir.v1.json#/$defs/*` are `{"type": "string"}`, and json-schema-to-typescript
  faithfully generates what the schema says); `SliceId` did not exist at all, so
  `SliceRecord.id` was `string` and `SliceRecord.members` was `string[]`. Nothing stopped a
  Component id being passed where a Symbol id was wanted, and `"slice:" + members[0]` — the
  Slice-id derivation — was an expression any file could open-code, because its result was
  assignable to the field it fed.

  `SymbolId` and `ComponentId` are now nominal types, `SliceId` exists and is nominal too,
  and `dependencies[].from` / `.to` are `SymbolId | ComponentId` rather than `string` — the
  union is honest about the one array that holds both kinds, while still refusing an
  arbitrary string. Every brand comes from a constructor: `makeSymbolId` / `trySymbolId` /
  `makeComponentId` in `@aburi/core` and `sliceIdFor` in `@aburi/diff`. Assertions
  (`x as SymbolId`) survive in four documented places and nowhere else — `packages/core/src/id.ts`,
  `sliceIdFor` plus the untyped-input predicate in `packages/diff/src/slice.ts`, the single
  `parsed as unknown as IR` in `readIR`, and per-package test fixtures, which need to be able
  to write a malformed id for the cases that exist to reject one.

  Two call sites were building Symbol ids by concatenation behind a type annotation and now
  go through the constructor: the call-graph resolver and the LSP enrichment pass, which
  assemble _speculative_ callee ids and test them for existence. Those use `trySymbolId`, the
  non-throwing variant — an id that cannot be built is a callee that cannot exist, which is
  the same answer as a well-formed id absent from the Symbol table, so resolution behaviour is
  unchanged. `@aburi/diff`'s git-rename stage, which rebuilds an id around a moved file path,
  goes through the same constructor for the same reason.

  The brands are TypeScript-only and erased at runtime. Scanning and diffing the
  `nestjs-billing` fixture produces byte-identical `ir.json`, `diff.json`, `workspace.md`, and
  `diff.md` before and after.

  ### Schema

  `aburi.ir.v1.json` and `aburi.diff.v1.json` gain three `$defs` — `DependencyEndpoint`,
  `SliceId`, and a loose `SymbolId` on the diff side — extracted verbatim from the inline
  subschemas they replace. The validation semantics are identical; the change exists so the
  generator has a named alias to attach a brand to. The brand itself is applied by a
  post-processing pass in `packages/types/scripts/codegen-lib.ts`, not by a `tsType`-style
  keyword in the schema: these are frozen v1 documents published for validators outside this
  repository, and a non-standard keyword would make every strict-mode validator reject the
  schema itself. That is the same reasoning that kept the Slice anchor keyword out of the file.

  ### Two new integrity invariants
  - **#16 — no reserved namespace.** Slice ids are `"slice:" + <anchor Symbol id>`, so a
    language plugin claiming the token `slice` would mint Symbol ids indistinguishable from
    Slice ids and make the derivation produce `slice:slice:…`. Branding cannot fix this — the
    strings are genuinely the same shape — so `makeSymbolId` rejects the token, and
    `checkIRIntegrity` rejects it in a Symbol id or a Dependency endpoint from a document it did
    not build. Only the whole token is reserved; `slicer` is still legal. `@aburi/diff` reports
    it as its own `SliceRecord` violation kind too, because `buildDiff` is public API and runs
    no integrity check. No plugin uses `slice` today.
  - **#17 — ids satisfy their own grammars.** `readIR` brands a whole parsed document with one
    `as unknown as IR`, which is the only way to type a JSON parse — so ids read from disk used
    to acquire their brand without anything looking at them, while every other route ran a
    constructor. #17 closes that: `symbols[].id` must satisfy `isSymbolId` and `components[].id`
    must satisfy `isComponentId`. It is also what catches a language plugin that asserts the
    brand instead of calling the constructor.

  ### Behaviour changes
  - **`ComponentId` accepts a digit-leading segment.** The pattern was
    `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and is now `^[a-z0-9]+(-[a-z0-9]+)*$`, in both
    `aburi.ir.v1.json` and `aburi.config.v1.json`. Component ids are derived by kebab-casing a
    package or directory name, and `3d-force-graph` / `7zip-bin` are ordinary npm names — the
    letter-first rule made the documented derivation partial for no benefit. Loosening a pattern
    is additive: every document that validated before still does.
  - **Component detection fails loudly on a name that yields no id at all.** After the pattern
    change only one case remains — a name that kebab-cases to the empty string. It now raises
    `invalid-component-id` naming the package or directory it came from, instead of putting `""`
    in `components[].id` and producing an IR that fails its own schema somewhere else entirely.
    The CLI wraps it as a `config-error`, so it exits 2 (input) rather than 1 (runtime).
  - **A Symbol id file path may not contain `:` or `#`.** They are the id's own separators, so a
    path holding either assembles into a string that still matches the schema pattern but splits
    back into parts the producer never wrote. `makeSymbolId` now refuses them, which is what lets
    `isSymbolId` recover the parts and re-run the constructor's own check.

  ### Packages with no source change

  `@aburi/config` and `@aburi/plugin-registry` are bumped for the `ComponentId` pattern change
  in `aburi.config.v1.json` and for the `@aburi/types` dependency, respectively; neither has a
  source diff.

  ### For plugin authors

  `SymbolCandidate.id` and `OwnerSummary.id` are `SymbolId` rather than `string`. A language
  plugin that already builds ids with `makeSymbolId` — as `@aburi/lang-typescript` does —
  needs no change. One that concatenates the parts itself will stop type-checking and should
  switch to the constructor, which enforces the `ir-schema.md` §3.1 grammar it was assuming.

- df2f3ec: Report why calls stay unresolved instead of dropping them silently.

  `docs/design/slice-view.md` §5.4 gives calls with `resolved: null` no `CallEdge`,
  so a Controller → Service pair whose link the resolver could not identify shows
  up as two unrelated singleton Slices. The behaviour is intentional and unchanged
  — what was missing is any way for a reviewer to tell that apart from a genuinely
  disconnected change. This implements the diagnostic surface
  `docs/design/call-resolution.md` §8.1 had specified but left unbuilt, and with it
  the previously unsatisfiable test criteria CR27 / CR28 / CR29 of §10.4.

  `resolveCallGraph` now classifies every unresolved call into one of the five
  §8.1 buckets — `local-scope`, `external`, `dynamic`, `ambiguous`, `no-match` —
  using a fixed precedence so an unchanged workspace always reports the same
  numbers. Which calls resolve, the `CallEdge[]` they produce, and the resulting
  `slices[]` are all byte-identical to before.

  Surfaces:

  - `aburi scan` and `aburi diff` print one stdout line, e.g.
    `calls 1310 · resolved 1203 · unresolved 107 (external 30 · dynamic 60 · no-match 17)`.
    Zero-valued buckets are omitted. When the head IR predates the counter,
    `aburi diff` omits the line rather than printing misleading zeroes, and says so
    on stderr so the absence is not itself silent.
  - The `## 🧵 Slice View` section of `out/diff.md` gains a note when any member
    carries unresolved calls, plus a `⚠ N unresolved calls` marker on the affected
    members and singletons. Computed from the IR Symbols the diff already embeds —
    `aburi.diff.v1.json` is unchanged and `SliceRecord` gains no field.
  - `aburi explain <symbol> --debug-resolution` renders a `## Call resolution`
    table with the per-call bucket and, for `ambiguous`, the competing candidates.
    Per-call reasons are not persisted in the IR (§8.1), so the flag always
    rescans and is rejected alongside `--no-rescan` or `--ir`.

  No CI gate and no tuning knob was added: `--fail-on` is untouched, and
  `--debug-resolution` changes only what is printed
  (`docs/design/overview.md` §2, `slice-view.md` §14.7).

  Schema addition (non-breaking, additive per `ir-schema.md` §15.2): `Stats` grows
  an optional `callResolution` object holding `totalCalls`, `resolvedCalls`, and
  the five `unresolved` bucket counters. It is optional so documents produced
  before the field existed stay valid v1, but the current scan pipeline always
  emits it. New IR integrity invariant #15 re-derives all three numbers from
  `symbols[]`, so the census cannot drift from the document it describes.

  Public API additions:

  - `@aburi/types`: `CallResolutionStats` and `UnresolvedCallBuckets` (generated
    from the schema), plus the non-schema `UnresolvedCallBucket` /
    `UnresolvedCallDiagnostic` records. `CallCandidate` gains an optional
    `dynamicReceiver` flag — language plugins set it when the callee's receiver was
    an expression (`getRepo().save()`), which normalization otherwise collapses
    into something indistinguishable from a qualified name.
  - `@aburi/core`: `resolveCallGraph` returns `stats` and `diagnostics` alongside
    `symbols` / `edges`, accepts an optional `dynamicCallSites` input, and exports
    `makeCallSiteKey`. `ScanResult` gains `unresolvedCalls`.
  - `@aburi/markdown-projection`: `formatCallResolutionLine`, and an optional
    `unresolvedCalls` field on `ProjectSymbolExplainContext`. Explain output is
    byte-identical when it is omitted.
  - `@aburi/cli`: `DiffReport.callResolutionLine`, `ScanReport.callResolutionLine`
    / `ScanReport.unresolvedCalls`, and `ExplainOptions.debugResolution`.
  - `@aburi/lang-typescript`: reports `dynamicReceiver` for call, subscript, and
    parenthesized-expression receivers. Call target strings are unchanged, so no
    fingerprint moves.

- c913783: Enforce the `SliceRecord.id` anchor derivation instead of trusting it.

  `docs/design/slice-view.md` §7.1 defines a Slice id as `"slice:" + members[0]`,
  but `aburi.diff.v1.json` only constrains it with `pattern: "^slice:"`. Neither
  the derivation nor the §8.2 ascending `members[]` order can be written in
  JSON Schema 2020-12 — both compare one property against another — so
  `{ id: "slice:foo", members: ["bar", "baz"] }` validated cleanly, and a reader
  that reconstructed the anchor from the id would name a Symbol the Slice does
  not contain. `computeSlices` also had no post-condition of its own: that
  `members[0]` is the lexicographically smallest member held only because
  `computeWeaklyConnectedComponents` sorts each component, one layer below the
  pass and invisible from it.

  The derivation now lives in exactly one function, and `computeSlices` validates
  every `SliceRecord` it builds before returning it — an empty `members[]`, a
  non-strictly-ascending `members[]`, or an `id` that is not `"slice:" +
members[0]` raises `DiffError` with the new code `slice-invariant-violated`.
  Emitted output is byte-identical to before; the check only fires on a producer
  bug. `docs/design/slice-view.md` gains §7.4 describing the three enforcement
  layers, §8.2 now states that the member order is strictly ascending and why,
  and §13.7 adds the test criteria SV23–SV25.

  Public API additions:

  - `@aburi/diff`: `sliceAnchor(record)` returns `members[0]` — the anchor — and
    never derives it from `id`, so no consumer has a reason to strip the `slice:`
    prefix. `sliceRecordViolation(value)` takes `unknown` and reports which
    clause broke as a `SliceRecordViolation` (`kind` / `subject` / `message`), so
    a validator can classify a verdict without parsing prose and cannot crash on
    the untyped documents it exists to reject.
    `assertSliceRecordInvariant(record)` is its throwing form.
  - `DiffErrorCode` grows `"slice-invariant-violated"` (code additions are
    non-breaking).
  - `@aburi/cli`: `classifyDiffError(error)` maps a `DiffError` onto the exit-code
    table. `slice-invariant-violated` now exits 1 as a `runtime-error` naming
    itself an Aburi bug, instead of exit 2 as a `config-error` that would send the
    reader searching `aburi.json` for a fault that is not there. Every other
    `DiffError` keeps its existing exit 2.

  `@aburi/core` documents the two output-ordering guarantees
  `computeWeaklyConnectedComponents` has always provided — each component sorted
  by ascending key, components sorted by their first element — since Slice View's
  anchor rule depends on the first of them. `@aburi/markdown-projection` replaces
  a `members[0] as string` cast with a real check; it still reads `members[0]`
  directly rather than importing `sliceAnchor`, keeping the renderer free of a
  dependency on the engine that produces what it renders.

  `schema/aburi.diff.v1.json` is unchanged apart from two `description` strings
  recording that `id` is derived and that consumers read `members[0]`; those flow
  into the generated `SliceRecord` doc comments in `@aburi/types`. No keyword was
  added to the schema file: v1 is frozen and published for validators outside
  this repository, and a non-standard keyword there would make every strict-mode
  validator reject the schema itself. The derivation check is instead registered
  as an Ajv keyword by the validating consumer — `packages/diff/test/schema.test.ts`
  layers it onto the shipped schema and rejects a wrong anchor the same way a
  wrong prefix is rejected.

### Patch Changes

- f5cb552: Add `@aburi/framework-react`, a new framework plugin that classifies React
  sources into seven `framework:react:*` extKinds so React codebases (Vite / CRA
  / library authors — not just Next.js App Router) can be scanned by Aburi.

  Recognised shapes (first-match-wins in the order listed):

  - `framework:react:hook` — `/^use[A-Z]/` naming, with an extra `hook-call`
    `derivedBy` signal when the body calls another `use*` function
  - `framework:react:context` — `const X = createContext(...)` / `React.createContext(...)`
  - `framework:react:forward-ref` — `const X = forwardRef(...)` / `React.forwardRef(...)`
  - `framework:react:memo` — `const X = memo(...)` / `React.memo(...)`
  - `framework:react:provider` — PascalCase function whose returned JSX has
    `<X.Provider>` at its root
  - `framework:react:hoc` — `/^with[A-Z]/` naming
  - `framework:react:component` — PascalCase function whose body returns JSX
    (fallback)

  Detection is decorator-free: signals come from the symbol's name (leaf-of-qname
  regex), its `bodyNode` (tree-sitter walker looking for `jsx_element` /
  `jsx_self_closing_element` / `jsx_fragment`), and its `fullNode` (pre-order
  walk finding the outermost `call_expression` for the const-wrapper family). The
  plugin duck-types the tree-sitter node surface rather than depending on
  `web-tree-sitter` directly.

  `@aburi/lang-typescript`: extends `fileExtensions` and the internal
  `EXTENSION_GRAMMAR` map to accept `.js` / `.mjs` / `.cjs` (TypeScript grammar,
  permissively) and `.jsx` (tsx grammar, JSX-aware). This is what lets
  `@aburi/framework-react` classify React sources in plain-JavaScript codebases.

  `@aburi/cli`: `aburi init --with-suggestions` now maps a detected `react`
  framework to `@aburi/framework-react` alongside the existing `nestjs` /
  `nextjs` entries.

- 14bcd59: Settle what "no value" looks like in the IR, and make every writer say it the same way.

  `aburi.ir.v1` had two ways to spell an absent value and no rule for choosing between them. `SourceRange.startColumn` was written as an explicit `null`, `Signature.inferredThrows` had its key dropped entirely, and `Symbol.component` was never written at all — three conventions inside one document, none of them stated anywhere. Consumers absorbed the cost: `Symbol.component` and `Symbol.signature` each forced a `x === null || x === undefined` check at every read site, because a field that can be absent _and_ null has three states standing in for two meanings.

  Those checks stay. Writers are now consistent, but a document written before that cannot be rewritten, and `aburi diff` reads a committed IR as its base — so the reader half of the rule ("an absent Class A key reads as `null`") is what carries compatibility, and every `?? null` in the core, diff and projection packages is that rule's implementation rather than clutter to be cleaned up. A regression test now pins it: an IR with the keys stripped still validates, still passes the integrity check, and still diffs clean against one that has them.

  `ir-schema.md` §1.1 now fixes the rule, and the classification follows mechanically from the declared type rather than from anyone's judgement: a nullable optional is **Class A** — the writer always emits the key, carrying `null` when there is no value, and a reader treats an absent key as `null`. A non-nullable optional is **Class B** — the key's presence is itself the signal, so the writer omits it rather than substituting `[]`, `false`, or `null`. Every optional property in the schema now states its class in its `description`, which reaches plugin authors as JSDoc on the generated types, and a test fails on any future optional that lands without one.

  The writers that disagreed with the rule now follow it. `Symbol.component` and `Component.description` are emitted as explicit `null`, so a detected Component and a configured one have the same shape. Two output changes come with that, both in `@aburi/cli`: every Symbol gains `"component": null` and every Component gains `"description": null`, and a config-declared Component **loses** `publicApi` / `frameworks` when they are empty, where it previously wrote `[]`. Fingerprints, dependencies and stats are byte-identical either way. A config entry that omits `languages` now falls back to `["ts"]` as detection already did, instead of writing an `[]` that the IR schema rejects.

  `SymbolCandidate.source` is typed as the new `WrittenSourceRange`, which requires both column keys. A language plugin that builds a `SourceRange` without them no longer compiles. This is the one breaking change here, and it is deliberate: `serializeCanonical` drops `undefined` properties, so an omitted column is invisible in TypeScript and visible only in the emitted bytes. Plugins that already write `startColumn: null, endColumn: null` — as the in-tree TypeScript plugin does — need no change. The read-side `SourceRange` stays optional on purpose, because an IR loaded off disk may predate the rule and must remain representable.

- efe3cbd: Bound every LSP write so a stalled pipe or a dead server cannot park the
  enrichment pass.

  `createLspClient` raced every request against a deadline but awaited its four
  notifications — `didOpen`, `didClose`, `initialized`, `exit` — unguarded.
  JSON-RPC treats a notification as fire-and-forget, but the write still awaits the
  transport, so backpressure on a stdio pipe stalls it exactly the way it stalls a
  request. `didOpen` was the load-bearing case: it precedes the file's first
  request and therefore precedes every `fileBudgetMs` check the pass makes, so a
  stalled open meant the per-file budget could never fire and the scan sat on that
  one file indefinitely.

  Notifications now reuse the budgets the caller already has rather than adding a
  knob of their own — `schema/aburi.config.v1.json` and the generated config types
  are unchanged, and no new threshold had to be guessed at:

  - `didOpen` is bounded by `fileBudgetMs`. An open that spends the whole budget
    has left nothing for the enrichment it exists to enable, so the budget is
    already the right ceiling; exceeding it is an ordinary per-file fallback. The
    pass also re-checks the budget immediately after `didOpen` returns, so an open
    that came back healthy but slow no longer gets to issue a `documentSymbol`
    request the budget cannot pay for.
  - `didClose` is bounded by `requestTimeoutMs` — a single small write with no
    enrichment riding on it, where giving up sooner starts the next file sooner.
    A failure is logged at debug level instead of being swallowed whole; it cannot
    change what the file produced, so it moves no counter and escalates nothing.
  - `initialized` is bounded by `initializeTimeoutMs`, and a write that never
    lands now fails `initialize` rather than returning a handshake that never
    completed. It draws the full budget rather than the request's remainder, so a
    wholly unresponsive server can cost two `initializeTimeoutMs` before its
    language is disabled — 20 s at the default, where it was 10 s.
  - `exit` is bounded by the 1 s shutdown grace period that `shutdown` already
    used for its request and its SIGKILL timer, now a single named constant.

  Writes addressed to a server already known to have exited fail immediately with
  `server-disconnected`, notifications included. Previously only `request` did
  this: `didOpen` returned quietly, so after a server crash every remaining file
  was opened against a dead pipe, failed its single `documentSymbol` request
  (one short of the three needed to escalate), and was counted in `filesEnriched`
  with nothing enriched in it. Because the per-file streak reset on each such
  file, the language was never disabled and the CLI — which warns only on
  `filesFellBack > 0` or a disabled language — printed nothing at all. A crash
  mid-scan now falls back per file and disables the language after five, which is
  what makes the degraded run visible.

  `LspClient.didOpen` / `didClose` take a `timeoutMs` argument — matching
  `request(method, params, timeoutMs)` — and return `LspFailure | null` instead of
  `void`. `null` rather than `undefined` is what makes the contract enforceable:
  an implementation cannot claim a write succeeded by falling off the end of a
  function, which is precisely the bug fixed above. Timing counters are untouched:
  a notification is not a request, so `requestsIssued` / `requestsTimedOut` /
  `requestsFailed` keep their meaning and a failed `didOpen` surfaces as
  `filesFellBack`.

  Two unbounded waits one layer down are closed with the same reasoning.
  `SpawnedServer.killAfter` awaited the child's exit with no deadline, so a
  process wedged in uninterruptible I/O — which does not answer SIGKILL either —
  pinned `shutdown` forever; it now returns after at most two grace periods
  whether or not the child was reaped. And `EnrichmentInput.now`, declared as the
  injectable clock but never actually read, is now what the per-file budget goes
  through, defaulting to `performance.now`: the budget measures elapsed time, and
  a wall clock stepped backwards by NTP would make it unable to fire, reopening
  the hang from another door.

  `@aburi/cli` reads `ABURI_LOG_LEVEL`. It was parsed into `AburiEnv.logLevel` and
  then dropped, while the scan logger hard-coded `debug` and `info` to no-ops —
  so a debug line was unreachable in the shipped binary no matter what the user
  set. Default output is unchanged (`warn` and above); `ABURI_LOG_LEVEL=debug` now
  reaches the passes that emit at that level, the degraded-`didClose` line among
  them.

  `docs/design/lsp-enrichment.md` gains the notification bounds in §4.4, states in
  §6.1 that a `didOpen` which exceeds its bound or addresses a dead server is a
  per-file fallback (and names `filesFellBack`, replacing a reference to an
  `lsp-degraded` marker that never existed in the code), and adds test criteria
  LE19–LE23.

- Updated dependencies [b2f4382]
- Updated dependencies [df2f3ec]
- Updated dependencies [57064a8]
- Updated dependencies [2c5366d]
- Updated dependencies [14bcd59]
- Updated dependencies [efe3cbd]
- Updated dependencies [be40074]
- Updated dependencies [c913783]
- Updated dependencies [f56e21b]
  - @aburi/core@0.2.0
  - @aburi/diff@0.2.0
  - @aburi/markdown-projection@0.2.0
  - @aburi/types@0.2.0
  - @aburi/config@0.1.1
  - @aburi/plugin-registry@0.2.0

## 0.1.0

### Minor Changes

- 15e3e49: Add the Aburi command-line entry — `@aburi/cli` — that wires `@aburi/config`, `@aburi/core`, `@aburi/diff`, and `@aburi/markdown-projection` into the commands defined in `docs/design/cli-spec.md`. Ships with a `bin/aburi.mjs` shim and a testable `runCli(argv)` surface so integration tests can drive the CLI without spawning a subprocess.

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

- 358f76f: Cut the initial `0.1.0` release of the Aburi ecosystem.

  This is the first public version of every workspace package that ships. The
  v0.1 scope defined in [`docs/roadmap.md`](https://github.com/kage1020/Aburi/blob/main/docs/roadmap.md)
  is complete:

  - **Foundation** — `@aburi/types` (schema-generated + hand-written interfaces),
    `@aburi/plugin-registry` (vocab registry + conflict enforcement),
    `@aburi/config` (JSONC + ajv-validated loader with framework-hint
    normalisation), `@aburi/core` (Symbol id, canonical JSON, 11 IR invariants,
    autodetect, scan orchestration).
  - **Language** — `@aburi/lang-typescript` (tree-sitter WASM TS/TSX plugin).
  - **Frameworks** — `@aburi/framework-nestjs`, `@aburi/framework-next`.
  - **Effects** — `@aburi/effects-prisma`, `@aburi/effects-nest`.
  - **Diff + projection** — `@aburi/diff` (5-stage semantic matcher +
    status + delta), `@aburi/markdown-projection` (workspace / component / diff
    / explain views).
  - **Delivery** — `@aburi/cli` (`aburi init | scan | diff | explain`, exit codes
    0 / 1 / 2 / 3, `--fail-on` gate), `@aburi/github-action` (composite action +
    marker-based PR comment upsert).

  ### Publishing pipeline
  - `.github/workflows/ci.yml` — matrix (ubuntu / macos / windows) runs Biome
    `check`, `typecheck`, `build`, `test` on every PR and every push to `main`.
  - `.github/workflows/release.yml` — on push to `main`, `changesets/action@v1`
    either opens a "Version Packages" PR (when there are pending changesets) or,
    if that PR was already merged, runs `pnpm release` (typecheck + test + build
    - `changeset publish`) to push every bumped package to npm.
  - Authentication uses [**npm Trusted Publishing**](https://docs.npmjs.com/trusted-publishers)
    (OIDC). No `NPM_TOKEN` secret is stored anywhere; pnpm 11.11.0 exchanges the
    workflow's OIDC token for a short-lived publish credential at publish time.
    Sigstore attestation is emitted via `provenance=true` in the workflow's
    `.npmrc`, and consumers verify tarballs with `npm audit signatures`.
  - `changesets/action` reads the `New tag: …` lines the publish command prints
    and creates a matching GitHub Release per per-package tag
    (`@aburi/<pkg>@0.1.0`).
  - Every public package.json carries `repository.directory` so npm links back
    to the correct monorepo subdirectory, plus explicit `author`, `homepage`,
    and `bugs` fields.

  ### One-time trusted-publisher setup (required before the first publish)

  For each of the 13 publishable `@aburi/*` packages, register a trusted
  publisher on npmjs.com pointing at this repository's release workflow:

  1. On the package settings page (e.g.
     `https://www.npmjs.com/package/@aburi/cli/access` — for a not-yet-published
     package, first do a one-time manual `npm publish` to reserve the name, or
     configure the trusted publisher on the org account before publishing).
  2. Under "Trusted Publisher", add:
     - **Provider**: GitHub Actions
     - **Repository**: `kage1020/Aburi`
     - **Workflow filename**: `release.yml`
     - **Environment**: leave blank (no environment gating today)
  3. Repeat for all 13 packages, or configure the trusted publisher on the
     `@aburi` org so newly-scoped packages inherit it.

  Once configured, no rotation, no secret storage, and no static credential is
  ever created. Revoking access is a one-click delete on the npm settings page.

  ### Consumer entry points at 0.1.0
  - `npm i -D @aburi/cli @aburi/lang-typescript @aburi/framework-<yours>`
    (see the [root README](https://github.com/kage1020/Aburi#readme) for the
    quick start).
  - `uses: kage1020/Aburi/packages/github-action@main` in a workflow to gate
    PRs on the semantic diff. The action is referenced by repo path (composite
    action convention), and the CLI version it invokes is picked by the workflow
    author via the `version` input, so future CLI patch releases roll out to
    consumers without a fresh action tag. When per-release ref pinning is
    wanted, use the per-package tag `changesets/action` creates
    (`@aburi/github-action@0.1.0`) — an unscoped `v0.1.0` tag is intentionally
    not published because `changeset publish` names monorepo tags per package.

### Patch Changes

- 596a347: Add `@aburi/github-action` — a composite GitHub Action that runs `aburi diff` on a
  pull request and upserts the resulting Markdown as a hidden-marker PR comment.

  ### Runtime shape
  - **Composite action** (`action.yml`). Consumers reference it via
    `uses: kage1020/Aburi/packages/github-action@<tag>`. The `@aburi/cli` binary is
    resolved through `pnpm dlx @aburi/cli@<version>`, so the CLI version is pinned by the
    workflow author rather than the action tag — a policy that lets us ship CLI patches
    without cutting a new action release.
  - **Steps**: input validation (`comment: true` requires markdown output) →
    refspec resolution (input `refspec` overrides; otherwise fall back to
    `pull_request.base.sha..pull_request.head.sha`) → `pnpm/action-setup` +
    `actions/setup-node` → `pnpm dlx @aburi/cli@<version> diff …` → PR-comment upsert
    via `actions/github-script@v7` → CLI exit-code propagation.
  - **Exit-code propagation**: the diff step captures the CLI's status without failing
    the step so the comment upsert can still run when `--fail-on` fired (exit `3`); a
    trailing step then re-exits with the captured code, so a triggered gate fails the
    PR check _and_ leaves the Markdown comment on the PR for the reviewer.
  - **Comment step guard**: the upsert only runs when the CLI exits with `0` (clean) or
    `3` (gate triggered) — the two cases where the CLI actually produced `diff.md`. On
    `1` (runtime) / `2` (input) the comment step is skipped so a missing artefact
    cannot bury the CLI's real failure inside a secondary `ENOENT`.

  ### Artefact filenames

  The action reads `diff.json` / `diff.md` from the CLI output directory. To keep those
  literals in sync with the CLI without silent drift, `@aburi/cli` now exports
  `DIFF_JSON_FILENAME` and `DIFF_MD_FILENAME` from a new `packages/cli/src/artifact-paths.ts`
  module (used by `runDiff` and imported directly by the action's parity test). Renaming
  either artefact on the CLI side now fails the github-action test at CI time instead of
  producing a green build that ENOENTs at runtime — this is why the change is packaged
  as a patch bump for `@aburi/cli` as well.

  ### Two comment-upsert implementations, one marker

  The composite action's `github-script` step and the exported `upsertPullRequestComment`
  helper are separate implementations that share the marker string
  `<!-- aburi:diff-comment -->` — a test asserts that the marker literal is identical in
  `src/comment.ts` and `action.yml`. The action step uses `github.paginate` from octokit;
  the helper uses raw `fetch` with GHES support. Neither invokes the other:

  - **`action.yml` github-script step (runtime)** — the code that actually runs inside
    the workflow. Uses `github.paginate` to walk the PR comment list, matches by marker,
    short-circuits on byte-equal body, otherwise PATCHes or POSTs. Not directly unit-testable;
    the manifest test proves the step is wired correctly (guarded by
    `inputs.comment == 'true'` + exit code, embeds the shared marker literal).
  - **`src/comment.ts` (`upsertPullRequestComment`, programmatic API)** — an exported
    library helper for callers who want to post Aburi-style diff comments outside the
    composite action (bespoke workflows, downstream tools). Uses raw `fetch` with an
    injectable `apiBase` for GitHub Enterprise Server. `buildApiUrl` normalises the base
    so a `/api/v3` mount path is preserved (a naïve `new URL(absolute, base)` would drop it).
    Full fake-fetch coverage in `test/comment.test.ts`.

  ### Silent failure eradication
  - **Byte-equal short-circuit**: when the existing comment body already matches, the
    action returns `unchanged` and skips the PATCH request — no notification bump on
    no-op re-runs.
  - **API errors are loud**: every non-2xx response from the GitHub REST API throws with
    the operation label, status code, and a 400-char response snippet — a token scope
    typo is loud rather than silent-drop-then-green.
  - **Non-array list response** (contract violation from the API) throws instead of being
    treated as "no comments".
  - **Missing `id`/`body`/`html_url`** in a create/patch response throws instead of
    writing back an invalid outcome record.

  ### Public API

  `upsertPullRequestComment`, `ensureMarker`, `ABURI_COMMENT_MARKER`, and the option /
  outcome types are re-exported from `@aburi/github-action` for callers who want to post
  Aburi-style diff comments programmatically without invoking the composite action.

  ### Inputs / outputs

  Inputs: `version` (default `latest`), `refspec`, `fail-on`, `config`, `output-dir`
  (default `out`), `format` (default `both`), `working-directory`, `comment`
  (default `true`), `token` (default `${{ github.token }}`), `node-version`
  (default `24`), `pnpm-version` (default `10`). Outputs: `diff-json-path`,
  `diff-md-path`, `cli-exit-code` (`0` clean / `1` runtime / `2` input / `3` gate or
  plugin — matches `packages/cli/src/exit-codes.ts`), `comment-id`, `comment-action`
  (`created` / `updated` / `unchanged`).

  ### Tests
  - `test/comment.test.ts` (14): `upsertPullRequestComment` create / update / unchanged
    / pagination / GET-error / POST-error / PATCH-error / null-body responses on POST +
    PATCH / bearer token / GHES apiBase / non-array response rejection.
  - `test/action-yml.test.ts` (12): required inputs and defaults, `pnpm dlx` command
    shape, comment step guarded by `inputs.comment == 'true'` + `cli-exit-code`, marker
    parity between YAML and `comment.ts`, exit-code propagation step, output
    declarations, refspec fallback rejecting non-PR events, `comment=true + format=json`
    validation, filename parity with `DIFF_JSON_FILENAME` / `DIFF_MD_FILENAME` from
    `@aburi/cli` (so a CLI-side rename fails here), exit-code table wording.

- 405dcfa: Ship the v0.1 documentation set.

  - **Root `README.md`** — rewritten from a status placeholder into a full quick
    start: install / init / scan / diff / GitHub Action, a "why not just `git diff`"
    motivation with the four canonical scenarios, an architecture-at-a-glance
    block that walks source → IR → derived views, and a package matrix pointing
    at every workspace member.
  - **Per-package `README.md`** — 12 new files (`@aburi/types`,
    `@aburi/plugin-registry`, `@aburi/config`, `@aburi/core`,
    `@aburi/lang-typescript`, `@aburi/framework-nestjs`, `@aburi/framework-next`,
    `@aburi/effects-prisma`, `@aburi/effects-nest`, `@aburi/diff`,
    `@aburi/markdown-projection`, `@aburi/cli`). Each covers the pitch, install,
    the shape of the API the package exports, and design-doc references.
    `@aburi/github-action` already had one and is untouched.
  - **`docs/cli-reference.md`** — operator-facing per-subcommand reference for
    `aburi init / scan / diff / explain`: flags, `--fail-on` grammar, exit-code
    table, environment variables, config discovery order, and programmatic entry
    points.
  - **`docs/plugin-development.md`** — walkthrough for authoring `LanguagePlugin`
    / `FrameworkPlugin` / `EffectPlugin`, the manifest contract, the two-signal
    layered gate convention for effect classifiers, testing pattern, and CLI
    loader resolution rules.

  Docs-only change. Patch-bump every public package so the `files: ["dist", "src",
"README.md"]` package.json entry ships the freshly written README when the
  next release is cut.

- Updated dependencies [19f2494]
- Updated dependencies [a8882f0]
- Updated dependencies [0445f93]
- Updated dependencies [8510fb1]
- Updated dependencies [969c4eb]
- Updated dependencies [f8598d1]
- Updated dependencies [121c177]
- Updated dependencies [7a6cfeb]
- Updated dependencies [115be7a]
- Updated dependencies [405dcfa]
- Updated dependencies [358f76f]
  - @aburi/types@0.1.0
  - @aburi/plugin-registry@0.1.0
  - @aburi/config@0.1.0
  - @aburi/core@0.1.0
  - @aburi/diff@0.1.0
  - @aburi/markdown-projection@0.1.0
