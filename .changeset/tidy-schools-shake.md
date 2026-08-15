---
"@aburi/lang-typescript": minor
---

Refuse an empty module specifier instead of emitting an edge that names no module

`import x from ""` used to end the run. `readStringLiteral` returned `""` for an empty literal
and all three call sites guarded only on `null`, so every form the reader produces an edge for
produced one whose `source` names nothing, with no diagnostic:

```ts
import a from ""            // { source: "", symbols: ["a"] }
import ""                   // { source: "", symbols: "*" }
export * from ""            // { source: "", symbols: "*" }
export { X } from ""        // { source: "", symbols: ["X"] }
import type { B } from ''   // { source: "", symbols: ["B"] }
const p = import("")        // { source: "", symbols: "*", dynamic: true }
```

`ImportEdge.source` is contractually a non-empty specifier (`lang-plugin.md` §4.4), and the
shared guards in `@aburi/plugin-registry/plugin-input` throw when it is not. So the guard fired
on syntax a user can legally write — and because it fires inside a plugin, it took the whole
scan with it:

```
src/a.controller.ts   @Controller class, plus one `import x from ""`
src/b.service.ts      @Injectable class, nothing wrong with it

scan() → throws. No IR at all; `BService` is discarded along with the offending file.
```

The reach is wide: a decorator-driven framework plugin walks the edge list for every file
holding a decorated class or method, so any controller with a half-typed import ends the scan.
Before framework plugins read import edges, the throw needed an effect plugin *and* a call
candidate in the same file.

## What the plugin does instead

An empty specifier produces no edge and one **recoverable** `ParseError` at the literal's own
line and column, naming which construct it belongs to — `export * from ""` is not an import, and
being told that it is sends the author to the wrong line. The file keeps its Symbols: what
withdraws one is a parse that returned no tree at all, which this is not.

The diagnostic travels the channel a syntax error already uses, and reaches as far as that
channel goes — `ScanResult.parseErrors`, carrying the file, line, column and message. The CLI
renders parse errors as a count alone, so someone running `aburi scan` sees `1 file(s) had
recoverable parse errors` and has to read the programmatic result for the rest. That is an
existing gap in the reporting layer rather than something this change introduces.

Empty and absent stay apart. `readStringLiteral` returning `null` means the node was not a string
literal — a computed specifier (`import(p)`, `import("" + x)`) the reader does not follow, which
is not a fault in the source and gets no diagnostic. A literal that is present and empty is
something someone typed. Collapsing the two into one silent `null` is the drop this change exists
to stop, and it would also report a fault against perfectly good code.

The test is emptiness, not blankness: `import a from " "` still produces an edge, because `" "`
is a module name that will not resolve, which is the type checker's business. `tsc 6.0.3` reports
TS2307 for the value forms above and TS2882 for the bare side-effect import — all of them parse,
which is why they reach the extractor at all.

The guard in `plugin-input` is unchanged. A third defensive layer would hide the next producer
bug, which is the guard's whole job.

## What changes in the IR

Nothing disappears from `dependencies`: `ImportEdge`s are not serialized — they reach
`resolveCallGraph` and stop there, and an empty specifier was never relative, so no resolution
tier ever consulted it.

One second-order effect is visible. `bindsToExternalImport` buckets an unresolved call as
`external` when its head is bound by a non-relative import, and `""` counted as non-relative.
A call bound by the withdrawn edge now buckets as `no-match`, shifting `stats.callResolution` by
one. Neither bucket describes a broken specifier — `external` means "a bare package, out of reach
by construction" — and the parse error is the channel that does.

## Contract

`extractImports` now returns `{ edges, errors }` rather than `ImportEdge[]`. It is part of the
package's public surface, which is why this is a minor rather than a patch; `parseTypescriptFile`
is unaffected and merges the import errors into `ParseResult.errors` alongside the syntax ones.
