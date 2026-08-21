---
"@aburi/cli": minor
"@aburi/config": minor
"@aburi/types": minor
---

Stop reporting success for a scan that read almost none of the workspace

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
