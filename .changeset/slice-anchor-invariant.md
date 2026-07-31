---
"@aburi/cli": minor
"@aburi/core": patch
"@aburi/diff": minor
"@aburi/markdown-projection": patch
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
layers, §8.2 now states that the member order is strictly ascending and why,
and §13.7 adds the test criteria SV23–SV25.

Public API additions:

- `@aburi/diff`: `sliceAnchor(record)` returns `members[0]` — the anchor — and
  never derives it from `id`, so no consumer has a reason to strip the `slice:`
  prefix. `sliceRecordViolation(value)` takes `unknown` and reports which
  clause broke as a `SliceRecordViolation` (`kind` / `subject` / `message`), so
  a validator can classify a verdict without parsing prose and cannot crash on
  the untyped documents it exists to reject.
  `assertSliceRecordInvariant(record)` is its throwing form.
- `DiffErrorCode` grows `"slice-invariant-violated"` (code additions are
  non-breaking).
- `@aburi/cli`: `classifyDiffError(error)` maps a `DiffError` onto the exit-code
  table. `slice-invariant-violated` now exits 1 as a `runtime-error` naming
  itself an Aburi bug, instead of exit 2 as a `config-error` that would send the
  reader searching `aburi.json` for a fault that is not there. Every other
  `DiffError` keeps its existing exit 2.

`@aburi/core` documents the two output-ordering guarantees
`computeWeaklyConnectedComponents` has always provided — each component sorted
by ascending key, components sorted by their first element — since Slice View's
anchor rule depends on the first of them. `@aburi/markdown-projection` replaces
a `members[0] as string` cast with a real check; it still reads `members[0]`
directly rather than importing `sliceAnchor`, keeping the renderer free of a
dependency on the engine that produces what it renders.

`schema/aburi.diff.v1.json` is unchanged apart from two `description` strings
recording that `id` is derived and that consumers read `members[0]`; those flow
into the generated `SliceRecord` doc comments in `@aburi/types`. No keyword was
added to the schema file: v1 is frozen and published for validators outside
this repository, and a non-standard keyword there would make every strict-mode
validator reject the schema itself. The derivation check is instead registered
as an Ajv keyword by the validating consumer — `packages/diff/test/schema.test.ts`
layers it onto the shipped schema and rejects a wrong anchor the same way a
wrong prefix is rejected.
