---
"@aburi/lang-typescript": patch
---

Stop reporting a type parameter's `in` / `out` variance modifier as a recoverable parse error

The typescript grammar `@vscode/tree-sitter-wasm` ships has no rule for TypeScript 4.7's variance
annotations, so `interface A<out T>`, `class E<in out T>` and `type F<out T> = …` were parse errors
in files `tsc` accepts. On `zod` that was every recoverable parse error the scan reported: 21 in 4
files, all in its `v4` schema declarations. No published release of the grammar has fixed it.

The same declarations written with and without their modifiers extract the same Symbols, with the
same signatures and calls. What the error cost was the signal, the same way the tsx grammar's `&`
did, so `collectParseErrors` now drops this shape too (`lang-plugin.md` LP27c). One thing the
grammar does lose, before and after this change: an annotated type alias's `normalizeAst` reads
the modifier where the parameter's name should be, so renaming that parameter does not change it.
The file just no longer says it is doubtful.

Recovery does not split an annotated parameter one way. Usually the modifier becomes the
parameter's name and the real name an ERROR after it, or inside it when there is a constraint or a
default; in some longer lists, `zod`'s among them, each `out` is the ERROR, before a parameter that
parsed clean. So the rule reads the words before the parameter's constraint and default back across
those pieces, and drops the ERROR only when they are `in`, `out` or `in out` and then one name, in
the type parameters of a class, an interface or a type alias. A `const` among them is allowed on a
class only, and a reserved word or a predefined type's name is not a name. A repeated or misordered
modifier, two names, `<out in>`, `interface A<const out T>`, a name after a constraint, a stray
token, and a modifier on a function's or method's own type parameters all still report, as `tsc`'s
parser rejects them too. The rule does not read a type alias's right-hand side, so
`type A<out T> = T`, which only `tsc`'s checker refuses, is dropped as well.
