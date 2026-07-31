---
"@aburi/diff": minor
"@aburi/types": patch
---

Enforce the `SliceRecord.id` anchor derivation instead of trusting it.

`docs/design/slice-view.md` §7.1 defines a Slice id as `"slice:" + members[0]`,
but `aburi.diff.v1.json` only constrains it with `pattern: "^slice:"`. Neither
the derivation nor the §8.2 ascending `members[]` order can be written in
JSON Schema 2020-12 — both compare one property against another — so
`{ id: "slice:foo", members: ["bar", "baz"] }` validated cleanly, and a reader
that reconstructed the anchor from the id would name a Symbol the Slice does
not contain. `computeSlices` also had no post-condition of its own: that
`members[0]` is the lexicographically smallest member held only because
`computeWeaklyConnectedComponents` sorts each component, one layer below the
pass and invisible from it.

The derivation now lives in exactly one function, and `computeSlices` validates
every `SliceRecord` it builds before returning it — an empty `members[]`, a
non-strictly-ascending `members[]`, or an `id` that is not `"slice:" +
members[0]` raises `DiffError` with the new code `slice-invariant-violated`.
Emitted output is byte-identical to before; the check only fires on a producer
bug. `docs/design/slice-view.md` gains §7.4 describing the three enforcement
layers, and §13.7 adds the test criteria SV23–SV25.

Public API additions:

- `@aburi/diff`: `sliceAnchor(record)` returns `members[0]` — the anchor — and
  never reads `id`, so no consumer has a reason to strip the `slice:` prefix.
  `sliceRecordViolation(record)` reports why a record breaks the invariant (or
  `null`), and `assertSliceRecordInvariant(record)` is its throwing form; the
  pair mirrors `checkIRIntegrity` / `assertIRIntegrity` in `@aburi/core`.
- `DiffErrorCode` grows `"slice-invariant-violated"` (code additions are
  non-breaking).

`schema/aburi.diff.v1.json` is unchanged apart from two `description` strings
recording that `id` is derived and that consumers read `members[0]`; those flow
into the generated `SliceRecord` doc comments in `@aburi/types`. No keyword was
added to the schema file: v1 is frozen and published for validators outside
this repository, and a non-standard keyword there would make every strict-mode
validator reject the schema itself. The derivation check is instead registered
as an Ajv keyword by the validating consumer — `packages/diff/test/schema.test.ts`
layers it onto the shipped schema and rejects a wrong anchor the same way a
wrong prefix is rejected.
