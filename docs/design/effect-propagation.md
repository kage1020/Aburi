# Effect Propagation

Specification of how Aburi propagates locally-detected `Effect` records up through the Symbol call graph so that a Symbol's `effects[]` reflects not only the side-effects performed in its own body but also every side-effect reachable through the transitive closure of its resolved calls.

References:
- [`ir-schema.md`](./ir-schema.md) §9 — the `Effect` record and the core `id` vocabulary; §14 — invariants; §15.2 — non-breaking optional-field policy; §16 — extension zone
- [`call-resolution.md`](./call-resolution.md) §7 — the `CallEdge` contract this pass consumes; §7.2 & §11.5 — edge confidence and the fact that "effect propagation is where the two confidences combine"
- [`effect-plugin.md`](./effect-plugin.md) §4.4 — per-`Effect.derivedBy` string returned by `classify()`; §9.2 — the NestJS pseudocode notes propagation is a separate consideration; §11.3 — why plugins cannot write `Symbol.derivedBy[]` directly
- [`fingerprint.md`](./fingerprint.md) §4.1, §4.4, §4.5, §4.7 — the `logic` fingerprint input and its plugin-configuration robustness rule
- [`diff-algorithm.md`](./diff-algorithm.md) §5.2 — `Effect` identity `(id, target)`; §7.2 — Markdown projection section ordering; §10.1 — the diff `status` enum is closed
- [`overview.md`](./overview.md) §2 — categorical `confidence` only; §4 — extraction pipeline placement
- [`slice-view.md`](./slice-view.md) — the sibling consumer of the resolved Symbol graph
- [`lsp-enrichment.md`](./lsp-enrichment.md) — the optional layer that lifts `CallEdge` confidence

---

## 1. Purpose

Effect classification, as specified in [`effect-plugin.md`](./effect-plugin.md), attaches an `Effect` record to the exact call site where a side-effect is performed. A NestJS controller that delegates to a service that delegates to a repository that ultimately calls `prisma.invoice.create` therefore ends up with the `db.write` effect on the **repository method**, not on the controller. From the reviewer's perspective this is inverted: the controller is the observable surface, and the interesting semantic fact — "this handler writes to the database" — is not visible without walking the call chain by hand.

[`roadmap.md`](../roadmap.md) states the next-phase goal verbatim: **"Effect propagation: build the symbol call graph and propagate `db.write` to methods that call methods that call `prisma.invoice.create`"**. This document specifies the propagation rules.

The pass runs in `@aburi/core`. It consumes the `CallEdge[]` produced by call resolution ([`call-resolution.md`](./call-resolution.md) §7) and augments each Symbol's `effects[]` with the union of effects reachable through outgoing edges. Locally-detected effects are preserved unchanged; propagated entries are discriminated by an optional `propagated: true` field so downstream consumers can distinguish them without dual code paths.

## 2. Pass Placement in the Pipeline

Effect propagation is a new stage in the extraction pipeline of [`overview.md`](./overview.md) §4, positioned **after** call resolution and **before** fingerprint computation:

```
symbols with local effects + resolved CallEdge[]
  ↓ effect propagation
symbols with augmented effects[] (locally-detected + propagated)
  ↓ fingerprint (api / logic / syntax)
L3 IR (JSON)
```

- Running **after** call resolution is required: propagation traverses `CallEdge[]`, and every edge has both endpoints resolved to workspace Symbol ids ([`call-resolution.md`](./call-resolution.md) §7.1).
- Running **before** fingerprint is required: propagated effects contribute to the `logic` fingerprint (§8). If propagation ran after fingerprinting, a callee gaining an effect would not show up as a `logic` change and reviewers would miss the semantic shift.

The pass is a **pure function** of `(symbols, callEdges)`. Determinism is not weaker than [`call-resolution.md`](./call-resolution.md) §9; the same inputs produce byte-identical `effects[]` on every Symbol.

## 3. Inputs and Preconditions

