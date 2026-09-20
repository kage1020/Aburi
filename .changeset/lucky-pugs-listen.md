---
"@aburi/lang-typescript": patch
"@aburi/cli": minor
---

Make the recoverable-parse-error warning worth reading: stop counting the tsx grammar's `&`, and name the files

Two halves of one complaint. The warning that says a scan read files it could not fully parse
reported a bare count, and on a React codebase most of that count was the grammar rather than the
workspace.

**The grammar's `&`.** `@vscode/tree-sitter-wasm`'s tsx grammar reads `&` inside JSX as the
opening of an HTML character reference and raises an ERROR when no `;` closes it. So
`<CardTitle>Subscription & Billing</CardTitle>` and `href="/x?utm_source=a&utm_medium=b"` —
ordinary prose and a tracking URL — were parse errors, while `&amp;`, `&nbsp;`, an attribute whose
`&` stands alone and `{"a & b"}` were not. Measured on `shadcn-ui`, 110 of 3,912 `.tsx` files
carried a recoverable parse error and every one of them was this. 0.3.1 is the newest published
grammar, so no version bump settles it.

Nothing was lost by it and nothing is lost by dropping it: the same component written with `&` and
with `&amp;` extracts the same Symbols, the same signature and the same `calls[]`, including a call
written below the ampersand. What it cost was the signal — a warning that fires on 3% of files as a
matter of course stops being read — so `collectParseErrors` no longer reports that one shape
(`lang-plugin.md` LP27a).

The shape is narrow so a file that really was truncated is not dropped with it: the run the grammar
could not place has to open with an ampersand-led token *and* sit among a JSX element's children or
inside a JSX attribute's string value. A truncation raises its ERROR at `program`, outside both
positions, and still reports — including in a file that carries one of each, where
`export const U = () => <div><p>a & b</p>` now reports the unterminated `<div>` and nothing else.

**The files behind the count.** `⚠ N file(s) had recoverable parse errors.` was the whole warning,
and these files are in the IR, so `stats.skippedFiles[]` does not hold them and no per-file log
line is written for them either — there was nowhere to look up which files they were. Both `aburi
scan` and `aburi diff` now list them under that line, capped at ten with an `…and N more` tail like
every other listing, each with the position its parse came apart at and a count when more than one
error was reported. `aburi diff` puts the side on every entry, because the two scans read different
trees and a path doubtful on one side and clean on the other is the likeliest cause of the added /
removed movement that line warns about.

Minor for `@aburi/cli` rather than patch: `ScanReport` gains a required `parseErrorFiles`, and
`parseErrorCount` is now its length rather than a separately derived number, so the two cannot
disagree.
