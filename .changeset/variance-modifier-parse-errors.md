---
"@aburi/lang-typescript": patch
---

Stop reporting a type parameter's `in` / `out` variance modifier as a recoverable parse error

The typescript grammar `@vscode/tree-sitter-wasm` ships has no rule for TypeScript 4.7's variance
annotations, so `interface A<out T>`, `class E<in out T>` and `type F<out T> = …` were parse errors
in files `tsc` accepts. On `zod` that was every recoverable parse error the scan reported: 21 in 4
files, all in its `v4` schema declarations. 0.3.1 is the newest release of the grammar, so this was
not waiting on a version bump.

Nothing was lost by it: the same declarations written with and without their modifiers extract the
same Symbols, with the same signatures and calls. What it cost was the signal, the same way the
tsx grammar's `&` did, so `collectParseErrors` now drops this shape too (`lang-plugin.md` LP27c).

Recovery does not split an annotated parameter one way. Usually the modifier becomes the
parameter's name and the real name an ERROR after it, or inside it when there is a constraint or a
default; in some longer lists, `zod`'s among them, each `out` is the ERROR, before a parameter that
parsed clean. So the rule reads the words before the parameter's constraint and default back across
those pieces, and drops the ERROR only when, less one `const`, they are `in`, `out` or `in out` and
then one name, in the type parameters of a class, an interface or a type alias. A repeated or
misordered modifier, two names, a name after a constraint, a stray token, and a modifier on a
function's or method's own type parameters all still report, as `tsc` rejects them too.
