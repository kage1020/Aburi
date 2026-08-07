---
"@aburi/diff": minor
---

Refuse a repeated identity instead of answering with one entry missing

`buildDiff` keys three collections by identity and reads each key once per entry: the
5-stage matcher pairs Symbols by `id`, `diffComponents` maps Components by `id`,
`diffDependencies` maps Dependencies by the `(from, to, via)` triple. None of the three was
checked, and a repeat did not crash — it produced an answer:

- Two head Symbols under one id: stage 1 paired the first and then removed *both* from
  `remainingHead`, so the second appeared in neither `matched` nor `added`. Base 1 / head 2
  reported `changed: 1, added: 0`.
- Two base Symbols under one id: both found the same head Symbol, which was classified
  twice — `changed: 1` and `unchanged: 1` for one Symbol.
- The same in stages 3, 4 and 4.5, which track consumed base Symbols in a `Set<SymbolId>`.
- Two Components under one id: the second replaced the first in the lookup map, and the
  surviving pair compared roots that belong to different entries — a reported change between
  two revisions that agree.
- Two Dependencies on one triple: a spurious `added` + `removed` pair, which is exactly how
  §6.2 encodes a genuine direction or effect flip.

A missing Symbol is indistinguishable from one that was never there, so `buildDiff` now
raises `DiffError` with the new code `ir-identity-collision`, naming the side, the
collection, the repeated value and both positions:

```
baseIR.symbols[3] repeats the id "ts:src/a.ts#foo" first seen at index 1; the 5-stage
matcher pairs Symbols by id, so a repeat leaves one entry out of the diff entirely or
classifies its counterpart twice (ir-schema.md §14 #1).
```

Two decisions worth stating:

- **The check is scoped to identity, not delegated to `checkIRIntegrity`.** All three rules
  are Document invariants (ir-schema.md §14 #1, #2, #13) and `aburi diff` already enforces
  them when reading an IR off disk; the gap is a caller that assembles an IR in memory.
  Running the whole checker would also make `buildDiff` enforce sixteen rules — array
  ordering, effect vocabulary, Unicode normalisation — that a caller can break without
  changing the diff's answer. A test asserts each fixture against `checkIRIntegrity` so the
  restatement cannot drift from the rule it restates, and the Dependency check calls the
  same `dependencyKey` the diff itself keys on.
- **The entries are established as objects first.** The uniqueness scan is the first code to
  dereference each entry, so `assertIRShape` now checks that the collections hold objects
  rather than only that they are arrays — `symbols: [null]` used to reach the matcher and
  fail as `TypeError: Cannot read properties of null (reading 'dropped')`, naming neither
  the collection nor the index.

The CLI maps the new code to `config-error` (exit 2) through the existing default branch:
the offending value is in the input IR and the message names it.
