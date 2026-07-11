# Slice View

Specification of how Aburi clusters the set of changed Symbols from `aburi diff` into connected components over the Symbol call graph and renders them as **vertical slices** — one per feature that cuts through Controller / Service / Repository (or any equivalent chain), as opposed to the flat horizontal-layer view that groups Controllers with Controllers and Services with Services.

References:
- [`overview.md`](./overview.md) §3.2 — the vertical Slice View concept sketched in three sentences; this document is the full specification
- [`call-resolution.md`](./call-resolution.md) §7 — the `CallEdge` contract this pass consumes; §7.3 — the "no cross-language edges" invariant
- [`effect-propagation.md`](./effect-propagation.md) §2, §11.5 — sibling pass that ALSO consumes the resolved Symbol graph; its `propagated: true` records affect Node selection (§4)
- [`diff-algorithm.md`](./diff-algorithm.md) §3–§5 — how base/head Symbols are paired and the six `status` values that gate Node inclusion; §7.2 — the Markdown section order Slice View slots into; §10.1 — the diff-schema compatibility policy this pass MUST respect
- [`markdown-projection.md`](./markdown-projection.md) §2 — "1 output artifact = 1 file" convention; §3 — shared display conventions (paths, badges, dropped folds); §6 — the existing diff.md section skeleton; §9 — the stub this document resolves
- [`ir-schema.md`](./ir-schema.md) §3 — Symbol id shape used verbatim in cluster identity; §15.2 — non-breaking optional-field policy for the schema extension in §11
- [`fingerprint.md`](./fingerprint.md) §4 — what "changed" in the diff actually means (fingerprint deltas), the condition for a Symbol to be a Node
- `multi-language-id.md` (planned — see [`roadmap.md`](../roadmap.md)) — future cross-language slice composition
- `lsp-enrichment.md` (planned — see [`roadmap.md`](../roadmap.md)) — indirectly affects Slice View by lifting more `resolved: null` calls to real `CallEdge` records

---

## 1. Purpose

The horizontal L0 / L1 / L2 views of [`overview.md`](./overview.md) §3.1 group Symbols by **kind** (Controllers with Controllers, Services with Services). This is the right shape for reading a codebase on first contact, but the wrong shape for reading a **pull request** — a single feature addition typically cuts vertically through Controller → Service → Repository → Migration and scatters across every horizontal band.

[`overview.md`](./overview.md) §3.2 states the intent verbatim: **"cluster the set of changed symbols into connected components over the call graph and display them as vertical slices (per feature). It is derived from the same L3 IR."** This document specifies how that clustering is performed, how the resulting clusters are identified and ordered, and how they are projected into `out/diff.md`.

The pass consumes the output of `aburi diff` (paired Symbols with `status`) plus the `CallEdge[]` from both the base and the head IR ([`call-resolution.md`](./call-resolution.md) §7). It produces a list of Slice records (§11) that the Markdown projection renders in a new `## 🧵 Slice View` section (§12). The existing flat status sections in [`diff-algorithm.md`](./diff-algorithm.md) §7.2 remain unchanged; the Slice View is **additional**, not a replacement — see §14.10 for why.

Slice naming (assigning a human-readable label like "Refund flow" to a cluster) is out of scope. This document only specifies deterministic cluster **identity** and **membership**; naming is a human or LLM concern per [`roadmap.md`](../roadmap.md) "Under consideration". The reviewer sees `slice:<anchor-id>` and the member list; the interpretation of the cluster's meaning is theirs.

## 2. Pass Placement in the Pipeline

Slice clustering is a new stage in the `aburi diff` pipeline, positioned **after** matching / status determination / delta computation and **before** Markdown projection:

```
baseIR, headIR
  ↓ diff match (§3 of diff-algorithm.md)
paired symbols + status
  ↓ delta compute (§5 of diff-algorithm.md)
paired symbols + status + delta
  ↓ slice clustering                          ← THIS PASS
paired symbols + status + delta + slices[]
  ↓ Markdown projection (§7.2 of diff-algorithm.md + §12 of this document)
out/diff.md
```

**Why a diff pass and not an IR pass.** [`effect-propagation.md`](./effect-propagation.md) §2 runs on the IR (its output is a shape of the IR itself, `Symbol.effects[]`). Slice View, by contrast, is defined **only** on the changed-Symbol set of a specific PR — it has no meaning at `aburi scan` time when there is no base to compare against. Running it as an IR pass would either produce an artifact that changes on every scan of the workspace (defeating [`overview.md`](./overview.md) §2 "diff stability") or force one arbitrary baseline. Neither is acceptable. Placement in the diff pipeline localizes the pass to exactly the moment its inputs are meaningful.

**Where the code lives.** The graph traversal itself — building an undirected adjacency structure and running weakly-connected-components via Union-Find — is a language-independent utility exported from `@aburi/core` (alongside the SCC utility used by [`effect-propagation.md`](./effect-propagation.md) §6). `@aburi/diff` calls that utility with a diff-specific Node/Edge selection (§4, §5) and owns the produced `SliceRecord[]`. Splitting the utility out of `@aburi/diff` keeps the graph algorithm testable in isolation and reusable if a future pass needs weakly-connected components over the same edge shape.

