# `fp:*` Extension Vocabulary — Concrete Specification

This document locks the concrete shape of the `fp:*` extension vocabulary — `fp:adt`, `fp:match`, `fp:effect`, and reserved successors — so that when the first functional-language plugin ships (Scala or Rust, per the roadmap), the vocabulary is already fixed and every subsequent FP plugin implements against the same target. It is a **vocabulary contract**, not a language selection: nothing here decides which language ships first.

## References:

- [extension-vocab.md](./extension-vocab.md) §3 — plugin manifest format that declares these values.
- [extension-vocab.md](./extension-vocab.md) §5.2 — the `lang`-only ownership rule that makes `fp:*` a language-plugin namespace.
- [extension-vocab.md](./extension-vocab.md) §5.3 — sub-namespace exclusive ownership.
- [extension-vocab.md](./extension-vocab.md) §7 — the `VocabRegistry` API.
- [extension-vocab.md](./extension-vocab.md) §11.2 — the three-tier plugin support model (published / project / hint-only).
- [overview.md](./overview.md) §4 — the tag-propagation step where `fp:*` values are emitted; the pipeline already names `fp:match`, `fp:adt`, `fp:effect`.
- [ir-schema.md](./ir-schema.md) §5 — the Symbol record.
- [ir-schema.md](./ir-schema.md) §5.2 — `Symbol.extKind`, the primary carrier for `fp:adt` / `fp:match`.
- [ir-schema.md](./ir-schema.md) §9 — the Effect record shape into which `fp:effect:*` slots.
- [fingerprint.md](./fingerprint.md) §3.1 — api input rules (relevant to variant addition).
- [fingerprint.md](./fingerprint.md) §3.2 — logic input rules (relevant to match arms).
- [lang-plugin.md](./lang-plugin.md) §2 — lang plugins own extraction and therefore vocab population.
- [lang-plugin.md](./lang-plugin.md) §4 — where `extKind` and `rules[]` are populated.
- [effect-plugin.md](./effect-plugin.md) — effect id shape for §5 interaction rules.
- [multi-language-id.md](./multi-language-id.md) §6 — cross-language effect propagation, relevant to §5.
- [roadmap.md](../roadmap.md) — Later: FP proof of concept.

---

## 1. Purpose

The extraction pipeline in [overview.md](./overview.md) §4 already names three FP tags at the tag-propagation step: `fp:match`, `fp:adt`, `fp:effect`. But their concrete semantic mapping — which language construct emits which tag, how the tag participates in fingerprints, how it composes with existing effects — is undefined. If the first FP language plugin ships without that specification, a second FP plugin will disagree about (say) whether `Result<T, E>` is `fp:effect` or plain data, and the vocabulary will fragment.

