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
carried a recoverable parse error and every one of them was this. No published grammar has fixed
it as of 2026-09, and the dependency is a `^0.3.1` range, so a fix would arrive on its own if one
ever shipped.

Nothing was lost by it and nothing is lost by dropping it: the same component written with `&` and
with `&amp;` extracts the same Symbols, the same signature and the same `calls[]`, including a call
written below the ampersand. What it cost was the signal — a warning that fires on 3% of files as a
matter of course stops being read — so `collectParseErrors` no longer reports that one shape
(`lang-plugin.md` LP27a).

The shape is narrow so a file that really was truncated is not dropped with it. The run the grammar
could not place has to open with an ampersand-led token, sit among a JSX element's children or
inside a JSX attribute's string value, and — among children — hold none of `{`, `}`, `<`, `>`,
which JSX text cannot contain. That last rule matters because tree-sitter merges an adjacent
unparseable stretch into one ERROR node: without it, an `&` earlier in the same children swallowed
everything after it, and `<div>a & } b</div>` went quiet. The four characters are ordinary inside
an attribute's string, so the rule does not reach there.

A truncation whose ERROR sits outside both positions still reports, including in a file that
carries one of each: `export const U = () => <div><p>a & b</p>` reports the unterminated `<div>`
and nothing else.

**The files behind the count.** `⚠ N file(s) had recoverable parse errors.` was the whole warning,
and mostly these files are in the IR, so `stats.skippedFiles[]` does not hold them and no per-file
log line is written for them either — there was nowhere to look up which files they were. `aburi
scan` now lists them under that line, each with the first error reported for it and a count when
there was more than one.

The listing is **uncapped**, unlike the skip census below it, and sits up with the other sections
whose entries exist nowhere else. Capping the only account of something is the loss rather than
the shape of it. `aburi diff` is unchanged here on purpose: it runs both scans, each report names
its own files with the side in the header, so the diff-level line stays a count and a consequence
rather than a third printing of every doubtful path.

Minor for `@aburi/cli` rather than patch: `ScanReport` gains a required `parseErrorFiles`.
`parseErrorCount` is kept, set from that list's length where the report is built.
