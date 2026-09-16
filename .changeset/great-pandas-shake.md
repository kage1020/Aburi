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
routine; the IR truncates a condition only past 120 characters.

Every code span was written as `` `${value}` ``, which a value containing a backtick closes early:
`` guard: `key === `x-${plugin}:write` `` left its interior in the row as Markdown, and template
literals are everyday TypeScript. `inlineCode` is now the single way this package opens a span. It
takes one more backtick than the longest run inside the value, pads a space at each end when the
value itself opens or closes with a backtick or a space, and collapses newline runs to a space
because a span is one row. Every call site routes through it, and `codeFragment`'s block fence
widens the same way, so a source that contains a fence no longer closes the block early.

Table cells interpolated values whose schemas permit `|` — component ids and roots in the
workspace Components table, effect ids and components in the effect surface, call targets and
candidate ids in `aburi explain --debug-resolution`. GFM splits cells before it parses inlines, so
one pipe in a path shifted every column after it, code span or not. `tableCell` escapes `|` as
`\|` and maps newlines to `<br>`, and every cell in those three tables goes through it.

`inlineCode`, `fencedBlock` and `tableCell` are exported. `inlineCodeValue` keeps working as a
deprecated alias of `inlineCode`, which it has become.

The only output that changes for a document with no backtick, pipe or over-long payload in it is
none: the compact rule row, the one-backtick span and the three-backtick fence are all still what
those values render as.
