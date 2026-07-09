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
| `projectDiff(diff)` | Review-facing PR summary (added / removed / changed / moved with confidence badges) | `out/diff.md`, PR comment |
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
// <details>. Boundary sections group by symbol status per §7 of the design.
```

## See also

- [`design/details/markdown-projection.md`](../../design/details/markdown-projection.md)
