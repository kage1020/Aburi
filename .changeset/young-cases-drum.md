---
"@aburi/lang-typescript": patch
---

Decode the escapes in a module specifier instead of deleting them

`readLiteralSpecifier` joined only a literal's `string_fragment` children, and tree-sitter puts
an escape in a sibling `escape_sequence` node — so the escape was deleted rather than decoded
and the reader handed back a shorter string that looked perfectly well-formed.

| written | before | now |
|---|---|---|
| `"\x2E/e"` | `/e` | `./e` |
| `"./a\u002Fb"` | `./ab` | `./a/b` |
| `"./a\tb"` | `./ab` | `./a` + TAB + `b` |

The first row is the one that costs the most. `isRelativeSpecifier` accepts a `./` or `../`
prefix and nothing else, so an escaped leading dot left a specifier that names a sibling file
bucketed as `external` — "out of reach by construction" rather than "we misread the string" —
and call resolution's relative tier never consulted the edge. The rest are edges pointing at
modules that do not exist, indistinguishable in the IR from ones that do. None of it produced a
diagnostic.

`decodeEscapeSequence` is a new unit with its own table: the control escapes, the quoted
characters, `\xHH` / `\uHHHH` / `\u{...}` (by code point, so an astral escape is not truncated
to its low 16 bits), the line continuation, and the identity case. It is wired into the
specifier reader only, and reaches the dynamic, re-export and require-equals paths with it.

**One behaviour change beyond decoding.** A literal that is nothing but a line continuation
decodes to the empty string, so it now hits the empty-specifier diagnostic instead of producing
an edge whose source was a backslash and a newline. A literal made only of *other* escapes
(`"\n\t"`) still gets an ordinary edge — the gate tests emptiness, not blankness.

An ill-formed escape never reaches the decoder: `"\uZZZZ"`, `"\u12b"`, `"\u{}"` and `"\xZZ"` parse
as ERROR nodes rather than `escape_sequence` and are already reported as recoverable syntax
errors. A literal made of nothing else still comes back as its own source text rather than as
the empty string, so the parser's syntax error stays the only thing said about it — calling it
empty as well would be a third diagnostic claiming the author wrote no module name, and they
did.

**A braced escape is different**: the grammar checks its shape, not its range, so
`"\u{110000}"` does arrive — and `String.fromCodePoint` throws a `RangeError` on it, which would
leave `parseFile`, land on the per-file boundary and cost the whole file. It is range-checked
and handled the way `\1` and `\8` are: an escape with no legal value comes back as its own text,
because inventing one would put a module name in the IR that the source does not contain.
Nothing downstream learns the specifier was illegal, which stays true of all three.
