---
"@aburi/lang-typescript": patch
---

Read a declaration's leading comments and decorators from the declaration, not from the file

`readLeadingJsDoc` and `collectDecoratorNodes` ask the same question — *the run of siblings
immediately before this declaration* — and both answered it by reading the parent's whole
child list and searching it for the declaration's own position.

`children` and `namedChildren` are not field reads. Each unmarshals every child across the
WASM boundary into a fresh JS object, and caches the result on one JS wrapper, so the next
`node.parent` pays for the list again. The parent of a top-level declaration is the entire
program: a file of N declarations paid O(N) per declaration.

Both now walk backwards from the node with `previousSibling` / `previousNamedSibling`, which
stops when the run ends — nearly always immediately, since most declarations carry neither a
comment nor a decorator. Same answers; the boundaries are pinned by tests rather than by the
two readings happening to agree.

Measured on one file of exported one-line functions, alternating between the two versions
so machine drift lands on both arms (min of three runs each, whole `scan`, ms):

| declarations | before | after | after (repeat) |
|---|---|---|---|
| 1,000 | 451 | 214 | 206 |
| 2,000 | 1232 | 304 | 326 |
| 4,000 | 12208 | 502 | 516 |

The exponent is the claim, not the digits: doubling the declarations multiplied the old
time by 2.7 and then 9.9, and the new one by about 1.5 both times — sub-linear, because a
fixed ~200 ms of startup dominates at this size.

At the size the report described — 18,000 declarations in 1.5 MB, a generated API client or
a Prisma type file, comfortably inside `maxFileSizeBytes` — the file now extracts in about
1.9 s. The old figure for that row is quoted from the report (2 m 0 s) rather than measured
here: repeated runs of the old code at 9,000 declarations spanned 41 s to 118 s on this
machine, which is too wide to report as a number.
