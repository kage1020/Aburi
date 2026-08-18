---
"@aburi/diff": minor
"@aburi/markdown-projection": minor
"@aburi/types": minor
---

Stop reporting a lost file's dependency edges as deletions

`SymbolChange.status: "unknown"` stopped `aburi diff` reporting a withdrawn file's Symbols as
deleted API. `dependencies[]` had the identical defect and was untouched by it.

`IR.dependencies` is projected from the resolved call graph, so a Symbol that never reached a
document takes every edge it participated in with it. `diffDependencies` compared the two arrays
by `(from, to, via)` and reported whatever the head lacked as removed:

```
base                       → gone.ts#gone → kept.ts#kept, kept.ts#kept → gone.ts#gone
head, src/gone.ts withdrawn → (neither edge)

summary.removed:     0     ← correct since stats.skippedFiles landed
summary.depsRemoved: 2     ← two dependencies nobody deleted
```

The second edge is the half that is easiest to miss. `kept` is in both documents, so the edge
reads as a call the author removed; it disappeared because the *callee's* file was never read.

An edge one document holds is now `unknown` when the other never analysed the file an endpoint
lives in, carrying `absentFrom` on the same reading as the Symbol side and `lostFiles[]` naming
the files with the reason each was skipped.

**Where it differs from the Symbol side, and why**

- **The endpoint's file comes from the document that holds the edge**, read out of
  `symbols[].source.file` rather than out of the id's path segment. That is the same space
  `stats.skippedFiles[].path` is in and the same space Symbols are classified by, so a Symbol
  reported `unknown` and the edges it took with it cannot disagree about which file went
  missing. Parsing the id would have been a second answer to the same question, and nothing in
  the schema forces the two to agree.
- **`lostFiles` is a list where `SymbolUnknown` carries one `reason`.** An edge has two
  endpoints: they can sit in two files skipped for two different reasons, one saying re-run and
  the other saying fix something. An intra-file edge collapses to the single file it lost.
- **Component-level edges are never reclassified.** A Component is an aggregate over roots and
  has no file to lose, so a component endpoint is simply absent from the lookup — no special
  case, and now stated in `docs/design/diff-algorithm.md` §6.2.1 rather than left to be
  rediscovered as an asymmetry.

A direction or effect flip stays an added + removed pair, with no loss check. Not because
neither document lost an endpoint file — nothing forbids a path from being both a `source.file`
and a skipped one — but because both documents *hold* the edge, so neither is silent about it,
and `unknown` explains silences.

`dependencies.unknown[]` and `summary.depsUnknown` are schema-optional only so a diff written
before they existed stays valid. A current writer always emits both, empty array and zero
included — unlike the IR's `stats.skippedFiles`, no arithmetic elsewhere in the document would
let a reader tell "nothing was unknown" from "this writer could not say".

`diff.md` gains an `### Unknown — the other revision never read one end` group under Dependency
changes, each line naming the file and the reason. It is not split by level the way the added and
removed groups are, because only a Symbol endpoint has a file to lose.

**Not in scope.** `--fail-on` has no dependency token — none exists for `depsAdded` or
`depsRemoved` either — so the harm here was to `diff.json` consumers and to the Dependency
changes section, not to the CLI gate. Adding a dependency gate family is its own decision. And a
file **both** revisions skipped still produces nothing: neither document holds an edge from it,
so there is no leftover to classify, which is the deps-side face of a gap `aburi diff` reports on
stderr and the artifact does not.

`diffDependencies`' new `sides` parameter is **required**. Optional, it would have restored the
defect silently: a two-argument call classifies every edge into a lost file as a deletion again
while still writing `unknown: []`, which this schema defines as "nothing was unknown" rather than
"nobody looked". A caller with no skip list says so by passing a side view whose `lostFiles` is
empty. `dependencySideView(ir)` is exported to build one, and is the single construction site —
`buildDiff` feeds the same object to its own Symbol classification, so the two cannot drift.

For a direct caller the classification of any edge is unchanged when the side views carry no
losses; the returned object gains an always-present `unknown` array it did not have before, which
a deep-equal or a snapshot will see.

Verification: 18 tests in `packages/diff/test/unknown-dependencies.test.ts`, four ajv instance
tests, a canonical byte-stability case that reverses the input order, and four projection tests.
Two of the diff tests exist because the rest of the file could not see the difference between
resolving an endpoint through `source.file` and parsing its id: every other fixture has the two
equal by construction, so they use a Symbol whose id says `src/old.ts` and whose `source.file`
says `src/actual.ts`, in both directions.
