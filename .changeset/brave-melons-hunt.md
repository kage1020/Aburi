---
"@aburi/core": minor
"@aburi/cli": patch
---

Implement `config.parseTimeoutMs`, which the schema had documented and nothing read

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
