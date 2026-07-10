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
3. **logic-fingerprint** — remaining Symbols with the same `fingerprint.logic`
   hash pair up (rename-invariant, whitespace-invariant).
4. **name+signature** — same simple name + compatible `Signature` (input/output
   set + throws) — the fuzzy layer.
5. **dropped-weak** — last-resort match for pairs where both sides are dropped
   (e.g. two empty stubs with matching qnames).

Unmatched base Symbols become `removed`, unmatched head Symbols become `added`.
Matched pairs are classified into one of five statuses per
[`docs/design/diff-algorithm.md`](../../docs/design/diff-algorithm.md):
`unchanged` / `moved` / `changed` / `moved+changed` / `dropped-toggled`
(with `to-dropped` / `to-kept` direction).

Per-Symbol delta records what specifically changed: rules array delta, effects
array delta, calls array delta, decorators delta, signature delta, and the three
boolean summary bits `apiChanged` / `logicChanged` / `syntaxChanged`.

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

await writeFile("out/diff.json", writeCanonicalDiff(diff), "utf8")
// Or, to mirror `aburi diff --compact`:
await writeFile("out/diff.json", writeCanonicalDiff(diff, { format: "compact" }), "utf8")
```

## See also

- [`schema/aburi.diff.v1.json`](../../schema/aburi.diff.v1.json)
- [`docs/design/diff-algorithm.md`](../../docs/design/diff-algorithm.md)
