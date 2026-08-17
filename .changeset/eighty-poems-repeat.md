---
"@aburi/cli": minor
---

Report a scan's incidents from wherever the scan happened, and let its exit code out

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
*recoverable* errors reached the IR rather than `stats.skippedFiles`, so nothing marks it and
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