The pass is a **pure function** of `(pairedSymbols, baseCallEdges, headCallEdges)`. Determinism is at least as strict as [`effect-propagation.md`](./effect-propagation.md) §10 — see §10.

## 3. Inputs and Preconditions

The pass runs after the diff matcher and delta computation of [`diff-algorithm.md`](./diff-algorithm.md) §3–§5 have finished. Its inputs are:

| Input | Origin | Notes |
|---|---|---|
| `pairedSymbols` | [`diff-algorithm.md`](./diff-algorithm.md) §3 | every diff Symbol Record with its `status` and (for `changed` / `moved+changed`) its `delta` populated |
| `baseCallEdges: CallEdge[]` | base IR's [`call-resolution.md`](./call-resolution.md) §7 output | both endpoints are workspace Symbol ids; `resolved: null` calls do not appear |
| `headCallEdges: CallEdge[]` | head IR's [`call-resolution.md`](./call-resolution.md) §7 output | same shape as base |
| Optional: effect-propagation results | [`effect-propagation.md`](./effect-propagation.md) §5 | consulted only to identify Symbols whose `changed` status is driven **solely** by a `propagated: true` effect entry (§4.4) |

Preconditions the pass MUST assume:

1. Every `pairedSymbols[i]` has a fully populated `status`. `unchanged` entries have already been dropped per [`diff-algorithm.md`](./diff-algorithm.md) §4.
2. Every `CallEdge.from` and `CallEdge.to` resolves to a Symbol in the corresponding IR's `symbols[]`. Dangling ids are a resolver bug ([`call-resolution.md`](./call-resolution.md) §7.1), not something Slice View tolerates.
3. Both `baseIR` and `headIR` share the same `$schema` value. [`diff-algorithm.md`](./diff-algorithm.md) §9.1 already rejects mismatches with a fatal error; the pass runs after that check.
4. [`effect-propagation.md`](./effect-propagation.md) has already run on both IRs. Its outputs are read by the pass only to answer "is this `changed` status attributable to a propagated effect?" (§4.4).

Cross-language edges do not exist yet ([`call-resolution.md`](./call-resolution.md) §7.3). Slice clustering therefore runs within one language's Symbol universe; the deferred design in `multi-language-id.md` will specify cross-language slice composition — see §14.13.

## 4. Node Selection

### 4.1 The Node set

A Symbol is a Node in the clustering graph iff its diff `status` is one of:

| Status | Included as Node | Rationale |
|---|---|---|
| `added` | yes | new code the reviewer must inspect |
| `removed` | yes | disappearing code the reviewer must inspect |
| `changed` | yes | semantic change; `delta.apiChanged` / `logicChanged` / `syntaxChanged` may distinguish severity in the projection but do not gate Node inclusion |
| `moved+changed` | yes | both a rename and a semantic change |
| `dropped-toggled` | yes | drop-list or plugin-configuration change; the Symbol crossed the visibility boundary of the IR |
| `moved` (pure) | **no** | pure moves carry no semantic change ([`diff-algorithm.md`](./diff-algorithm.md) §4 — `moved` has no fingerprint delta), so surfacing them in the vertical-slice view would be noise. They remain in the flat "Moved (no semantic change)" fold of §7.2 |
| `unchanged` | **no** | already excluded from `pairedSymbols` per §3 precondition 1 |

The identity of a Node is the Symbol id (`<language>:<file>#<qname>` per [`ir-schema.md`](./ir-schema.md) §3), taken from the **head** side of the pair when both are present, from **base** when only `removed` (`head` is absent), and from **head** when only `added` (`base` is absent).

Rationale for using head-side ids as the primary identity: the reviewer navigates the head codebase after the PR merges. Ids they see in Slice View must be clickable in the head — the version they will `git checkout` and read.

### 4.2 Dropped-toggled Symbols and empty `calls[]`