The pass runs after every file has been parsed, every Symbol constructed, every local effect classified by the effect plugin chain, and every call resolved (or explicitly left `null`).

| Input | Origin | Notes |
|---|---|---|
| `symbolTable` | `@aburi/core` | index of every Symbol keyed by id |
| `callEdges: CallEdge[]` | [`call-resolution.md`](./call-resolution.md) §7 | both endpoints are workspace Symbol ids (calls with `resolved: null` produced no edge and are not visible here); each edge carries a categorical `confidence: high | medium | low` and a `line` |
| `symbols[i].effects[]` | effect plugin classification | **local** effects only, i.e. an entry per call site the effect plugin classified in this Symbol's body |

Preconditions the pass MUST assume:

1. `symbolTable` is complete. No Symbol may be added or removed while propagation runs.
2. Every `CallEdge.from` and `CallEdge.to` resolves to an entry in `symbolTable`. Dangling ids are a resolver bug, not something propagation tolerates.
3. Local effects on every Symbol are final. The effect plugin chain has already collapsed to first-match-wins ([`effect-plugin.md`](./effect-plugin.md) §5.1).

Cross-language edges do not exist yet ([`call-resolution.md`](./call-resolution.md) §7.3). Propagation therefore runs within one language's Symbol universe; the deferred design in `multi-language-id.md` will specify how cross-language propagation composes.

## 4. Propagation Semantics

### 4.1 Direction

Propagation flows **from callee to caller**. For every `CallEdge { from: A, to: B }`, every entry in `B.effects[]` becomes a candidate effect on `A`. Applied transitively, `A` receives the union of effects reachable through any resolved outgoing edge from `A`, from `A`'s callees, from their callees, and so on.

Rationale: an effect is a semantic property of the **thing the code causes to happen**. If `A` invokes `B` and `B` writes to the database, then `A`'s execution causes a database write. This is the property the reviewer needs to see on `A`.

### 4.2 The join operation

Propagation aggregates effects by set union. The union key is `(effectId, target)`, matching the `Effect` identity used by [`diff-algorithm.md`](./diff-algorithm.md) §5.2.

```
join(effects_A, effects_B) =
  { every entry in effects_A }
  ∪ { entry ∈ effects_B  |  no entry in effects_A has the same (effectId, target) }
```

The join is monotone: adding an entry never removes another entry. This property is required by the termination argument (§7).

Dedup preference is stated in §5.1: when a propagated entry collides with a locally-detected entry on the same `(effectId, target)`, the local entry wins (this preserves [`ir-schema.md`](./ir-schema.md) §9.3 "no duplicate output" through the augmentation).

### 4.3 Boundary treatment

Boundary Symbols — controllers, route handlers, and other framework entry points identifiable via `Decorator.boundary === true` ([`ir-schema.md`](./ir-schema.md) §6) or an `extKind` prefix of `framework:*` — are **not** propagation stops. Propagation always runs to full transitive closure regardless of any Symbol's Boundary status.

The projection layer ([`markdown-projection.md`](./markdown-projection.md)) is where the Boundary-vs-internal distinction is rendered: the "workspace overview" and "per-component" views may choose to display only the aggregated effect set on Boundary Symbols, but the underlying IR carries the augmented `effects[]` on every Symbol in the closure. This split keeps the propagation pass a pure function of its inputs; view-layer preferences do not feed back into IR data.

Rationale: if propagation stopped at Boundary Symbols, an internal (non-Boundary) Symbol's `effects[]` would not reflect the effects of its callees, which is exactly the state the reviewer must currently reconstruct by hand. Stopping propagation would replace one manual walk with another.

## 5. Aggregation Rules per Symbol

### 5.1 Where propagated effects live

Propagated effects MUST be appended to the same `Symbol.effects[]` array as locally-detected effects, discriminated by an optional `propagated: boolean` field on the `Effect` record. When `propagated` is absent or `false`, the entry is locally-detected (produced by the effect plugin chain per [`effect-plugin.md`](./effect-plugin.md) §4.4). When `propagated` is `true`, the entry originates from the transitive closure of outgoing edges.

