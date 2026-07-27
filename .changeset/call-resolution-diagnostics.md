---
"@aburi/cli": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
"@aburi/markdown-projection": minor
"@aburi/types": minor
---

Report why calls stay unresolved instead of dropping them silently.

`docs/design/slice-view.md` §5.4 gives calls with `resolved: null` no `CallEdge`,
so a Controller → Service pair whose link the resolver could not identify shows
up as two unrelated singleton Slices. The behaviour is intentional and unchanged
— what was missing is any way for a reviewer to tell that apart from a genuinely
disconnected change. This implements the diagnostic surface
`docs/design/call-resolution.md` §8.1 had specified but left unbuilt, and with it
the previously unsatisfiable test criteria CR27 / CR28 / CR29 of §10.4.

`resolveCallGraph` now classifies every unresolved call into one of the five
§8.1 buckets — `local-scope`, `external`, `dynamic`, `ambiguous`, `no-match` —
using a fixed precedence so an unchanged workspace always reports the same
numbers. Which calls resolve, the `CallEdge[]` they produce, and the resulting
`slices[]` are all byte-identical to before.

Surfaces:

- `aburi scan` and `aburi diff` print one stdout line, e.g.
  `calls 1310 · resolved 1203 · unresolved 107 (external 30 · dynamic 60 · no-match 17)`.
  Zero-valued buckets are omitted. `aburi diff` omits the line entirely when the
  head IR predates the counter rather than printing misleading zeroes.
- The `## 🧵 Slice View` section of `out/diff.md` gains a note when any member
  carries unresolved calls, plus a `⚠ N unresolved calls` marker on the affected
  members and singletons. Computed from the IR Symbols the diff already embeds —
  `aburi.diff.v1.json` is unchanged and `SliceRecord` gains no field.
- `aburi explain <symbol> --debug-resolution` renders a `## Call resolution`
  table with the per-call bucket and, for `ambiguous`, the competing candidates.
  Per-call reasons are not persisted in the IR (§8.1), so the flag always
  rescans and is rejected alongside `--no-rescan` or `--ir`.

No CI gate and no tuning knob was added: `--fail-on` is untouched, and
`--debug-resolution` changes only what is printed
(`docs/design/overview.md` §2, `slice-view.md` §14.7).

Schema addition (non-breaking, additive per `ir-schema.md` §15.2): `Stats` grows
an optional `callResolution` object holding `totalCalls`, `resolvedCalls`, and
the five `unresolved` bucket counters. It is optional so documents produced
before the field existed stay valid v1, but the current scan pipeline always
emits it. New IR integrity invariant #15 re-derives all three numbers from
`symbols[]`, so the census cannot drift from the document it describes.

Public API additions:

- `@aburi/types`: `CallResolutionStats` and `UnresolvedCallBuckets` (generated
  from the schema), plus the non-schema `UnresolvedCallBucket` /
  `UnresolvedCallDiagnostic` records. `CallCandidate` gains an optional
  `dynamicReceiver` flag — language plugins set it when the callee's receiver was
  an expression (`getRepo().save()`), which normalization otherwise collapses
  into something indistinguishable from a qualified name.
- `@aburi/core`: `resolveCallGraph` returns `stats` and `diagnostics` alongside
  `symbols` / `edges`, accepts an optional `dynamicCallSites` input, and exports
  `makeCallSiteKey`. `ScanResult` gains `unresolvedCalls`.
- `@aburi/markdown-projection`: `formatCallResolutionLine`, and an optional
  `unresolvedCalls` field on `ProjectSymbolExplainContext`. Explain output is
  byte-identical when it is omitted.
- `@aburi/cli`: `DiffReport.callResolutionLine`, `ScanReport.callResolutionLine`
  / `ScanReport.unresolvedCalls`, and `ExplainOptions.debugResolution`.
- `@aburi/lang-typescript`: reports `dynamicReceiver` for call, subscript, and
  parenthesized-expression receivers. Call target strings are unchanged, so no
  fingerprint moves.
