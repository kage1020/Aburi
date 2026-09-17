---
"@aburi/markdown-projection": minor
---

Keep a value inside the Markdown construct that was meant to contain it

Three places where a value out of the IR escaped its construct, none of them needing an unusual
input to do it.

A rule payload over 80 characters renders as a fenced block, and `ruleRow` embedded that block in
the middle of `- guard: … (L5)`. A fence at column 0 ends the list item it sits in, so the `(L5)`
became a paragraph of its own and the rules below it restarted as a second list. Such a payload
now takes a second row shape — `- guard (L3):` with the fence indented two spaces into the item —
because the line tag has to move for the block to be last. Boolean guards above the threshold are
routine; ir-schema.md §8.2 truncates a payload only past 120 characters.

Every code span was written as `` `${value}` ``, which a value containing a backtick closes early:
`` guard: `key === `x-${plugin}:write` `` left its interior in the row as Markdown, and template
literals are everyday TypeScript. `inlineCode` is now the single way this package opens a span. It
takes one more backtick than the longest run inside the value, pads a space at each end when the
value itself opens or closes with a backtick or a space — which separates the value from the
delimiter run, and is safe because CommonMark strips one space from each end again when the
content both begins and ends with one — and collapses newline runs to a space because a span is
one row. Every call site routes through it, and `codeFragment`'s block fence widens the same way,
so a source that contains a fence no longer closes the block early.

Table cells interpolated values whose schemas permit `|`: component roots in the workspace
Components table, and call targets and candidate ids in `aburi explain --debug-resolution`. GFM
splits cells before it parses inlines, so one pipe in a path shifted every column after it, code
span or not. `tableCell` escapes `|` as `\|` — doubling any backslash run in front of it, which
would otherwise pair with the escape and hand the pipe back to the row scanner — and maps newlines
to `<br>`. Cells now reach a row only through `tableRow` / `tableHeader`, which escape every one
of them and keep the delimiter row as wide as the header.

**What changes in the output.** For a rule payload over 80 characters or holding a newline, the
row takes the fenced shape above. For any value that contains a backtick, the span around it is
wider; for one that opens or closes with a backtick or a space, it gains padding; for one holding
a newline, the newline is now a space rather than a broken row. For a table cell holding a pipe or
a backslash before one, the cell is escaped. A value that is present but empty renders as
`(empty)` where the row it belongs to previously showed two literal backticks — or, in the diff's
`signature.throws added` family, vanished entirely along with its row. Anything else renders byte
for byte as before.

**API.** `inlineCode`, `fencedBlock`, `tableCell`, `tableRow`, `tableHeader`, `fitsInline` and
`EMPTY_VALUE` are exported. `codeFragment` takes an `indent` so the block it returns can sit
inside a list item. `ruleRow` returns the lines of the row (`string[]`) rather than one string,
because a fenced payload occupies four of them and every caller joins its array with newlines.
`inlineCodeValue` and `inlineCodePath` are deprecated aliases of `inlineCode`, removed in 1.0.0.
Minor rather than patch: new exports, one changed signature, and a user-visible change to the
rule row shape, with nothing removed.
