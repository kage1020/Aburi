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

Measured on one file of exported one-line functions, everything else held fixed:

| declarations | before | after |
|---|---|---|
| 4,000 | 4.9 s | 0.5 s |
| 9,000 | 23.6 s | 1.0 s |
| 18,000 | 96.3 s | 2.0 s |

The 18,000 row is the shape the report described: a generated API client or a Prisma type
file, 1.5 MB and well inside `maxFileSizeBytes`, that blocked CI for minutes. These are
wall-clock on a loaded developer machine; the claim is the exponent, not the digits.