Non-breaking extension: adding an optional field to `Effect` is permitted under [`ir-schema.md`](./ir-schema.md) §15.2. See §5.2 for the additional `derivedFrom` field introduced at the same time.

Dedup rule (concrete form of §4.2's join): when the transitive closure would introduce a propagated entry with the same `(effectId, target)` as an existing locally-detected entry, the propagated entry MUST be dropped. Two propagated entries with the same key from distinct upstream sources are merged into one, with the combined `derivedFrom` and combined `confidence` per §5.3. This preserves [`ir-schema.md`](./ir-schema.md) §9.3's "no duplicate output" invariant end-to-end.

The `line` field, required on locally-detected effects ([`ir-schema.md`](./ir-schema.md) §9), is meaningless N hops away: a propagated `db.write` on a controller does not correspond to any line inside the controller. `line` MUST therefore be **omitted** on entries with `propagated: true` — not set to `null`, not set to a placeholder line number. Consumers of `effects[]` MUST NOT assume `line` is present. The JSON Schema (`aburi.ir.v1.json`) narrows `line` to be conditionally required: required when `propagated` is absent or `false`; forbidden when `propagated` is `true`.

Alternative rejected — a sibling `Symbol.propagatedEffects[]` array: this would force every downstream consumer (Markdown projection, diff, `aburi explain`) to iterate two arrays and merge them by hand, splitting the dedup logic across two code paths. Keeping propagation in `effects[]` with a discriminator flag localizes the distinction to one field.

### 5.2 `derivedFrom` (new field) and `derivedBy` preservation

Each propagated `Effect` record carries an optional `derivedFrom?: SymbolId[]` field listing the **direct upstream callee(s)** that contributed this `(effectId, target)`. For a propagated effect on Symbol `A` that traces back to a local effect on Symbol `C` through the path `A → B → C`, `derivedFrom` on `A`'s entry is `[B]` — not `[C]`, not `[A, B, C]`.

Rationale: the reviewer investigating why `A` has an effect wants to know **which of `A`'s own callees carried the effect upward**, so they can click through to the next hop. A full path (`[A, B, C]`) would be combinatorial in cyclic graphs (§6) and reconstructible by walking `Dependency` edges anyway; recording only the immediate upstream is sufficient and bounded.

When multiple direct callees of `A` independently contribute the same `(effectId, target)` (e.g. two of `A`'s callees each perform `db.write` on `prisma.invoice.create`), `derivedFrom` is the sorted union of those callee Symbol ids.

The per-`Effect.derivedBy` string that the effect plugin originally attached ([`effect-plugin.md`](./effect-plugin.md) §4.4) is preserved on propagated entries. Locally-detected entries always keep the plugin's original `derivedBy` value untouched. When multiple upstream classifications differ in `derivedBy` (e.g. one callee's `db.write` was classified by `effects-plugin:prisma:write` and another's by `effects-plugin:drizzle:write`), the propagated entry keeps **the lexicographically smallest `derivedBy` string**. This is the deterministic single-string choice — see §12.9 for why we do not extend `derivedBy` to `string[]` here.

`Symbol.derivedBy[]` (the array on the Symbol itself, [`ir-schema.md`](./ir-schema.md) §5.5) is **not** appended to during propagation. That array records evidence for why the Symbol exists in the IR in its current shape; the origin of a specific effect is a per-effect property, and mixing the two would violate the boundary drawn in [`effect-plugin.md`](./effect-plugin.md) §11.3.

Worked example (two-hop propagation):

```jsonc
// A.effects[] after propagation, given the call chain A → B → C and a local db.write on C
[
  {
    "id": "db.write",
    "target": "prisma.invoice.create",
    "plugin": "effects-prisma",
    "confidence": "medium",              // combined per §5.3
    "propagated": true,
    "derivedFrom": ["ts:./repo.ts#Repo.save"],   // = B, the direct callee
    "derivedBy": "effects-plugin:prisma:write"   // preserved from C's local classification
  }
]
```

### 5.3 Confidence combination

Confidence is categorical, `high > medium > low`, with no numeric interpretation ([`overview.md`](./overview.md) §2). Propagation combines two orthogonal confidences:

- The **resolution confidence** of each `CallEdge` the propagation traverses ([`call-resolution.md`](./call-resolution.md) §7.2).
- The **classification confidence** of the original local `Effect` ([`effect-plugin.md`](./effect-plugin.md) §4.4).

Two operators combine them:

| Operator | Applied when | Formula |
|---|---|---|
| along a single path | at each edge hop while walking the transitive closure | `min(edgeConfidence, incomingEffectConfidence)` |
| across paths reaching the same Symbol with the same `(effectId, target)` | at merge time | `max(...)` |

[`call-resolution.md`](./call-resolution.md) §7.2 states: "Effect propagation must respect edge confidence when combining propagated effect confidence." §11.5 states: "Effect propagation is where the two confidences combine." The `min`-along-path / `max`-across-paths pair is the specific realization: a chain is only as trustworthy as its weakest hop; a Symbol reached by multiple corroborating paths is at least as trustworthy as its best path.

Truth-table example. Suppose `A → B → C` with edge confidences `high` and `medium`, and a local `db.write` on `C` with confidence `high`:

```
along A → B → C:
  at C:      high (local)
  crossing C → B edge (medium): min(high, medium) = medium
  crossing B → A edge (high):   min(medium, high) = medium
  →  A gets db.write @ medium
```

If a second path `A → D → C` exists with both edges `high`, that path yields `db.write @ high` on `A`. Merging both paths on the same `(db.write, prisma.invoice.create)` key gives `max(medium, high) = high`.

### 5.4 Effect kind unioning key

The merge key is `(effectId, target)`. `target` is preserved **verbatim** from the origin (e.g. `prisma.invoice.create`); it is not normalized to the callee Symbol id.

Rationale: [`fingerprint.md`](./fingerprint.md) §4.5 guarantees "plugin-configuration robustness" — the `logic` fingerprint is unchanged as long as the effect's `target` is the same, even when the plugin later renames the `id`. Rewriting `target` to the callee Symbol id during propagation would defeat that guarantee: swapping the effect plugin, or reorganizing files, would then perturb the `logic` fingerprint of every upstream caller. Keeping `target` verbatim keeps the propagation-augmented IR robust in the same way.

## 6. Cycles and Strongly Connected Components

Real call graphs contain cycles (mutual recursion, method dispatch through interfaces where `A.foo` calls `B.bar` which calls `A.baz`). Propagation MUST handle cycles without diverging.

The algorithm is:

1. Build the directed graph over Symbol ids using `CallEdge[]`.
2. Compute strongly connected components via Tarjan's algorithm — `O(V + E)`, single pass, deterministic given a fixed iteration order.
3. Condense the SCCs into a DAG.
4. Process the DAG in reverse topological order (leaves first). For each SCC node, compute the union of the local effects of every Symbol in the SCC and every effect reaching the SCC from its outgoing edges in the DAG.
5. Every Symbol inside an SCC receives the same aggregated effect set. Within the SCC, the local origin of each effect is preserved on `derivedFrom` (the direct callee that carried it into the current Symbol).

Determinism inside the algorithm (see also §10):

- Nodes are iterated in ascending lexicographic order of Symbol id.
- Edges out of each node are iterated in ascending `(to, line)` order.
- When Tarjan produces SCCs, they are re-sorted by the smallest Symbol id inside each SCC before the reverse-topological sweep.
- The reverse-topological sweep breaks ties by SCC id (= smallest Symbol id).

Complexity is `O(V + E)` — linear in the size of the graph.

Alternative rejected — fixed-point iteration over all Symbols until no set grows: the fixed point exists and is the same set (join is monotone; domain is finite), but the iteration cost is non-linear in adversarial graphs, and stable iteration order still requires a deterministic schedule, so the SCC condensation approach costs no extra work while providing an explicit termination proof.

## 7. Termination

The domain of possible effect sets on each Symbol is a finite lattice: the universe of `(effectId, target)` pairs is drawn from the union of every local effect classified by the plugin chain, which is finite for any concrete workspace. The join operation (§4.2) is monotone: nothing is ever removed from a Symbol's aggregated set during propagation.

The SCC-condensed DAG has finite depth. The reverse-topological sweep processes each SCC node exactly once. Within an SCC, the union of every member's local effects is computed once and assigned to every member. No further iteration is needed because the SCC has no other incoming edges from within itself that would introduce new effects.

Therefore the algorithm terminates in `O(V + E)` steps for any input. No bounded-iteration fallback and no depth limit are required or specified.

## 8. Interaction with the 3-Layer Fingerprint

Propagated effects **enter the `logic` fingerprint input**. Because they are stored in `Symbol.effects[]` (§5.1), they are visible to the `logic` fingerprint's serialization ([`fingerprint.md`](./fingerprint.md) §4.1) with no change to the serialization contract. Concretely: when a callee gains a `db.write`, every Symbol in the transitive callers' closure sees a new entry in its `effects[]`, and each of those Symbols' `logic` fingerprint changes on the next `aburi scan`.

This is the intended review signal. The reviewer of a diff that added a `db.write` to a repository method wants to see the controllers and services above it show up as `changed` with a logic delta — that is the entire point of propagation.

Reconciliation with [`fingerprint.md`](./fingerprint.md) §4.5. §4.5 guarantees the `logic` fingerprint is unchanged when an effect plugin **renames** an effect's `id` (e.g. `db.write` ↔ `x-prisma:create`) while the `target` stays the same. That robustness is preserved here because `target` (not Symbol id) is the merge key (§5.4) and because the `logic` fingerprint input for effects is `{ target }` only. Propagation, by contrast, **adds and removes** `Effect` records, which is already covered by [`fingerprint.md`](./fingerprint.md) §4.4 test case `L10` ("add / remove an effect → logic changes"). Adding effects to a caller because the callee gained one is a legitimate `logic` change; suppressing it would blind the reviewer.

Ordering rule: within `Symbol.effects[]`, propagated entries appear **after** locally-detected entries. The effective order at emission time is:

1. Locally-detected entries, in call order (per [`fingerprint.md`](./fingerprint.md) §4.7 — order is preserved, not sorted; a locally-detected effect at `line: 30` precedes one at `line: 45`).
2. Propagated entries, sorted deterministically by `(effectId, target)` ascending. Because `line` is omitted on propagated entries (§5.1), a stable position by call order is not available; the lexicographic sort is the deterministic substitute.

This reconciles with `fingerprint.md` §4.7: the "order is preserved" guarantee applies to entries that have an intrinsic call-site position. Propagated entries lack that position, so a fixed lexicographic order is applied only within the propagated segment; the locally-detected segment ahead of it retains call order verbatim.

Dedup (§5.1) is applied **before** the fingerprint reads the array so that no `(effectId, target)` pair appears twice.

Alternative rejected — exclude propagated effects from `logic` fingerprint input: this would mean that a repository gaining a `db.write` triggers no `changed` on the controllers that invoke it, and reviewers would lose the propagated-effect signal in the diff. The purpose of the pass is to surface those changes; excluding them from the fingerprint would defeat it.

## 9. Diff Implications

Propagation adds no new value to the diff `status` enum. [`diff-algorithm.md`](./diff-algorithm.md) §10.1 declares any addition to `{ added, removed, changed, moved, moved+changed, dropped-toggled }` a breaking change; propagation-only differences are surfaced through the existing `changed` status.

A "propagated-only change" — the callee gained (or lost) an effect while the caller's own body is untouched — flows through the pipeline as follows:

1. The callee's local `effects[]` changes. Its `logic` fingerprint changes. `diff-algorithm.md` §4 emits `status: "changed"` with `delta.logicChanged: true` on the callee.
2. Propagation runs. Every caller in the transitive closure sees a new (or removed) propagated entry in `effects[]`. Their `logic` fingerprint changes. `diff-algorithm.md` §4 emits `status: "changed"` with `delta.logicChanged: true` on each caller.
3. The Markdown projection ([`diff-algorithm.md`](./diff-algorithm.md) §7.2) renders these under section **2. Logic changes**. The `propagated: true` discriminator (§5.1) lets the projection format the sub-line as "logic change — propagated from `<derivedFrom>`" so the reviewer sees at a glance that the caller's own body was untouched.

Example — two diff scenarios:

| Scenario | Callee change | Caller status | Caller `delta` | Rendered as |
|---|---|---|---|---|
| Local addition | Callee's own body gained a `db.write` line | `changed` | `delta.logicChanged: true`, `delta.effects.added` has one entry, `propagated: false` | "Logic change — added `db.write` on `prisma.invoice.create`" |
| Propagated addition | Callee (or a further downstream Symbol) gained a `db.write`; caller body unchanged | `changed` | `delta.logicChanged: true`, `delta.effects.added` has one entry, `propagated: true`, `derivedFrom: [<callee>]` | "Logic change — propagated `db.write` from `<callee>`" |
| Propagated removal | Callee lost a `db.write` (removed the underlying call); caller body unchanged | `changed` | `delta.logicChanged: true`, `delta.effects.removed` has one entry, `propagated: true`, `derivedFrom: [<callee>]` | "Logic change — no longer propagates `db.write` from `<callee>`" |

The `delta.effects.added` / `delta.effects.removed` shape from [`diff-algorithm.md`](./diff-algorithm.md) §5.2 is reused unchanged. The identity used for pairing is `(id, target)`; the `propagated` flag is metadata carried alongside, not part of the identity, so a local `db.write` on `prisma.invoice.create` and a propagated `db.write` on the same `target` are treated as the same effect entry (which is the correct behavior — the callee's change becomes visible on the caller without duplicating).

## 10. Determinism Guarantees

The pass matches [`call-resolution.md`](./call-resolution.md) §9's rigor.

- The input `CallEdge[]` is iterated in ascending `(from, to, line)` order.
- Tarjan's SCC output is re-sorted (SCCs by smallest Symbol id; nodes within an SCC lexicographically) before the reverse-topological sweep.
- The reverse-topological sweep processes SCCs in a deterministic order derived from the sort above.
- When writing propagated entries back into `Symbol.effects[]`, they are stably sorted by `(effectId, target)` ascending. Locally-detected entries retain their call order per [`fingerprint.md`](./fingerprint.md) §4.7.
- `derivedFrom` arrays are sorted ascending.
- `confidence` combination is a pure function of inputs; `min` and `max` on the totally ordered `high > medium > low` lattice have no tiebreaks.

Idempotence: `propagate(propagate(x)) === propagate(x)`. Once propagation has run, running it again with the same `CallEdge[]` reproduces the same `effects[]` byte-for-byte on every Symbol. This holds because the join is idempotent and the SCC condensation is a pure function of the input graph.

Locality: adding a new Symbol elsewhere in the workspace, or adding an edge that does not touch a given Symbol's transitive out-closure, does not change that Symbol's `effects[]`. This mirrors [`call-resolution.md`](./call-resolution.md) §9's locality guarantee.

## 11. Verifiable Properties (Test Criteria)

Every implementation of the propagation pass MUST pass the following. IDs are prefixed `PR` to avoid collision with existing prefixes (`CR`, `EP`, `DF`, `L`, `S`, `T`, `A`, `C`).

### 11.1 Direct propagation

| ID | Input | Expected |
|---|---|---|
| PR1 | `A → B`, `B` has local `db.write` on `prisma.invoice.create` | `A.effects[]` contains one entry: `id=db.write`, `target=prisma.invoice.create`, `propagated=true`, `derivedFrom=[B]` |
| PR2 | `A → B → C`, `C` has local `db.write` | `A.effects[]` contains propagated `db.write` with `derivedFrom=[B]`; `B.effects[]` contains propagated `db.write` with `derivedFrom=[C]`; `C` is unchanged (local entry only) |
| PR3 | Diamond `A → B → D`, `A → C → D`, `D` has local `db.write` | `A.effects[]` contains one propagated `db.write` with `derivedFrom=[B, C]` (sorted); confidence combined per §5.3 |

### 11.2 Confidence combination

| ID | Input | Expected |
|---|---|---|
| PR4 | `A → B` edge confidence `high`, `B`'s local `db.write` confidence `medium` | Propagated entry on `A` has confidence `medium` (min along the single hop) |
| PR5 | Two paths reach `A → … → C` with combined confidences `medium` and `high` respectively | Merged entry on `A` has confidence `high` (max across paths) |

### 11.3 Cycles and shadowing

| ID | Input | Expected |
|---|---|---|
| PR6 | SCC `{A, B, C}` with all edges internal to the SCC; only `C` has a local `db.write` | Every member of the SCC (`A`, `B`, `C`) ends with the same aggregated effect set including the propagated `db.write` (except `C` where it stays local) |
| PR7 | Self-loop `A → A`; `A` has a local `db.write` | `A.effects[]` is unchanged (no duplicate propagated entry — the local entry already covers `(db.write, ...)`) |
| PR8 | `A → B`, `B` has local `db.write`, `A` also has a local `db.write` on the same `target` | `A.effects[]` retains only the local entry; the propagated candidate on the same `(id, target)` is dropped (§5.1 dedup) |

### 11.4 Boundary and cross-language

| ID | Input | Expected |
|---|---|---|
| PR9 | Controller `Ctl` (`Decorator.boundary=true`) → service → repository with `db.write` | `Ctl.effects[]` receives the propagated `db.write` (Boundary is not a propagation stop, §4.3) |
| PR10 | Unresolved call: `A`'s call to some target has `resolved: null` (no `CallEdge` emitted) | `A.effects[]` receives nothing from that call site; propagation only follows `CallEdge[]` |
| PR11 | Cross-language edge candidate (`from` and `to` differ in language prefix) | Not present in `CallEdge[]` per [`call-resolution.md`](./call-resolution.md) §7.3, so no propagation attempted |

### 11.5 Diff and determinism

| ID | Input | Expected |
|---|---|---|
| PR12 | Base: `B` has no effects, `A → B`. Head: `B` gained a local `db.write`; `A`'s body unchanged | Diff emits `A` with `status="changed"`, `delta.logicChanged=true`, `delta.effects.added` includes the propagated `db.write` with `propagated: true` and `derivedFrom=[B]` |
| PR13 | Run propagation twice on the same input | Byte-identical `effects[]` on every Symbol (idempotence) |
| PR14 | Shuffle the input `CallEdge[]` order and rerun | Byte-identical `effects[]` on every Symbol (determinism under input reordering) |
| PR15 | Every propagated entry | `line` field is **absent** (omitted from the JSON output — not `null`, not a placeholder); locally-detected entries retain the plugin-set `line` |

## 12. Design Decisions

### 12.1 Why callee → caller direction

Effects describe **what a piece of code causes to happen**. The caller inherits its callees' semantic surface area; the callee does not inherit its callers'. Propagating in the opposite direction — caller → callee — would attach effects to code that does not perform them, which is exactly the wrong signal for review.

### 12.2 Why SCC condensation over fixed-point iteration

Both terminate on the same result because the join is monotone over a finite lattice. SCC condensation is `O(V + E)` in one pass; fixed-point iteration is non-linear on adversarial graphs and still needs a deterministic schedule to satisfy [`overview.md`](./overview.md) §2 "diff stability". SCC condensation gives determinism, a linear cost bound, and an explicit termination proof — three properties for the same complexity.

### 12.3 Why `(effectId, target)` as the merge key

[`diff-algorithm.md`](./diff-algorithm.md) §5.2 already identifies `Effect` records by `(id, target)`. Reusing the same key means the diff algorithm needs no propagation-specific matching logic: the same identity function that pairs `Effect` records for delta computation also dedups them during propagation.

### 12.4 Why propagated effects enter the logic fingerprint

If the callee gains `db.write` and the caller's `logic` fingerprint does not change, the reviewer misses the propagated fact — which was the reason for building this pass. Entering `logic` is the mechanism that surfaces the change through the existing diff pipeline without any new status enum value.

[`fingerprint.md`](./fingerprint.md) §4.5's plugin-configuration robustness is preserved because `target` (not Symbol id) is the merge key; renaming an effect plugin still leaves the `target` values verbatim, so `logic` still ignores the rename.

### 12.5 Why propagation does not stop at Boundary symbols

A Boundary Symbol is a **view-layer concept** — it is where the projection layer chooses to render the aggregated effect set for human consumption. If the pass stopped at Boundary Symbols, an internal Service that calls a Repository would not carry the Repository's effects, which is the opposite of the pass's purpose. Boundary treatment belongs in projection, not in the pure-function IR pass. See §4.3.

### 12.6 Why a `propagated: true` discriminator over a separate array

A separate `Symbol.propagatedEffects[]` would force every consumer — Markdown projection, diff, `aburi explain`, downstream Slice View — to iterate two arrays and merge them. The dedup rule (§5.1) would need to live in both places. Adding an optional boolean to the existing `Effect` record keeps the shape open under [`ir-schema.md`](./ir-schema.md) §15.2 and localizes the branch to the single consumer that renders differently on it (the Markdown projection).

### 12.7 Why `min` along a single path and `max` across paths

`min` along a path expresses "a chain is only as trustworthy as its weakest hop." An LSP-lifted edge with `medium` confidence carrying a `high`-confidence effect ends at `medium`, correctly recording that the weaker step limits the whole chain.

`max` across paths expresses "corroborating evidence lifts, not lowers." If one path from `A` to a `db.write` costs `low` confidence but another `high`, `A` sees `high` — the honest verdict is the best available evidence, not the worst. This mirrors [`call-resolution.md`](./call-resolution.md) §7.2's per-edge confidence philosophy: strong evidence should not be discarded because a weaker parallel path exists.

### 12.8 Why no new diff status is introduced

[`diff-algorithm.md`](./diff-algorithm.md) §10.1 declares status-enum growth a breaking change. Propagation-only differences already surface through `status: "changed"` + `delta.logicChanged: true` — the existing statuses are sufficient. The `propagated: true` discriminator lets the Markdown projection render the sub-line differently without touching the status enum. Introducing `propagated-only-change` as a new status would break every existing consumer of the diff schema for a rendering convenience that the discriminator flag already delivers.

### 12.9 Why the lexicographically smallest `derivedBy` on merge, and not `string[]`

When two upstream paths reach the same `(effectId, target)` with different plugin-issued `derivedBy` strings, three shapes are conceivable:

1. Keep both by widening the type: `derivedBy: string | string[]`.
2. Keep both by adding a companion field: `derivedByAll?: string[]`.
3. Keep one deterministically.

Options (1) and (2) force every consumer that reads `derivedBy` today (locally-detected entries, [`ir-schema.md`](./ir-schema.md) §9) to add a shape check, and they leak a propagation-internal detail (the fact that two plugins classified the same effect) into a field whose stable meaning is "the single evidence string for this effect". Locally-detected entries stay `string`; propagated entries stay `string`; the merge picks the lexicographically smallest string. This is deterministic, requires no schema widening, and keeps the field's contract uniform across all `Effect` records. The one lost fact — "a second plugin also classified this effect under a different name" — is recoverable by walking `derivedFrom` and inspecting each origin's local `Effect.derivedBy`.
