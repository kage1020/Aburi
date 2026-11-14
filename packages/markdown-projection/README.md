# @aburi/markdown-projection

Deterministic Markdown views derived from `aburi.ir.v1` and `aburi.diff.v1`.
Every rendering is a pure function of its input — same IR / same diff → same
bytes. Nothing here reads the filesystem or asks a plugin; downstream tools can
snapshot-test outputs without stubbing side effects.

## Views

| Function | Emits | Consumer |
|---|---|---|
| `projectWorkspace(ir, options?)` | L0 workspace overview (component list + dependency edges); `options.suppressTimestamp` mirrors the CLI's `--no-timestamp` for reproducible snapshots. | `.aburi/workspace.md` |
| `projectComponent({ component, symbols, dependencies })` | L1 + L2 component detail (public API surface + module logic). The single-argument form makes it explicit that the caller must have pre-filtered `symbols` / `dependencies` to the ones belonging to `component`. | `.aburi/components/<id>.md` |
| `projectDiff(diff, { maxBytes?, fullReportLocation?, statuses? })` | Review-facing PR summary (added / removed / changed / moved with confidence badges), optionally capped to a byte budget; `fullReportLocation` names where the uncapped report is, for the note a capped one carries; `statuses` lists only the Symbol changes of those statuses, with a note saying how many it left out, and throws `RangeError` for an empty list or a value that is no status | `.aburi/diff.md`, PR comment |
| `projectSymbolExplain(symbol)` | Per-Symbol detail (rules / effects / calls / dropped fold-out) | `aburi explain` stdout |

Also exports a small gate over a diff's `summary` counts: a `FailOnClause` is a
status, bare (any at all) or with a `>` / `>=` / `==` / `<=` threshold
(written `changed:>=3`); `evaluateFailOn(clause, summary, droppedToggledBreakdown?)`
evaluates one, and `formatFailOnClause` / `formatFailOnTriggered` word it. It is
not the CLI's `--fail-on`, which `@aburi/cli` parses and evaluates itself
(`evaluateFailOn` and `formatTriggered` there): that grammar takes `>N`
thresholds only, adds the delta axes (`api-changed`, `logic-changed`, …) and
`--fail-on-scope`, and counts the diff's Symbol entries rather than the summary.

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
// the same document, cut to fit: sections are kept most important first at their smallest (a
// section of whole symbols as names and locations only), a section is dropped only when it
// cannot fit even so, and the name lists then get their full entries back from the top. A note
// under the Summary names the short sections and the ones that went. Never cut mid-string — that would halve a <details> block or a code fence. GitHub
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
