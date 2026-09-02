---
"@aburi/core": minor
---

Every Symbol says which Component it belongs to

`Symbol.component` was `null` on every Symbol the scan produced, and the views that count by it
said so. A workspace of nineteen Symbols reported `0` against each of its components in
`workspace.md`, the effect-surface table's `components` column was `—` on every row, and
`out/components/api.md` was four header lines with nothing beneath them — reviewing a change at
the level of module boundaries did not work, which is the point of the per-component views.

The scan attributes each file to the Component whose `roots[]` entry is the longest whole-segment
prefix of it, and `null` stays the answer for a file under no root at all. Longest rather than
first, because nesting is ordinary: a workspace root that is a package of its own has
`roots: ["."]` containing every other component's root, so "the first root that matches" would
give the whole monorepo to it. Roots are matched by path segment, so `packages/api` does not
claim `packages/api-legacy/`, and two Components declaring one root are separated by the lower
`Component.id` rather than by the order the config listed them in.

The question is asked once per file rather than once per Symbol, which is also what puts the
answer in front of the plugins: an effect classifier reads it as `owner.component`, and the call
resolver's component-scope tier keys on it, so a qualified name now resolves against the
component that declares it rather than against one undifferentiated workspace bucket. Dropped
Symbols are attributed like kept ones — a drop describes a Symbol's shape, not where it lives.

`FilePipelineInput` gains a required `component: ComponentId | null`, and
`buildComponentAttribution` is exported for callers driving the pipeline themselves. Required
rather than optional because "outside every Component" and "this caller never said" are different
facts, and an optional key would spell them the same way — attributing a whole scan to nothing on
a caller that simply forgot it.
