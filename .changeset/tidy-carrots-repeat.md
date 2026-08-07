---
"@aburi/diff": minor
---

Refuse a repeated identity instead of answering with one entry missing

`buildDiff` keys three collections by identity — Symbols by `id`, Components by `id`,
Dependencies by the `(from, to, via)` triple — and checked none of them. A repeat did not
crash; it produced an answer:

- Two head Symbols under one id: stage 1's lookup map is last-write-wins, so the base Symbol
  paired with the second and the first appeared in neither `matched` nor `added` — `usedHead`
  then removed both. Base 1 / head 2 reported `changed: 1, added: 0`.
- Two base Symbols under one id: both found the same head Symbol, which was classified
  twice — `changed: 1` and `unchanged: 1` for one Symbol.
- The same past stage 1: stages 2 to 4.5 pair on other signals but track the base Symbols
  they have consumed by id, so a repeat was dropped there too.
- Two Components under one id: the second replaced the first in the lookup map, and the
  surviving pair compared roots belonging to different entries — a reported change between
  two revisions that agree.
- Two Dependencies on one triple: a spurious `added` + `removed` pair, which is exactly how
  §6.2 encodes a genuine direction or effect flip.

A missing Symbol is indistinguishable from one that was never there, so `buildDiff` now
raises `DiffError` with the new code `ir-identity-collision`, naming the side, the
collection, the repeated value and both positions:

```
baseIR.symbols[3] repeats the id "ts:src/a.ts#foo" first seen at index 1; stage 1 pairs
Symbols by id and every later stage tracks the base Symbols it has consumed by id, so a
repeat leaves one entry out of the diff entirely or classifies its counterpart twice
(ir-schema.md §14 #1).
```

Establishing an identity means reading it, so the same pass refuses an entry that is not an
object or whose identity fields are not strings. Both failures were reachable and neither
named the offending position: `symbols: [null]` reached `matchStageId` and failed on
`null.id`, and a lone Symbol carrying no `id` had nothing to collide with, passed, and
derived a Slice anchored on `undefined` — reported as `slice-invariant-violated`, the one
code the CLI presents as a bug in Aburi rather than in the caller's IR. Fields beyond
identity are still unchecked here; that is `checkIRIntegrity` #20's job, and the CLI applies
it when reading an IR off disk.

diff-algorithm.md §3.7 is the canonical statement of the rule, of why it is enforced at the
diff entry point as well as at extraction time, and of why the check is scoped to identity
rather than delegating to the whole integrity checker. The CLI maps the new code to
`config-error` (exit 2); `classifyDiffError` is now exhaustive over `DiffErrorCode`, so a
future code has to be placed in that table rather than defaulting into it.