This document locks the semantics so that (a) plugins target a stable contract and (b) diff behavior is predictable across languages. It intentionally leaves language selection unresolved: the roadmap says "Scala or Rust"; this document is written to be implementable by either (or by Kotlin, or Haskell, or F#).

Slot placement in the vocabulary framework:

- `fp:*` is a `lang`-plugin-only prefix ([extension-vocab.md](./extension-vocab.md) §5.2).
- Sub-namespaces `fp:adt`, `fp:match`, `fp:effect` are individually ownable — this document declares them **pre-approved** (a plugin claiming one of them at startup does not conflict with a central reservation) but still requires the plugin to declare them in its `aburi-vocab.json`.
- Optional reserved sub-namespaces `fp:typeclass`, `fp:hkt` are also pre-approved but not required by any current plugin (§6).

## 2. Placement in the pipeline

`fp:*` values are emitted during the tag-propagation step of [overview.md](./overview.md) §4. Concretely, they land in three IR slots:

- `Symbol.extKind` — the primary carrier for `fp:adt:*` and `fp:match` (Symbol-level classification).
- `Symbol.rules[]` — the existing `"match"` rule value is reused when the enclosing Symbol dispatches on an ADT or literal.
- `Symbol.effects[]` — the effect id namespace `fp:effect:<kind>` slots in the same shape as any other effect id.

No new IR field is introduced. The `Rule` enum entry `"match"` already exists ([fingerprint.md](./fingerprint.md) §3.2 rules table).

## 3. `fp:adt` — Algebraic data types

### 3.1 Semantic definition

`fp:adt` classifies a declared sum-of-products type: a closed set of variants where each variant carries zero or more fields. Language mapping:

| Language | Construct that emits `fp:adt` |
| --- | --- |
| Scala | `sealed trait` / `sealed abstract class` + case classes/objects |
| Rust | `enum Foo { A, B(u32), C { x: i32 } }` |
| Kotlin | `sealed class` / `sealed interface` + subclasses |
| Haskell | `data Foo = A \| B Int \| C { x :: Int }` |
| F# | discriminated union `type Foo = A \| B of int` |
| Swift | `enum` with associated values |

### 3.2 Sub-values

Three sub-values are pre-approved. A plugin MUST emit at least `fp:adt:sum`; the others are refinements.

| Sub-value | Meaning | Emission rule |
| --- | --- | --- |
| `fp:adt:sum` | Two or more variants, at least one variant may carry payload | Always emitted for a multi-variant type; default when a plugin cannot determine variant shape |
| `fp:adt:product` | Single variant with fields — a record / struct treated as an ADT-of-one for symmetry | Emitted when the plugin classifies a record as ADT-shaped (Scala `case class` with no sibling, Rust struct-in-enum) |
| `fp:adt:enum` | Multiple variants, all payload-free — a C-style enum | Optional; MAY be omitted, in which case the plugin falls back to `fp:adt:sum` |

Rule FP-A1: exactly one `fp:adt:*` sub-value per Symbol. A Symbol MUST NOT carry both `fp:adt:sum` and `fp:adt:product`.

### 3.3 Symbol shape

Rule FP-A2 (one Symbol per ADT declaration): an ADT declaration produces exactly one Symbol. Variants do **not** get their own Symbols unless a variant carries standalone logic (a method body inside a Scala case class, a Rust `impl Foo::A` block). This mirrors the existing DataModel treatment in [ir-schema.md](./ir-schema.md) §5 — record types are one Symbol per declaration.

The Symbol's fields:

```jsonc
{
  "id": "scala:app/domain/Order.scala#Order",
  "kind": "type",
  "extKind": "fp:adt:sum",
  "derivedBy": "@aburi/lang-scala",
  // ... other fields per ir-schema §5
}
```

Rule FP-A3: `derivedBy` MUST name the language plugin that emitted the tag. This is how the vocabulary registry attributes ownership when two plugins might disagree.

### 3.4 Public API implication

Adding or removing a variant on an exported ADT changes the api fingerprint. This follows directly from [fingerprint.md](./fingerprint.md) §3.1: the api input includes the exported type's shape, and an ADT's shape is the set of its variants and their field shapes. No new fingerprint rule is needed — the existing "exported type shape changed" rule applies.

Rule FP-A4: adding a variant to a public `fp:adt` Symbol MUST surface as an api-fingerprint change on that Symbol. Renaming a variant, changing a variant's field shape, and removing a variant all follow the same rule.

## 4. `fp:match` — Pattern match expressions

### 4.1 Semantic definition

`fp:match` classifies a control-flow construct that dispatches by structural pattern on an ADT value or a literal, exhaustively considered by the language. Language mapping:

| Language | Construct that emits `fp:match` |
| --- | --- |
| Scala | `x match { case A => ...; case B(y) => ... }` |
| Rust | `match x { A => ..., B(y) => ... }` |
| Kotlin | `when (x) { is A -> ...; is B -> ... }` (structural form) |
| Haskell | `case x of A -> ...; B y -> ...` |
| F# | `match x with \| A -> ... \| B y -> ...` |
| Swift | `switch x { case .a: ...; case .b(let y): ... }` |

Rule FP-M1 (TS `switch` is NOT `fp:match`): a TypeScript `switch(true) { case cond: ... }` or plain `switch(x)` does NOT emit `fp:match`. It falls back to the existing `"switch"` rule per [fingerprint.md](./fingerprint.md) §3.2. Rationale: TS `switch` is not structural pattern-matching against an ADT; it is value equality, and treating it as `fp:match` would blur two very different diff signals.

### 4.2 Sub-values

| Sub-value | Meaning | Emission rule |
| --- | --- | --- |
| `fp:match` | Match expression detected; exhaustiveness not asserted | Always emitted for a match expression |
| `fp:match:exhaustive` | The compiler / plugin can prove the match covers all variants of its scrutinee's ADT | Optional; emitted only when the plugin can trivially detect it (e.g. no `_` wildcard, and the scrutinee is a `sealed` type known to the plugin) |

Rule FP-M2: at most one of these two sub-values per Symbol. `fp:match:exhaustive` implies `fp:match` (never emit both on the same Symbol).

### 4.3 Symbol shape

Rule FP-M3: for each match expression, the enclosing Symbol picks up `"match"` in its `rules[]` array. Additionally, if match is the Symbol's primary construct (e.g. an interpreter dispatch function whose body is one big `match`), the Symbol's `extKind` is set to `fp:match` or `fp:match:exhaustive`. When match is only one construct among many inside the Symbol body, `extKind` is left as whatever the enclosing Symbol's classification is; only `rules[]` picks up the `"match"` marker.

Rule FP-M4 (multiple matches, one Symbol): a Symbol body containing multiple match expressions gets `"match"` added to `rules[]` exactly once (no duplicates). The rules[] array is a set semantically, per [fingerprint.md](./fingerprint.md) §3.2.

### 4.4 Diff behavior

Match arm addition or removal MUST participate in the `logic` fingerprint input, same treatment as `switch` (per [fingerprint.md](./fingerprint.md) §3.2 rules table). This is the primary diff signal for `fp:match`.

Rule FP-M5 (exhaustiveness transition is a logic change): transitioning between `fp:match` and `fp:match:exhaustive` on the same Symbol surfaces as a `logic` fingerprint change, NOT an `api` change. Rationale: exhaustiveness affects the Symbol's control flow (whether an unmatched input can reach the end of the block), not its externally observable signature.

Rule FP-M6 (arm reorder is not a logic change unless the language cares): if the language's semantics do not depend on arm order (Scala, Rust, Haskell all match first-to-last but the ADT variants are unordered per §3.4), then reordering arms that all match distinct variants MUST NOT change the logic fingerprint. Concretely: the plugin normalizes match arms by scrutinee-variant name before fingerprinting. Cases with wildcards or guards are left in source order (their reorder is semantically meaningful).

## 5. `fp:effect` — Effect systems

### 5.1 Semantic definition

`fp:effect` classifies a value that represents a deferred / effectful computation — a first-class effect that the language distinguishes from plain data. Language mapping:

| Language | Construct that emits `fp:effect` |
| --- | --- |
| Scala | `IO[A]` (cats-effect), `ZIO[R, E, A]`, `Future[A]` (deferred variant) |
| Rust | `impl Future<Output = A>`, `async fn` return type |
| Kotlin | `suspend fun` return position, `Deferred<A>`, `Flow<A>` (streaming variant) |
| Haskell | `IO a`, `STM a` |
| F# | `Async<A>`, `Task<A>` |

### 5.2 Effect-id integration

An `fp:effect` value produces an entry in the enclosing Symbol's `effects[]` under the `fp:effect:<kind>` namespace:

```jsonc
"effects": [
  { "id": "fp:effect:io",       "source": "cats-effect", "derivedBy": "@aburi/effects-cats-effect" },
  { "id": "fp:effect:future",   "source": "std",         "derivedBy": "@aburi/lang-scala" },
  { "id": "fp:effect:async",    "source": "std",         "derivedBy": "@aburi/lang-rust" }
]
```

Rule FP-E1: `<kind>` is owned by the emitting plugin — either a lang plugin (`fp:effect:async` for Rust `async fn`) or an effect plugin (`fp:effect:io` for cats-effect). Ownership follows [extension-vocab.md](./extension-vocab.md) §5.3: two plugins claiming the same `<kind>` is a startup error.

Rule FP-E2: `<kind>` MUST be lowercase kebab-case, `[a-z][a-z0-9-]*`. This matches the effect id conventions in [effect-plugin.md](./effect-plugin.md).

### 5.3 Interaction with existing effects

Rule FP-E3 (composition, not replacement): an `fp:effect:io` Symbol that internally does `db.query` emits BOTH `fp:effect:io` and `db.query` in `effects[]`. The FP wrapper does not hide the concrete effect; the two effect ids describe complementary facets — `fp:effect:io` says "this returns a deferred computation" and `db.query` says "the deferred computation touches the database when executed".

Rationale: a downstream consumer that filters for `db.*` effects still finds this Symbol; a consumer that groups by effect model still sees the IO wrapping. Replacing the concrete effect with the wrapper would drop the more precise information.

### 5.4 Boundary detection

Rule FP-E4: an `fp:effect` value crossing a public API boundary (a Symbol's return type, an exported field type) makes the enclosing Symbol carry the `Boundary` tag — same treatment as `Promise<T>` in TS. This is what makes cross-service calls that use `IO[A]` visible in Slice View's public-API diff.

### 5.5 Cross-language interaction

An `fp:effect` value crossing a language boundary follows [multi-language-id.md](./multi-language-id.md) §6: the caller side's `fp:effect:*` effect is emitted on the caller Symbol; the receiver side's effects are NOT injected back. `fp:effect` does not change this rule.

## 6. Additional vocabulary reserved

Two sub-namespaces are pre-approved for future FP plugin use but are not required by any current plugin. Their reservation prevents a later plugin from claiming them for an unrelated purpose.

| Sub-namespace | Purpose | Status |
| --- | --- | --- |
| `fp:typeclass` | A type class / trait constraint that provides ad-hoc polymorphism. Scala `implicit`/`given`, Rust `trait` bounds, Haskell `class`. | Reserved; plugin MAY emit; not required |
| `fp:hkt` | A higher-kinded type parameter (`F[_]`, `Functor[F]`). Scala, Haskell, Kotlin (via Arrow) express these directly. | Reserved; plugin MAY emit; not required |

Rule FP-R1: any use of these namespaces by a plugin MUST still be declared in the plugin's `aburi-vocab.json` per [extension-vocab.md](./extension-vocab.md) §3. Reservation here means "central table won't reject the declaration", not "plugin can skip declaring".

Rule FP-R2: `fp:typeclass` and `fp:hkt` are NOT required by any conformance test for a first FP plugin. A plugin that emits only `fp:adt`, `fp:match`, `fp:effect` is a conformant FP language plugin.

## 7. Vocabulary registration

Every `fp:*` value used by a plugin MUST appear in its `aburi-vocab.json` per [extension-vocab.md](./extension-vocab.md) §3. Example manifest fragment for a Scala plugin:

```jsonc
{
  "plugin": "@aburi/lang-scala",
  "declares": {
    "extKind": [
      { "value": "fp:adt:sum",        "doc": "Sealed hierarchy with 2+ variants." },
      { "value": "fp:adt:product",    "doc": "Record / case class of one." },
      { "value": "fp:adt:enum",       "doc": "Payload-free variants." },
      { "value": "fp:match",          "doc": "Match expression; exhaustiveness unknown." },
      { "value": "fp:match:exhaustive","doc": "Match expression proven exhaustive." }
    ],
    "effects": [
      { "value": "fp:effect:future",  "doc": "scala.concurrent.Future." }
    ]
  }
}
```

Rule FP-R3: an extractor emitting a `fp:*` value that is not present in `declares` is an extraction error, per [extension-vocab.md](./extension-vocab.md) §6.3 (undeclared values). This is what forces vocabulary to be visible in the plugin manifest at all times.

Rule FP-R4: the central reservation table in [extension-vocab.md](./extension-vocab.md) §5.1 lists `fp:*` as a `lang`-owned prefix. This document adds no new central reservation; §5.2 already permits language plugins to own `fp:*` sub-namespaces individually. The three sub-namespaces here (`fp:adt`, `fp:match`, `fp:effect`) are enumerated here as pre-approved so a first-mover plugin's declaration goes through without a discovery step.

## 8. Fingerprint impact summary

| Change | Fingerprint bucket | Notes |
| --- | --- | --- |
| Add a variant to an exported ADT | api | [fingerprint.md](./fingerprint.md) §3.1 — exported type shape change |
| Rename a variant on an exported ADT | api | Same rule |
| Change a variant's field shape (add/remove/rename field) | api | Same rule |
| Add or remove a `match` arm | logic | [fingerprint.md](./fingerprint.md) §3.2 — `"match"` rule participates in logic |
| Reorder match arms across distinct variants (no wildcards) | none | Rule FP-M6 — arms normalized before fingerprinting |
| Transition `fp:match` ⇄ `fp:match:exhaustive` | logic | Rule FP-M5 |
| Wrap / unwrap a return value in `fp:effect:io` (etc.) | logic + effects | The Symbol acquires or drops `fp:effect:*`; the change is a control-flow change (deferred vs. immediate) |
| Change `<kind>` under `fp:effect:<kind>` (e.g. `future` → `io`) | logic | The Symbol's effect model changed |
| Adding a private (non-exported) ADT variant | logic | Not an api change; the variant is not visible outside the file |

## 9. Non-goals

### 9.1 Language selection

This document does not decide whether the first FP plugin is Scala or Rust (or Kotlin, or Haskell). The roadmap and its FP-PoC issue own that decision. Every rule in this document is language-agnostic within the FP family.

### 9.2 Concrete tree-sitter query examples

Extraction queries live in each language plugin's `.scm` files and reference implementation. This document specifies **what** to emit, not **how** to detect it in a specific tree-sitter grammar.

### 9.3 Diff-time exhaustiveness proof

Rule FP-M2 says a plugin MAY emit `fp:match:exhaustive` when the plugin can trivially detect exhaustiveness (sealed type, no wildcard). This document does NOT require the plugin to run a compiler-grade exhaustiveness check at extraction time; those checks require full type resolution which the untyped tier does not have.

### 9.4 Interop between two FP languages in the same monorepo

A Scala plugin and a Rust plugin coexisting in one monorepo falls under [multi-language-id.md](./multi-language-id.md). This document only specifies within-one-language semantics. Cross-language `fp:effect` composition is out of scope here.

## 10. Verifiable Properties

| ID | Input | Expected |
| --- | --- | --- |
| FP1 | Scala plugin emits `extKind: "fp:adt:sum"` and this value is present in `aburi-vocab.json` | Extraction succeeds; Symbol's `extKind` is `"fp:adt:sum"` |
| FP2 | Plugin emits `extKind: "fp:adt:xyz"` NOT declared in `aburi-vocab.json` | Extraction error per [extension-vocab.md](./extension-vocab.md) §6.3 |
| FP3 | Same Symbol carries both `fp:adt:sum` and `fp:adt:product` | Extraction error per Rule FP-A1 |
| FP4 | ADT declaration with 3 variants, plugin emits 1 Symbol for the ADT | `symbols[]` contains exactly 1 Symbol; no per-variant Symbols unless a variant has standalone logic |
| FP5 | Add a variant to an exported `fp:adt` Symbol between two scans | api fingerprint on that Symbol changes |
| FP6 | Add an arm to a match expression inside Symbol S | logic fingerprint of S changes |
| FP7 | Reorder two match arms that match distinct variants, no wildcards | logic fingerprint of the enclosing Symbol is UNCHANGED (Rule FP-M6) |
| FP8 | Transition `extKind: "fp:match"` → `"fp:match:exhaustive"` on the same Symbol | logic fingerprint changes; api fingerprint does NOT change (Rule FP-M5) |
| FP9 | Scala Symbol returns `IO[Unit]` and calls `db.query` inside | `effects[]` contains both `"fp:effect:io"` and a `db.query` entry (Rule FP-E3) |
| FP10 | Symbol's return type is `IO[User]` (exported) | Symbol carries the Boundary tag (Rule FP-E4) |
| FP11 | TS `switch(x)` construct in a TS Symbol | `rules[]` contains `"switch"`; does NOT contain `"match"`; `extKind` does not become `fp:match` (Rule FP-M1) |
| FP12 | Two lang plugins both declare `fp:effect:io` | Startup error per [extension-vocab.md](./extension-vocab.md) §5.3 |
| FP13 | Plugin declares `fp:effect:IO` (uppercase) | Manifest rejected: `<kind>` must be lowercase kebab-case (Rule FP-E2) |
| FP14 | Plugin emits `fp:typeclass` value declared in its manifest | Extraction succeeds; no central-reservation conflict (Rule FP-R2) |

## 11. Design Decisions

### 11.1 Why lock the vocabulary before choosing a language

A first-mover FP plugin will emit whatever vocabulary it needs to describe the Symbols it finds. If Scala ships first with `fp:effect:io`, a later Rust plugin might reach for a different framing (`fp:async` outside the `fp:effect` namespace, say) and the diff behavior between the two would become inconsistent — a diff report on a mixed codebase would look different depending on which subset of files changed. Locking the vocabulary up front avoids that fragmentation.

### 11.2 Why one Symbol per ADT declaration instead of one per variant

Variants are structural, not behavioral: two ADTs with the same variant set are the same ADT. Emitting one Symbol per variant would double-count the type-level information, force downstream consumers to reassemble the variants back into a type, and interact awkwardly with fingerprinting (an api change on the ADT would fan out to many Symbol changes). The chosen model matches DataModel treatment in [ir-schema.md](./ir-schema.md) §5, keeping the mental model uniform.

### 11.3 Why exhaustiveness transitions are logic-not-api

An API contract describes what values callers can pass and what values they get back. Exhaustiveness describes what the Symbol does with those values internally — whether every case is handled or the compiler had to insert a fallthrough. That distinction is a control-flow property, exactly what the logic bucket in [fingerprint.md](./fingerprint.md) §3.2 exists to capture. Treating it as api would make an internal refactor (adding a missing case) appear as a signature change to every caller, which would be noisy and misleading.

### 11.4 Why `fp:effect` composes with concrete effects instead of replacing them

Two audiences read `effects[]`: an infrastructure reviewer scanning for `db.*` or `network.*` to sanity-check that new code touches the right systems, and a program-model reviewer scanning for effect wrappers to reason about referential transparency. Replacing the concrete effect with `fp:effect:io` would blind the infrastructure reviewer; omitting `fp:effect:io` would blind the program-model reviewer. Emitting both preserves both signals and costs one extra entry per wrapped effect — a trivial size increase.

### 11.5 Why reserve `fp:typeclass` and `fp:hkt` now

These are the two next-most-common FP concepts after ADT / match / effect. A first-mover plugin that decides to skip them today leaves the door open for a future plugin to add them — but only if the vocabulary framework hasn't already given `fp:typeclass` to some unrelated feature. Reserving them now costs nothing (no code, no test) and prevents a future collision. The reservation is analogous to how Unicode reserves code-point blocks ahead of allocation.
