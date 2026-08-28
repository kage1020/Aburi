---
"@aburi/core": minor
---

One outcome per file, and one place a budget comes from

`FilePipelineResult` spread a file's fate across `terminalParseFailure: boolean` and
`parseTimeout: ParseTimeoutEvent | null`. Four combinations typechecked, three were reachable,
and the fourth was forbidden by a rule that lived in a comment — both fields feed `parsedFiles`
by different subtractions, so a result carrying each would have been counted out of it twice.

It is a union of three now: `ExtractedFile`, `WithdrawnFile` and `AbandonedFile`, discriminated
on `kind`. The variants carry what they actually have, which the widened product could only
describe as "empty here, present there": a withdrawn file has its `imports` and no `symbols` key
at all, an abandoned one has neither and carries its `ParseTimeoutEvent` non-null.

The discriminant strings are `SkippedFile["reason"]`'s two withdrawal values, so `scan.ts`
assigns `reason: result.kind` rather than restating them. Its two order-dependent `if`s become a
`switch` whose `default` is a compile-time `never` — the exclusivity that was a paragraph of
prose is what the type says now, and a fate added later is a type error rather than a file that
reaches neither the IR nor the skip list.

`FilePipelineInput.parseTimeoutMs` and `classifyTimeoutMs` are gone. They duplicated fields the
`config` on the same input already carried and existed only so a test could pass a budget without
building a `Config`, which meant the tested path and the production path were not the same path.
Both budgets are read from `config` now, the two conditional spreads in `scan.ts` that maintained
the duplication are gone, and the tests pass their budgets the way the CLI does.

`CoreErrorCode` gains `scan-outcome-unhandled` for the switch's compile-time guard to raise if it
is ever reached anyway.
