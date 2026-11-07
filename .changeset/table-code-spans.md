---
"@aburi/markdown-projection": patch
---

Keep a backslash in front of a pipe as written inside a table's code spans, and a value of spaces alone whole in a code span

A call target or a component root holding `\|` showed up in the `aburi explain` call-resolution table and the `workspace.md` Components table with one backslash too many: GFM takes one backslash off every `\|` in a row, code spans included, and the cell had doubled the run as if it were outside a code span. `tableCell` now finds the code spans in a cell as CommonMark does and gives each pipe inside one exactly one backslash, so the span holds the value byte for byte. Outside a code span it escapes a pipe the Markdown leaves bare and keeps one the Markdown already escapes, so every cell reads as the same Markdown reads outside a table.

`inlineCode` no longer pads a value made of spaces alone, which CommonMark keeps whole, so `" "` renders as one space rather than three.