A `dropped-toggled` Symbol may have an empty `calls[]` on the side where it was dropped (drop-list rules typically strip a Symbol's body-derived arrays). Consequently, no `CallEdge` on the dropped side connects it to any other Node. On the kept side, its `calls[]` is populated normally and edges flow.

As a result, a `dropped-toggled` Symbol that was **kept in base, dropped in head** may end up in a cluster via base-side edges (§5); one that was **dropped in base, kept in head** may end up in a cluster via head-side edges; and one dropped on both sides (theoretically impossible under [`diff-algorithm.md`](./diff-algorithm.md) §4.1 but defended against for robustness) becomes an isolated singleton. This behavior is intentional — see §14.5.

### 4.3 Pure `moved` symbols are excluded even from bridging

A `moved` Symbol is not a Node **and** it is not treated as an intermediate connector in §5. Rationale: even though a moved Symbol's file path changed, its semantic surface is unchanged; a reviewer's need to see it clustered with related changes is zero. Excluding it also keeps the "no bridging via unchanged Symbols" rule of §5.2 uniform — the Node set is exactly the set of Symbols with a semantic change.

### 4.4 Propagated-only-changed callers ARE Nodes

A Symbol whose `changed` status is driven **solely** by a `propagated: true` entry appearing (or disappearing) in its `effects[]` — its own body is untouched — is still a Node. Rationale: from [`effect-propagation.md`](./effect-propagation.md) §9 it is a legitimate `changed` with `delta.logicChanged: true`, and it participates in the same causal chain the reviewer is trying to see. Its outgoing `CallEdge` to the downstream callee (whose local `effects[]` did change) is present in either `baseCallEdges` or `headCallEdges` (or both), so §5 naturally clusters it with that callee. No special-case code is needed; the Node-selection rule "any `status: changed` is a Node" already includes it.

## 5. Edge Selection

### 5.1 The Edge set

Edges are drawn from the **union** of `baseCallEdges` and `headCallEdges`, then undirected, then restricted to edges whose **both** endpoints are in the Node set (§4).

```
E = { (u, v) undirected  |  ∃ CallEdge {from:u, to:v} ∈ baseCallEdges ∪ headCallEdges,
                            u ∈ Nodes  ∧  v ∈ Nodes,
                            u ≠ v }
```

Multi-edges (the same `(u, v)` pair contributed by both `baseCallEdges` and `headCallEdges`, or by multiple call sites in one direction) collapse to one undirected edge — clustering is a set-connectivity question, not a weight question.

Self-loops (`u === v`, e.g. direct recursion) are dropped. They contribute no connectivity between distinct Nodes.

### 5.2 No bridging via non-Node Symbols

An edge is included ONLY when both endpoints are in the Node set. A path `NodeA → M → NodeB` where `M` is an unchanged (non-Node) Symbol does NOT connect `NodeA` and `NodeB`. See §14.3 for why bridging is rejected.

### 5.3 Why the union of base and head edges

A PR often **breaks** a call: `RefundController` used to call `RefundService.refund` in the base, and after the PR it calls `RefundService.refundV2`. The reviewer needs to see the controller and BOTH services in the same slice, because the controller's meaning is understood only through the rename it participated in. Restricting edges to `headCallEdges` alone would put the removed `RefundService.refund` in a separate cluster; restricting to `baseCallEdges` alone would isolate the added `RefundService.refundV2`. The union covers both directions.

Formally: an edge `(u, v)` is included whenever `u` called `v` in base OR `u` called `v` in head. If `u` and `v` are both Nodes and were ever connected in either revision, the slice acknowledges that history.

### 5.4 Unresolved calls contribute nothing

If a call has `resolved: null` in one of the two IRs (call-resolution declined to identify the callee — see [`call-resolution.md`](./call-resolution.md) §4.5 / §4.6 / §4.7), it produces no `CallEdge` on that side and therefore no candidate edge in this pass. Slice View does NOT read `Symbol.calls[]` directly; it reads only the resolved `CallEdge[]`. This preserves the [`call-resolution.md`](./call-resolution.md) §2 promise that "enabling LSP MUST NOT change the shape or ordering" of what downstream consumers see — a slice does not silently split or merge based on whether LSP was available.

### 5.5 Cross-language: no edges yet

[`call-resolution.md`](./call-resolution.md) §7.3 states cross-language edges do not exist. Consequently, if a PR touches both TypeScript and Python files, they cluster into disjoint slices per language. This is documented as expected behaviour, not a failure mode — the composition rule for cross-language slicing is deferred to `multi-language-id.md` (planned). See §14.13.

## 6. Clustering: Weakly-Connected Components

### 6.1 The algorithm

The clustering is **weakly-connected components (WCC)** over the undirected graph `(Nodes, Edges)` defined in §4 and §5. Implementation: Union-Find with union-by-rank and path compression — `O((V + E) · α(V))` where α is the inverse Ackermann function (effectively linear).

Iteration order (for byte-identical output — see §10):

1. Sort `Nodes` in ascending Symbol id order.
2. Sort `Edges` in ascending `(min(u,v), max(u,v))` order.
3. Iterate the sorted Edge list, `union(u, v)` for each.
4. Group Nodes by their Union-Find root. Each group is one Slice.

Complexity is linear in `V + E`; on a PR with `V ≤ 1000` and `E ≤ 5 · V`, this is orders of magnitude below the diff pipeline's I/O cost and does not contribute meaningfully to `aburi diff` wall time.

### 6.2 Cycles

Directed cycles in the call graph (mutual recursion, method dispatch loops) do NOT need special-case code in Slice View. Any directed cycle becomes an undirected cycle in the WCC graph; every node participating in the cycle lands in the same Slice by virtue of being pairwise reachable. No SCC pre-condensation is required — see §14.2 for the contrast with [`effect-propagation.md`](./effect-propagation.md) §6.

### 6.3 Singletons

A Node with no in-Node neighbours in `E` is its own Slice — a **singleton**. Singletons are legitimate output, not an error state; the reviewer sees them under §12.3's "Standalone changes" fold. See §9.2 for the failure-mode framing.

## 7. Cluster Identity

### 7.1 The formula

Every Slice has a stable string id:

```
sliceId = "slice:" + <smallest member Symbol id in the Slice, by ascending lexicographic order>
```

The "smallest member" is called the **anchor** of the Slice. The Symbol id is used verbatim, not sanitized (it may contain `:`, `/`, `#`, and `.` per [`ir-schema.md`](./ir-schema.md) §3). The Slice id inherits those characters; downstream consumers that need a filename derive one via [`markdown-projection.md`](./markdown-projection.md) §8's sanitization rules.

Example: a Slice whose members are

- `ts:apps/billing/src/RefundController.ts#RefundController.refund`
- `ts:apps/billing/src/RefundService.ts#RefundService.refund`
- `ts:apps/billing/src/RefundRepo.ts#RefundRepo.saveRefund`

has

```
sliceId = "slice:ts:apps/billing/src/RefundController.ts#RefundController.refund"
```

because that id is the lexicographically smallest of the three (`R` < `R` at the file path level, resolved letter by letter).

### 7.2 Stability under small edits

The anchor changes iff either (a) the anchor Symbol is removed from the Node set or (b) a new Node with a lexicographically smaller id joins the Slice. A PR that adds a downstream repository method to an existing Controller-anchored Slice leaves the anchor untouched (`R…Controller…` remains smaller than `R…Repo…`). A PR that adds a Symbol whose id begins with an earlier letter — e.g. `ts:apps/billing/src/A_new_helper.ts#helper` — shifts the anchor. This is honest: the identity of the Slice is a function of its members, and if the membership shape genuinely changed, the id reflects that.

An anchor may be a private helper rather than a Boundary Symbol (a Controller or route handler). This is deliberate — see §14.6 for why Boundary anchoring is rejected.

### 7.3 What identity does NOT do

Cluster identity is NOT a stable name across PRs. Two PRs that both touch "the refund flow" but change different subsets of the flow will produce different Slices with different anchors and different `sliceId`s. Cross-PR stable naming is out of scope, per [`roadmap.md`](../roadmap.md) "Under consideration" ("Automatic naming of Slice View clusters"). This document specifies stability **within one run** only.

## 8. Ordering

### 8.1 Between Slices

The `slices[]` array (§11) is sorted in ascending `sliceId` order — equivalently, ascending anchor Symbol id order. This is the emission order in the diff JSON and the rendering order in the diff Markdown.

Alternative rejected — sort by member count descending: a "biggest slice first" reading order helps the reviewer prioritize the largest impact area at a glance, but the ordering then flips whenever a member is added or removed. Ascending-anchor order is stable under any membership change that does not touch the anchor, which is a much more common edit than a member-count reorder.

### 8.2 Within a Slice

The `members[]` array of each Slice (§11) is sorted in ascending Symbol id order.

DFS order, topological order, and Controller → Repository chain order are legitimate reading orders for the reviewer, but constructing them requires either a "start node" heuristic (which itself needs a determinism argument) or a full DFS whose output depends on tie-break rules over multi-parent nodes. Neither is worth the complexity when ascending id already groups Symbols by file within the same directory — the natural reading order of a filesystem — and is stable under any membership change.

The Markdown projection layer (§12) MAY re-render members in a call-order-informed layout for display (e.g. anchor at the top followed by depth-first children); the `members[]` array in the JSON stays sorted.

## 9. Failure Modes

### 9.1 A single giant cluster

A large PR that refactors a shared utility used across most modules can, in principle, produce one gigantic Slice containing the majority of changed Symbols. This does not happen under the rules of §4 and §5 unless the changed Symbols are **directly** connected in the call graph — the "no bridging via non-Node Symbols" rule of §5.2 prevents unchanged-utility-through-connections from silently glueing everything together.

If a legitimately giant cluster does form (every changed Controller directly calls the same changed helper, and that helper is one of the changed Symbols), the projection layer (§12) renders it as one Slice without truncation. No configurable maximum-cluster-size knob is introduced — [`overview.md`](./overview.md) §2 "Configuration philosophy" makes it explicit that tuning knobs break time-series comparison. The reviewer's tool for coping with a giant cluster is the standard Markdown `<details>` fold applied per-Slice in §12.

### 9.2 Many singletons

Small PRs that touch unrelated Symbols produce many singleton Slices. Rendering N one-line Slice headings, each with a single member, is noise. The projection layer collapses singletons into a single "Standalone changes" bucket, rendered as one folded section listing all singletons — see §12.3.

### 9.3 Disconnected trivial changes

The degenerate case of §9.2 — a PR that adds three unrelated fields to three unrelated classes with no cross-calls at all — produces three singletons and no non-singleton Slice. The Slice View section still emits, but it contains only the "Standalone changes" fold; the reviewer sees the same information they would see in the flat `## ➕ Added` section of [`diff-algorithm.md`](./diff-algorithm.md) §7.2. No error, no empty section — see §14.10 for why the flat sections remain.

### 9.4 Zero Nodes

If the PR has no Node-eligible statuses at all (only pure `moved` and `dropped-toggled` on the same side, for instance), the Slice View section is **omitted** from the Markdown. `slices[]: []` in the JSON is still emitted for consumers that expect the field. See §11.2.

## 10. Determinism Guarantees

The pass matches [`effect-propagation.md`](./effect-propagation.md) §10's rigor.

- The Node set is enumerated in ascending Symbol id order.
- The Edge set is deduplicated (§5.1) and then sorted in ascending `(min(u,v), max(u,v))` order.
- Union-Find `union` calls happen in that sorted Edge order. Root selection uses "smaller Symbol id wins" as the union-by-rank tie-breaker, so the final root of every Slice is exactly the anchor of §7.1 with no extra rewriting pass.
- `slices[]` is emitted in ascending `sliceId` order.
- Each Slice's `members[]` is emitted in ascending Symbol id order.

**Idempotence.** Running the pass twice on the same `(pairedSymbols, baseCallEdges, headCallEdges)` reproduces the same `slices[]` byte-for-byte. This holds because Union-Find on a fixed edge sequence is a pure function, and every subsequent sort has a total order.

**Locality.** Adding, removing, or modifying a Symbol elsewhere in the workspace whose status is **not** a Node (e.g. an untouched Symbol, or a pure `moved`) does not change any Slice's membership or id. Adding a new Node that lands in a different connected component does not perturb existing Slices. This mirrors [`call-resolution.md`](./call-resolution.md) §9's locality property.

**Input-order insensitivity.** Feeding `pairedSymbols`, `baseCallEdges`, or `headCallEdges` in any order — reversed, shuffled — produces the same output. The sort in §6.1 step 1 and step 2 canonicalizes the input.

## 11. Diff Schema Implications

### 11.1 The new field

`aburi.diff.v1.json` gains an optional top-level array:

```jsonc
{
  // ... existing fields per diff-algorithm.md §7.1 ...
  "slices": [                                        // optional, non-breaking (ir-schema.md §15.2)
    {
      "id": "slice:<smallest-member-Symbol-id>",     // required
      "members": ["<Symbol id>", "<Symbol id>", ...] // required, ≥ 1, ascending Symbol id order
    }
  ]
}
```

`SliceRecord` carries no confidence, no rationale, no derivedBy — a Slice is a **derived view** over `pairedSymbols` and `CallEdge[]`, not a first-class fact. Consumers that need per-member confidence or delta information read those from the existing `pairedSymbols` entries by joining on Symbol id.

### 11.2 Emission rules

- The pass always emits the `slices` key, even when `slices: []`. Consumers therefore never need to distinguish "field absent" from "no slices".
- Members appear in exactly one Slice each. A Symbol id never appears in two `SliceRecord.members[]` arrays.
- The union of all `members[]` equals the Node set defined in §4.

### 11.3 Non-breaking

Adding an optional top-level array is a non-breaking schema change under [`ir-schema.md`](./ir-schema.md) §15.2 (which [`diff-algorithm.md`](./diff-algorithm.md) §10.1 inherits explicitly). Existing consumers of `aburi.diff.v1.json` that ignore unknown fields continue to work.

**No changes** are introduced to:

- The `status` enum ([`diff-algorithm.md`](./diff-algorithm.md) §10.1 — status growth is a breaking change).
- The `MatchRationale` enum (same policy).
- The existing `symbols[]` / `components` / `dependencies` / `summary` shapes.

### 11.4 CI gate (`--fail-on`) interaction

`aburi diff --fail-on` gates on the existing status/summary values. **No new `--fail-on` selector** is introduced for Slice View — no `cluster-count>N`, no `slice-size>N`, no `giant-slice`. See §14.7 for the rejection.

## 12. Markdown Projection

### 12.1 Where it appears

A new section `## 🧵 Slice View` is added to `out/diff.md`, positioned between `## 🔧 Logic changes` and `## ➕ Added` in the fixed section order of [`diff-algorithm.md`](./diff-algorithm.md) §7.2 / [`markdown-projection.md`](./markdown-projection.md) §6.1:

```
## ⚠ API changes
## 🔧 Logic changes
## 🧵 Slice View                    ← NEW
## ➕ Added
## ➖ Removed
## 🔀 Moved + Changed
## 🔀 Moved
## 🧱 Component changes
## 🔗 Dependency changes
## 💧 Dropped changes
## 🎨 Syntax-only changes
```

**Position rationale.** Slice View is the reviewer's "understand the feature" section — the vertical view. It slots after the horizontal severity sections (API / Logic) so a reviewer who cares about critical contract changes reads those first, then reads the same changes re-grouped by feature, then continues to Added / Removed for coverage. Slice View is not folded by default: it IS the primary reading path for large PRs.

### 12.2 Per-Slice rendering

Each Slice becomes a `###` subsection under `## 🧵 Slice View`:

```md
### `slice:ts:apps/billing/src/RefundController.ts#RefundController.refund` (3 members)

- `RefundController.refund` — *(changed)*
  **File**: `apps/billing/src/RefundController.ts:42`
  ↳ delta.apiChanged, delta.logicChanged
- `RefundService.refund` — *(changed)*
  **File**: `apps/billing/src/RefundService.ts:88`
  ↳ delta.logicChanged
- `RefundRepo.saveRefund` — *(added)*
  **File**: `apps/billing/src/RefundRepo.ts:15`
  ↳ effects: db.write on `prisma.refund.create`

---
```

- The heading contains the full `sliceId` and the member count.
- Each member is a bullet with: Symbol short-form (last-segment qname), the status in italics, file:line, and a `↳` follow-up line summarising which delta axes tripped or, for `added` / `removed`, the entry's boundary/effect surface.
- Members appear in ascending Symbol id order per §8.2. A projection variant that arranges members in call-order (anchor first, then callees) is left for a future iteration — the JSON side stays as specified.
- Slices are separated by a `---` thematic break for visual boundary marking.
- Column choices reuse existing [`markdown-projection.md`](./markdown-projection.md) §3 conventions: file paths POSIX and backtick-wrapped (§3.3), confidence badges per §3.5, no emoji for the default status.

### 12.3 Singletons folded

Singleton Slices (§6.3) are collected into a single `<details>` block appended after the last non-singleton Slice:

```md
### Standalone changes

<details>
<summary>4 singleton slices (no in-Node call-graph neighbours)</summary>

- `slice:ts:packages/shared/src/logger.ts#log` — `log` *(changed, logic)*
- `slice:ts:packages/shared/src/util.ts#formatMoney` — `formatMoney` *(changed, syntax-only)*
- `slice:ts:apps/billing/src/dto/refund.dto.ts#RefundDto` — `RefundDto` *(dropped-toggled, to-dropped)*
- `slice:ts:apps/billing/src/routes/health.ts#health` — `health` *(added)*

</details>
```

The reviewer sees the count at a glance and can expand for the list. This matches the collapsed-section policy of [`markdown-projection.md`](./markdown-projection.md) §12.2 ("Keeping dropped entries, folded") — the fact is retained, the reader is not.

### 12.4 Cross-links to the flat sections

Each member in the Slice View rendering IS the same Symbol that appears in the corresponding flat section (`## ⚠ API changes`, `## 🔧 Logic changes`, `## ➕ Added`, etc.). To avoid duplicating the full delta detail in both places, the Slice View bullets contain the **summary** only — status label, file:line, delta-axis summary — and the flat sections retain the **full** rendering. Anchor links from Slice View to the flat section entries are planned but out of scope for the initial spec; see [`markdown-projection.md`](./markdown-projection.md) §5.8 for the parallel "future release will consider internal links" note on call rendering.

### 12.5 Empty Slice View

Per §9.4, if `slices[]` is empty the entire `## 🧵 Slice View` section is omitted from `out/diff.md`. Emitting a heading with an empty body would be visual noise.

## 13. Verifiable Properties (Test Criteria)

Every implementation of the Slice View pass MUST pass the following. IDs are prefixed `SV` to avoid collision with existing prefixes (`CR`, `EP`, `DF`, `L`, `S`, `T`, `A`, `C`, `MP`, `PR`).

### 13.1 Node and Edge selection

| ID | Input | Expected |
|---|---|---|
| SV1 | Two `changed` Symbols `A` and `B` with a `CallEdge {A → B}` in either IR | Exactly one Slice with `members = [A, B]` (sorted); `sliceId = slice:<min(A, B)>` |
| SV2 | Two `changed` Symbols `A` and `B` with no `CallEdge` between them (in either IR) | Two singleton Slices |
| SV3 | Symbols `A` and `B` are both changed; a `CallEdge` runs `A → M → B` where `M` is `unchanged` | Two singleton Slices — no bridging (§5.2) |
| SV4 | A `moved` Symbol (pure move, no fingerprint delta) with a `CallEdge` to a `changed` Symbol | The `changed` Symbol is a singleton; the `moved` Symbol is not in `slices[]` at all (§4.3) |
| SV5 | A `changed` Symbol whose only delta is a `propagated: true` `Effect` (own body unchanged) with a `CallEdge` to its downstream callee (also `changed`) | Both cluster into one Slice (§4.4) |

### 13.2 Base-vs-head edge union

| ID | Input | Expected |
|---|---|---|
| SV6 | Controller `C` (changed) called Service `S1` (removed) in base; calls Service `S2` (added) in head | Exactly one Slice containing `{C, S1, S2}` (§5.3) |
| SV7 | Edge exists only in `headCallEdges` between two Nodes | Two Nodes cluster into one Slice |
| SV8 | Edge exists only in `baseCallEdges` between two Nodes | Same — two Nodes cluster into one Slice |

### 13.3 Cycles and dropped

| ID | Input | Expected |
|---|---|---|
| SV9 | Directed cycle `A → B → C → A`, all three `changed` | One Slice containing `{A, B, C}` (§6.2) |
| SV10 | `dropped-toggled` Symbol whose `calls[]` on the dropped side is empty, and no edges from the kept side connect it to any other Node | Singleton Slice (§4.2) |
| SV11 | `dropped-toggled` Symbol whose kept-side `calls[]` connects to another Node | Clusters with that Node |

### 13.4 Cluster identity and ordering

| ID | Input | Expected |
|---|---|---|
| SV12 | A Slice with members `[X, Y, Z]` sorted ascending | `sliceId === "slice:X"` (§7.1) |
| SV13 | Two Slices `S1` and `S2` with anchors `A1 < A2` (lex order) | `S1` appears before `S2` in `slices[]` and in the Markdown rendering |
| SV14 | A Slice's `members[]` | Sorted ascending Symbol id (§8.2) |

### 13.5 Determinism, idempotence, locality

| ID | Input | Expected |
|---|---|---|
| SV15 | Run the pass twice on the same input | Byte-identical `slices[]` (idempotence, §10) |
| SV16 | Shuffle the input `pairedSymbols`, `baseCallEdges`, and `headCallEdges` orders | Byte-identical `slices[]` (input-order insensitivity, §10) |
| SV17 | Add an unchanged Symbol elsewhere in the workspace | No `sliceId` and no `members` list changes (locality, §10) |
| SV18 | Add a new Node landing in a disjoint component | Existing Slices are unchanged; the new Node appears in its own Slice |

### 13.6 Schema and projection

| ID | Input | Expected |
|---|---|---|
| SV19 | Zero-Node PR (only `moved` and `unchanged`) | `slices: []` in JSON; `## 🧵 Slice View` section omitted from `out/diff.md` (§9.4, §12.5) |
| SV20 | Some singleton and some multi-member Slices | Multi-member Slices rendered first, then the "Standalone changes" fold (§12.3) |
| SV21 | Cross-language PR (TS + Python nodes) | Two disjoint singleton-or-multi Slices per language; no cross-language edges attempted (§5.5, §14.13) |
| SV22 | Any output | `aburi.diff.v1.json` validates unchanged against the schema (§11.3) |

## 14. Design Decisions

### 14.1 Why weakly-connected components

The clustering question is "which changed Symbols participate in the same feature-shaped chain". A **feature-shaped chain** is a connected path in the call graph, regardless of direction — the reviewer of Controller → Service → Repository does not care that the arrows point downward when reading the code from the top-level Boundary, nor that they point upward when reading from the storage side. WCC captures exactly this: two Nodes are in the same Slice iff there is any undirected path between them in the graph induced on the Node set.

Alternative rejected — SCCs via Tarjan's algorithm: strongly-connected components only join nodes that are pairwise reachable through **directed** cycles. A linear Controller → Service → Repository chain has no cycles, so every Node ends up a singleton SCC — the exact opposite of the vertical-slice intent. SCC is the right algorithm for [`effect-propagation.md`](./effect-propagation.md) §6 (which needs to prove termination on a monotone lattice over a possibly-cyclic graph) but the wrong algorithm here.

Alternative rejected — Louvain community detection: modularity-optimising community detection produces clusters that are sensitive to iteration order over tie-breaks. Even carefully-implemented deterministic Louvain shifts cluster boundaries when a single edge is added or removed, which violates [`overview.md`](./overview.md) §2's non-negotiable "diff stability". Output cluster size also depends on modularity resolution — a tuning knob whose presence contradicts [`overview.md`](./overview.md) §2 "Robust defaults + minimal overrides". WCC has neither problem: it is deterministic under a fixed edge iteration order and has no size knob at all.

### 14.2 Why no SCC pre-condensation is needed (contrast with effect-propagation.md §6)

[`effect-propagation.md`](./effect-propagation.md) §6 condenses SCCs before its reverse-topological sweep because the sweep needs a DAG traversal to prove `O(V + E)` termination on a monotone lattice. Slice View has no lattice and no sweep — Union-Find on the undirected edge set is already `O((V + E) · α(V))` and terminates trivially. Directed cycles collapse into the same connected component as a natural consequence of undirection (§6.2). Pre-condensation would be dead code.

### 14.3 Why "no bridging via non-Node Symbols"

Consider two sibling Controllers `RefundController` and `InvoiceController`, both changed, that both call an unchanged shared helper `sanitizeAmount`. A "1-hop bridging via any unchanged Symbol" rule would cluster them together as one Slice. But their features are semantically unrelated — the reviewer reading the Slice would waste effort proving to themselves that the two Controllers don't in fact share behaviour.

Alternative rejected — 1-hop bridging via a Boundary-owned Symbol only: a narrower rule that only bridges through unchanged Symbols owned by a Boundary (a Controller or route handler) would avoid the trivial `sanitizeAmount` case above. But it introduces a **tuning knob** in disguise (how do we define "Boundary-owned"? by decorator? by component? by both?) and, worse, its correctness depends on the framework plugin's decorator classification. A NestJS project sees different bridging than a Next.js project on structurally identical code — that's the plugin sensitivity [`overview.md`](./overview.md) §2 marks as "diff stability" hostile. Rejected on both consistency and stability grounds.

Alternative rejected — 1-hop bridging through any unchanged Symbol: cheapest to specify, but produces the trivial false-clustering case above with no defense. The reviewer's cost of "prove these two features are unrelated" exceeds the reviewer's cost of "click into two separate Slices that happened to share a helper".

The chosen rule — no bridging at all — is honest: two features that share an unchanged helper are two features. If the helper itself changes, it becomes a Node and legitimately clusters the two features into one Slice, which is now truthful.

### 14.4 Why include base-only edges (§5.3)

A PR that renames a Service method and updates its Controller call site produces `RefundService.refund` as `removed`, `RefundService.refundV2` as `added`, and `RefundController.refund` as `changed`. The `head` graph has an edge `RefundController.refund → RefundService.refundV2` only; the `base` graph has an edge `RefundController.refund → RefundService.refund` only. Taking the union clusters all three into one Slice — which is what the reviewer actually needs to see. Restricting to head-only edges would isolate the `removed` old Service; restricting to base-only edges would isolate the `added` new one. See SV6 for the test.

### 14.5 Why `dropped-toggled` Symbols get included with possibly-empty `calls[]`

[`diff-algorithm.md`](./diff-algorithm.md) §4.1 argues that `dropped-toggled` is caused by drop-list or plugin configuration changes rather than user code edits. The reviewer needs to see which Symbols crossed the visibility line, and clustering those Symbols with the code that surrounded them (on the side where they were still visible) gives context. A dropped-toggled Symbol whose `calls[]` is empty on the dropped side may still have live calls on the kept side — so it may cluster with a real Slice via the union rule of §5.3. When both sides yield no in-Node edges, it is a legitimate singleton (§4.2) and appears under §12.3.

### 14.6 Why the anchor is not a Boundary Symbol

An intuitive alternative: pick the Boundary Symbol (Controller, route handler) as the anchor of each Slice so that the id reads like `slice:<Controller-id>` — a human-recognisable feature name.

Rejected because:

1. **Framework-plugin dependency**: which Symbols count as Boundary is determined by the framework plugin (`Decorator.boundary === true` in [`ir-schema.md`](./ir-schema.md) §6, or an `extKind` prefix of `framework:*`). Two runs of `aburi diff` on the same source, with different framework-plugin versions or with the framework plugin absent, would produce different anchors → different `sliceId`s → different `slices[]` → different Markdown byte content. This violates the [`overview.md`](./overview.md) §2 non-negotiable "diff stability".
2. **Multiple Boundaries per Slice**: a Slice may contain zero, one, or several Boundaries. Zero-Boundary Slices (a repository-only change) need a fallback; multi-Boundary Slices need a tie-break. Both would be additional rules whose determinism arguments would need proving.
3. **Losing determinism-simplicity**: "lexicographically smallest member" is a formula anyone can compute by hand from the member list. "Smallest boundary member, or smallest member if none" is not.

The private-helper-anchor cost is real (the id reads less nicely) but bounded (the member list is right there), and it buys plugin-independence for free.

### 14.7 No `--fail-on cluster-count>N` or slice-size selectors

[`overview.md`](./overview.md) §2 lists "Highly configurable" as an explicitly rejected design axis. Introducing per-cluster-count or per-slice-size CI gates would put reviewers in the position of tuning the gate on every large PR, and re-tuning on every mid-PR clustering shift caused by a rename. The existing gates (`changed`, `removed`, `dropped-toggled:to-dropped`, ...) already operate on stable per-Symbol counts and cover the "did this PR touch too much" question at a lower level.

The `--fail-on` surface stays exactly as [`diff-algorithm.md`](./diff-algorithm.md) §10.1 declares it.

### 14.8 Why not compute Slice View at `aburi scan` time

Slice View is defined on the **changed** Symbol set, which does not exist without a base. An "always-on" workspace-level Slice View would either need to invent a synthetic baseline (an empty workspace? the first commit?) or produce artifacts that shift with every scan of an unmodified workspace. Either option violates diff stability or produces meaningless output. Restricting the pass to `aburi diff` matches the shape of the reviewer's question.

### 14.9 Why a `## 🧵 Slice View` section in `out/diff.md`, not a separate `out/slices.md`

[`markdown-projection.md`](./markdown-projection.md) §2 establishes "1 artifact = 1 file" (workspace.md, per-component.md, diff.md, per-symbol/*.md). A separate `out/slices.md` would break that pattern for a view that is a re-grouping of the same diff, not a new artifact. Reviewers paste `diff.md` into a PR comment; splitting Slice View out would either force a second paste or leave it out of the PR comment entirely, defeating the reason for the Markdown projection.

### 14.10 Slice View is additional, not a replacement

The existing horizontal sections (`## ⚠ API changes`, `## 🔧 Logic changes`, `## ➕ Added`, ...) are kept unchanged. The reviewer's two questions — "what class of change is this?" (horizontal, severity-first) and "what feature is this part of?" (vertical, cluster-first) — are both useful, and a single-view answer to both would lose information. Slice View's per-member bullets summarise; the flat sections carry the full detail (§12.4). Removing the flat sections would also break the existing `--fail-on` gates that count per-status Symbols.

### 14.11 Why cluster naming is out of scope

Assigning a human-readable label like "Refund flow" to a Slice requires understanding what the Symbols in the Slice *mean* — a semantic judgment that [`overview.md`](./overview.md) §2 rules out for the static analyser ("LLM judgment (verifiability and diff stability disappear)"). [`roadmap.md`](../roadmap.md) explicitly parks this under "Under consideration" as a downstream LLM concern. Slice ids reveal the anchor Symbol id, which is enough for a reviewer to click into the anchor's L2 view and read the code themselves.

### 14.12 Why `SliceRecord` carries no confidence or `derivedBy`

A Slice is a **derived view** — the connectivity is a consequence of pre-existing facts (`CallEdge[]` and `pairedSymbols`), not itself a new fact. Attaching a confidence would raise the immediate question "confidence in what?" — the WCC computation is deterministic given the inputs, so any confidence would just re-express the per-`CallEdge` confidence which is already available on the underlying edges. Consumers that want that data join `SliceRecord.members[]` to `pairedSymbols` and to the `CallEdge` set.

### 14.13 Why cross-language slices are deferred

[`call-resolution.md`](./call-resolution.md) §7.3 states that cross-language edges do not exist yet; without such edges, the WCC graph is partitioned by language. Introducing a Slice-View-specific cross-language merge rule (e.g. "consider two Symbols connected if their file paths co-occur in a Component's `roots[]`") would leak component-detection semantics into the Slice pass and produce Slices whose connectivity is not backed by call-graph evidence — a step away from the "static heuristics + symbol graph" ground rule of [`overview.md`](./overview.md) §2. The composition is deferred to `multi-language-id.md` (planned per [`roadmap.md`](../roadmap.md)) which will introduce cross-language edge semantics; Slice View will then automatically produce cross-language clusters via the same WCC rule with no code change.
