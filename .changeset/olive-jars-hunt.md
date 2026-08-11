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
comment nor a decorator.

Measured on one file of exported one-line functions, alternating between the two versions
so machine drift lands on both arms (min of three runs each, whole `scan`, ms):

| declarations | before | after | after (repeat) |
|---|---|---|---|
| 1,000 | 451 | 214 | 206 |
| 2,000 | 1232 | 304 | 326 |
| 4,000 | 12208 | 502 | 516 |

The exponent is the claim, not the digits: doubling the declarations multiplied the old
time by 2.7 and then 9.9, and the new one by about 1.5 both times — sub-linear, because a
fixed ~200 ms of startup dominates at this size. A 1.5 MB file of ~18,000 declarations, the
shape a generated API client or a Prisma type file has and comfortably inside
`maxFileSizeBytes`, now extracts in about 1.9 s where it had been taking minutes.

Two behaviour changes come with the rewrite rather than falling out of it.

**A comment no longer ends a decorator run.** Tree-sitter treats a comment as a named node
and puts it wherever it was written, including between two decorators or between the
decorators and the `export` keyword. Stopping there let a `// biome-ignore` or a TODO detach
`@Injectable()` from the class it decorates — silently, since decorators feed the framework
classifier, so the Symbol came out with the wrong `extKind` rather than with an error.
Comments are now skipped, the way `readCallArguments` already skips them. This also fixes
the same shape inside a class body (`class C { @A() /* note */ m() {} }`), which had been
losing its decorator since before this change.

**The `export_statement` special case is gone.** The grammar's rule is
`decorator* 'export' ['default'] declaration`, so a wrapped export's decorators are the
declaration's own preceding siblings and the named walk steps over the keywords to reach
them; the sweep-filter that used to handle it separately was doing the same job less
precisely.

Two placements the walk does not reach, pinned by tests here and closed in the change that
follows: a decorator on a declaration with no wrapper to hold it (`@A() class C {}` at top
level, or `export @A() class C {}`) is parsed as a *child* of the declaration rather than a
sibling, so it is not read.
