# @aburi/diff

Aburi diff engine. Takes two IRs (base + head) and emits an `aburi.diff.v1`
projection: matched Symbol pairs, per-Symbol status + delta, Component / Dependency
diffs, and canonical JSON output. Pure — write-to-disk is delegated to the caller
so mid-pipeline gate evaluation can happen before serialisation.

## 5-stage matcher

Symbols are paired across base / head via cascading stages:

1. **id-match** — `<language>:<path>#<qname>` equal → same Symbol.
2. **git-rename** — optional table (from `git diff --find-renames`) rescues moved
   files whose ids diverged only in the path segment.
3. **logic-fingerprint** — remaining Symbols of the same kind with the same
   `fingerprint.logic` hash pair up (rename-invariant, whitespace-invariant). Where
   that logic names nothing (a class, a body that only calls something), unrelated
   bodies share the hash, so a pair there also needs names of two words or more
   with a similarity of 0.85.
4. **name+signature** — same simple name + compatible `Signature` (input/output
   set + throws) — the fuzzy layer.
5. **dropped-weak** — last-resort match for pairs where both sides are dropped
   (e.g. two empty stubs with matching qnames).

Unmatched base Symbols become `removed` and unmatched head Symbols `added`,
unless the other side never analysed the Symbol's file (`stats.skippedFiles`):
then the Symbol is `unknown`, with `absentFrom` and the skip `reason`, rather
than a deletion or an addition. Matched pairs are classified into one of five
statuses per [`docs/design/diff-algorithm.md`](../../docs/design/diff-algorithm.md):
`unchanged` / `moved` / `changed` / `moved+changed` / `dropped-toggled`
(with `to-dropped` / `to-kept` direction).

Per-Symbol delta records what specifically changed: array deltas for rules,
effects, calls, decorators and the names the Symbol is exported under
(`exportedAs`), a signature delta, a middleware delta when either side names
middleware, the three fingerprint bits `apiChanged` / `logicChanged` /
`syntaxChanged`, and `componentChanged` / `visibilityChanged` /
`confidenceChanged` for the Symbol's Component, visibility and confidence.

## Install

```bash
pnpm add @aburi/diff
```

## Usage

```ts
import { buildDiff, writeCanonicalDiff } from "@aburi/diff"

const diff = buildDiff({
  baseIR,
  headIR,
  base: { ref: "main", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
  head: { ref: "HEAD", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
  gitRenames: null,          // optional: { oldPath: newPath } table
})

diff.summary
// { added, removed, moved, movedChanged, changed, droppedToggled, ... }

await writeFile(".aburi/diff.json", writeCanonicalDiff(diff), "utf8")
// Or, to mirror `aburi diff --compact`:
await writeFile(".aburi/diff.json", writeCanonicalDiff(diff, { format: "compact" }), "utf8")
```

## See also

- [`schema/aburi.diff.v1.json`](../../schema/aburi.diff.v1.json)
- [`docs/design/diff-algorithm.md`](../../docs/design/diff-algorithm.md)
