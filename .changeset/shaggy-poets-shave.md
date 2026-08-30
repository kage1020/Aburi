---
"@aburi/lang-typescript": patch
"@aburi/types": patch
---

Read the three import forms that lost their dependency edge

`import x = require('./m')`, an `import()` behind a magic comment, and an `import()` whose
specifier is a template all produced no `ImportEdge` and no diagnostic — a file importing only
through `require` looked import-free, and the calls through the missing binding fell out of
relative resolution into the `no-match` bucket with nothing saying why.

Each missed for its own reason. A require-equals hangs its specifier off an
`import_require_clause` rather than the statement's `source` field, so the reader found
nothing. A magic comment is a *named* node, so the first argument of `import()` was the comment
rather than the specifier. A template is a `template_string`, not a `string`, so the literal
reader refused it.

The require-equals edge is a **namespace** edge — `symbols: "*"` with the binding on
`namespaceBinding` — and not the default binding it superficially resembles. `x` names the
module object the way `import * as x from './m'` does, and call resolution acts on the
difference: the namespace arm strips the head off `x.foo()` and looks for `foo` in the target
file, where a `symbols: ["x"]` edge would send it looking for `x.foo` there, which the target
does not have. `dynamic` is false because the field means "written as `import()`" and this
form is not — and because both loops in `callgraph.ts` that read a file's edges skip a
dynamic one, the value is also what keeps this import in reach of call resolution.

A clause that did not parse is not read at all. The grammar admits nothing but a string
literal for the specifier, so `require("a" + b)` is a syntax error — but error recovery
leaves the operand it could read as a direct child of the clause with the `source` field
attached, and reading it would answer `a`. `require('./m', 'y')` would answer the second
argument.

A template *with* a substitution stays computed and stays silent, which is the boundary this
change is careful about: joining a substituting template's fragments would answer `"./"` for
`` `./${p}` `` — an edge to a module the author never named, and a worse answer than none.

An empty specifier written in either new form (`import x = require("")`, ``import(``)``) goes
through the same gate as `import("")` and is reported as the empty specifier it is.
`firstNonCommentChild` moves to `ast-helpers.ts`, where the decorator reader takes it too;
`imports.ts` drops its private `findChildByType`, a duplicate of `ast-helpers`' `findChild`.
