# @aburi/markdown-projection

Deterministic Markdown views derived from `aburi.ir.v1` and `aburi.diff.v1`.
Every rendering is a pure function of its input — same IR / same diff → same
bytes. Nothing here reads the filesystem or asks a plugin; downstream tools can
snapshot-test outputs without stubbing side effects.

## Views

| Function | Emits | Consumer |
|---|---|---|
| `projectWorkspace(ir)` | L0 workspace overview (component list + dependency edges) | `out/workspace.md` |
| `projectComponent(ir, component)` | L1 + L2 component detail (public API surface + module logic) | `out/components/<id>.md` |
| `projectDiff(diff)` | Review-facing PR summary (added / removed / changed / moved with confidence badges) | `out/diff.md`, PR comment |
| `projectSymbolExplain(symbol)` | Per-Symbol detail (rules / effects / calls / dropped fold-out) | `aburi explain` stdout |

Also exports the `formatTriggered` helper the CLI uses to phrase `--fail-on`
gate messages.

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
