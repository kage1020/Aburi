---
"@aburi/core": minor
"@aburi/diff": minor
"@aburi/markdown-projection": minor
"@aburi/types": minor
---

Add Slice View clustering to `aburi diff`. Changed Symbols are grouped into
weakly-connected components over the union of base and head call edges
(Union-Find WCC), and rendered in `out/diff.md` under a new `## 🧵 Slice View`
section positioned between `## 🔧 Logic changes` and `## ➕ Added`. Each Slice
appears as a `### slice:<smallest-member-id>` heading with the member count
and one bullet per member (short qname, status label, `file:line`, and a `↳`
delta-axis summary). Singleton Slices collapse into one `<details>` "Standalone
changes" fold. Empty `slices[]` omits the Markdown section entirely.

Schema addition (non-breaking, additive per `ir-schema.md` §15.2): the
`aburi.diff.v1.json` output now carries an optional top-level `slices` array
whose entries are `{ id: string; members: string[] }`. The array is always
emitted (empty when no Node-eligible change exists).

Public API additions:

- `@aburi/core`: `computeWeaklyConnectedComponents<TNode>` (generic Union-Find
  WCC utility) and `reconstructCallEdgesFromIR` (rebuilds `CallEdge[]` from a
  scanned IR's `Symbol.calls[].resolved` fields).
- `@aburi/diff`: `computeSlices` + `SliceInput` — pure clustering function
  consumed by `buildDiff`.
- `@aburi/types`: `SliceRecord` re-exported from the package barrel.

No CLI flag was added and no `--fail-on` selector was extended, per
`docs/design/slice-view.md` §11.4 / §14.7. The `slices[]` output is deterministic,
idempotent, input-order-insensitive, and local under the guarantees enumerated
in §10 of the same document.
