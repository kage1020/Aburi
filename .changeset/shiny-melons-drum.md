---
"@aburi/cli": minor
"@aburi/core": patch
---

Say which files a scan lost and what to do about each, instead of a bare histogram

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
`parse-failed`, `parse-timeout`, `extraction-failed`, the sequence the schema docstring itself
uses — in the census line and in the groups alike. Insertion order is scan order, so the census
used to list its reasons in an order that depended on where in the workspace the losses happened
to sit.

**In `@aburi/core`, a timed-out file's detail now names the numbers.** It read
`extraction exceeded parseTimeoutMs`, a restatement of the reason, while the elapsed and the
budget — the pair that decides whether to raise the budget or go and look at the file — sat only
in the log line beside it. A machine-dependent number is safe there because `detail` is never
projected into the Document; `stats.skippedFiles[]` still carries `path` and `reason` only, which
is what keeps two checkouts of one commit byte-identical.
