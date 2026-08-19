---
"@aburi/cli": minor
"@aburi/core": minor
---

Stop answering "No matches" out of an IR that says it never read the file

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
