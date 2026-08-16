---
"@aburi/cli": minor
---

Report a scan's incidents from wherever the scan happened, and let its exit code out

`aburi explain` and `aburi diff` run a full scan of their own and threw the report away.
`warnOnScanIncidents` was called from one place — the `scan` command's action — so a file that
was over-size, unroutable, unreadable, timed out, withdrawn by its parse, or dropped because a
plugin threw was silently absent from what those two commands answered with. `ScanReport.exitCode`
was discarded along with it, so not even the `extraction-failed` gate fired for them.

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
`ScanOptions.warn` sink. It is the scan's incident, so it belongs to the scan rather than to one
of its three callers; a caller that supplies no sink gets no lines, which keeps an embedded scan
silent. `aburi diff` labels each of its two — `base ref "main"` and `head (working tree)` — because
the same incident means different things at each end, and because §6.4 scans the working tree as
the head whatever the ref spec calls it. The label sits after the glyph so `⚠` still starts every
warning, and the indented per-file listing under a line is left unlabelled.

**The exit code is about greenness, not about counts.** Since `stats.skippedFiles` landed, a
withdrawn file's Symbols classify as `unknown` rather than as deletions, so the diff was already
honest about what it did not know. What was wrong is that a workspace no plugin can parse turned
green by being asked for a diff instead of a scan. Both commands now inherit
`ScanReport.exitCode`, so a plugin exception exits `3` from all three.

Two decisions worth naming rather than leaving to be inferred:

- **A fault at the base ref gates too.** A broken base reddens every diff taken against it until
  the base moves. That cost is real, and it is still the right answer: a comparison with a broken
  half is not evidence about the half that worked.
- **For `explain`, exit `3` outranks the outcome.** A `single` hit may have had a competing
  candidate in the withdrawn file and should have been `2`; a `not-found` may be describing the
  withdrawal rather than the workspace. That second case is the headline one — `No matches` is
  otherwise indistinguishable from "that Symbol does not exist".

`aburi diff` also gained a line with no counterpart in the artifact. A file whose parse reported
*recoverable* errors is in both documents, so it is in no `stats.skippedFiles` and nothing about it
becomes `unknown` — yet those errors may have cost it a declaration, leaving its Symbol set short
and moving `added` / `removed` with no file having gone missing. Only ref mode can say this:
`parseErrorCount` is a property of the scan, not of the document it wrote.

`DiffReport.faultedScans` names the sides, so a programmatic caller reads a field instead of
parsing warnings when `exitCode` is `3` and `triggered` is `null`.

Verification: 16 new tests in `packages/cli/test/scan-incidents.test.ts`, driven by a language
plugin the fixture writes into the workspace — no in-tree plugin will refuse a file or throw on
demand. The ref-form tests materialise the base worktree for real from the injected `GitRunner`,
so both scans have something to scan. One of them pins `aburi scan`'s stderr byte-for-byte, which
is what keeps the move from quietly changing what a reader sees.
