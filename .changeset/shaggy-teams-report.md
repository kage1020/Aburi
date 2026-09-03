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
resolver's component-scope tier keys on it. That tier used to see every Symbol in one "no
component" bucket, so call resolution moves in both directions on a multi-package workspace:

- A qualified name declared in **two packages at once** now resolves, inside the caller's own
  component. The two candidates used to make both the component tier and the workspace tier
  ambiguous, so the call resolved to nothing at all — visible in `symbols[].calls[].resolved`,
  in `dependencies[]`, and in the `ambiguous` bucket of `stats.callResolution`.
- A qualified call **crossing a package boundary** now falls through the component tier to the
  workspace one, so its edge carries `low` confidence where it carried `medium`. The callee is
  the same and the tier is internal — `CallEdge.confidence` is not serialized — but it is the
  weaker claim, and the honest one: nothing about two packages says they are one scope.

Dropped Symbols are attributed like kept ones — a drop describes a Symbol's shape, not where it
lives. A Symbol whose component changed with no edit to its code stays `unchanged`, since status
is decided by the fingerprints and the path: re-rooting a package in the config must not report
every Symbol under it as a change somebody made.

`FilePipelineInput` gains a required `component: ComponentId | null`, and
`buildComponentAttribution` is exported for callers driving the pipeline themselves. Required
rather than optional because "outside every Component" and "this caller never said" are different
facts, and an optional key would spell them the same way — attributing a whole scan to nothing on
a caller that simply forgot it.
