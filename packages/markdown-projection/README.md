# @aburi/markdown-projection

Deterministic Markdown views derived from `aburi.ir.v1` and `aburi.diff.v1`.
Every rendering is a pure function of its input — same IR / same diff → same
bytes. Nothing here reads the filesystem or asks a plugin; downstream tools can
snapshot-test outputs without stubbing side effects.

## Views

| Function | Emits | Consumer |
|---|---|---|
| `projectWorkspace(ir, options?)` | L0 workspace overview (component list + dependency edges); `options.suppressTimestamp` mirrors the CLI's `--no-timestamp` for reproducible snapshots. | `out/workspace.md` |
| `projectComponent({ component, symbols, dependencies })` | L1 + L2 component detail (public API surface + module logic). The single-argument form makes it explicit that the caller must have pre-filtered `symbols` / `dependencies` to the ones belonging to `component`. | `out/components/<id>.md` |
| `projectDiff(diff, { maxBytes? })` | Review-facing PR summary (added / removed / changed / moved with confidence badges), optionally capped to a byte budget | `out/diff.md`, PR comment |
| `projectSymbolExplain(symbol)` | Per-Symbol detail (rules / effects / calls / dropped fold-out) | `aburi explain` stdout |

Also exports the `formatFailOnClause` / `formatFailOnTriggered` helpers that
render `--fail-on` clauses and triggered outcomes into review-facing Markdown.
The CLI's stderr-facing phrasing (`formatTriggered`) is a separate helper
exported from `@aburi/cli` — the two are intentionally distinct so the
Markdown side stays projection-only and the CLI side stays terminal-friendly.

## Install

```bash
pnpm add @aburi/markdown-projection
```

## Usage

```ts
import {
  projectWorkspace,
  projectComponent,
  projectDiff,
  projectSymbolExplain,
} from "@aburi/markdown-projection"

const markdown = projectDiff(diffResult)
// review-ready Markdown with confidence badges + dropped Symbols folded under
// <details>. Boundary sections group by symbol status per the design.

const forAComment = projectDiff(diffResult, { maxBytes: 65507 })
// the same document, cut to fit: whole sections are dropped least-important-first (Syntax-only
// before Dropped changes, API changes last) and a note under the Summary names the ones that
// went. Never cut mid-string — that would halve a <details> block or a code fence. GitHub
// rejects a comment body over 65536 bytes outright, so the destination decides the budget;
// see the design.
//
// Two edges worth knowing:
//   - The title and the Summary line are never dropped, so a budget smaller than those plus the
//     note is not achievable: the document comes back over it, saying so in the note rather than
//     claiming a size it does not have.
//   - `maxBytes` must be a positive integer; anything else, `0` included, is a RangeError. No cap
//     is spelled by leaving the option out. (`max-bytes: 0` is the *action* input for that.)
```

## See also

- [`docs/design/markdown-projection.md`](../../docs/design/markdown-projection.md)
