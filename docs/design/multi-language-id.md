# Multi-language Symbol ID and Cross-language References

This document specifies how Aburi keeps Symbol identifiers unique when a single monorepo contains files from multiple languages, and how references that cross a language boundary are represented in the IR. It is the design contract that every language plugin (`@aburi/lang-typescript`, `@aburi/lang-python`, `@aburi/lang-go`, ...) will implement against once the "Later" phase begins. The IR schema and CLI flags do not change; this document specifies the semantics of features they already accommodate.

## References:

- [ir-schema.md](./ir-schema.md) §3 — the Symbol ID grammar (`<language>:<file>#<qname>`).
- [ir-schema.md](./ir-schema.md) §4 — the Component record and its `languages` array.
- [ir-schema.md](./ir-schema.md) §11 — the Dependency record and the `via` enum.
- [call-resolution.md](./call-resolution.md) §7.3 — the current cross-language deferral (resolver emits `null`).
- [call-resolution.md](./call-resolution.md) §11.4 — rationale for cross-language resolution living in core.
- [effect-propagation.md](./effect-propagation.md) §3 — the intra-language propagation model.
- [effect-propagation.md](./effect-propagation.md) §11.4, PR11 — the cross-language propagation deferral.
- [slice-view.md](./slice-view.md) §5.5, §14.13, SV21 — the cross-language slice deferral.
- [fingerprint.md](./fingerprint.md) §3.1, A13 — `language` is not part of the api fingerprint input.
- [extension-vocab.md](./extension-vocab.md) §5 — namespace ownership rules that this document reuses for language tokens.
- [component-detect.md](./component-detect.md) §11 — component detection is per-language today.
- [roadmap.md](../roadmap.md) — Later: multi-language.

---

## 1. Purpose

Aburi's roadmap Later phase adds Python and Go language plugins, extended effect plugins, and functional-language proofs of concept. From that point on the IR describes symbols drawn from **more than one language at the same time**. Three things must be locked before the first non-TypeScript plugin ships:

1. Symbol IDs from different languages must never collide, even when files share a path stem.
2. References that cross a language boundary (a TypeScript service calling a Python HTTP handler, a Go worker consuming a Node-published event) must have a single, canonical representation in `dependencies[]`.
3. Fingerprint stability, effect propagation, and Slice View composition all have well-defined behavior at the language boundary — none of them attempt to reason across it in a way that undermines determinism.

This document specifies those three things and the minimum configuration surface a project needs to enable them. It does **not** introduce a new IR schema version; the shape already accommodates everything below.

Scope boundary: everything in this document is untyped-tier semantics. A future typed-tier (compiler-assisted) cross-language resolver is explicitly out of scope; when it lands, it will be additive.

## 2. Symbol ID under multiple languages

The Symbol ID grammar in [ir-schema.md](./ir-schema.md) §3 is:

```
<language>:<file-path>#<qualified-name>
```

The `<language>` token is the namespace boundary between languages. Two Symbols whose IDs differ only in `<language>` are two distinct Symbols with no implied relationship. The IR schema already treats them as such — `symbols[].id` is the primary key, and `dependencies[].from`/`to` are foreign keys into it.

Rule L-1 (language token ownership): each `<language>` token is exclusively owned by exactly one language plugin. The token is declared as `LanguagePlugin.languageId` (short-form id: `ts`, `tsx`, `js`, `py`, `go`, `rs`, `scala`, ...) — deliberately not the manifest `name`, which is a plugin ref (`lang-typescript`) resolved as a module specifier and outside the `LanguageId` grammar of Rule L-3. Two plugins declaring the same token is a startup error, following the general duplicate-declaration behavior of [extension-vocab.md](./extension-vocab.md) §6.1: the run aborts with a manifest-conflict diagnostic pointing at both plugins. Ownership semantics reuse the exclusive sub-namespace framework of [extension-vocab.md](./extension-vocab.md) §5.3.

Rule L-2 (well-known tokens): the following short-form tokens are centrally reserved to their conventional languages and MAY NOT be re-owned: `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `rs`, `java`, `kt`, `scala`, `hs`, `rb`, `php`, `cs`, `swift`. This list is additive; a new mainstream language may extend it in a follow-up PR.

Rule L-3 (case sensitivity): language tokens are lowercase ASCII, `[a-z][a-z0-9]*`. `TS`, `TypeScript`, `ts_next` are not valid tokens.

Rule L-11 (reserved namespaces): a language token MUST NOT collide with a token Aburi already uses to prefix a different kind of identifier. Today the reserved list is exactly `slice`, because a Slice id is `"slice:" + <anchor Symbol id>` ([slice-view.md](./slice-view.md) §7.1): a `slice` language plugin would mint Symbol ids indistinguishable from Slice ids, and deriving a Slice id from one of them would produce `slice:slice:…`. `makeSymbolId` in `@aburi/core` rejects the token at construction, and `checkIRIntegrity` rejects it in a document it did not build (invariant #16 in [ir-schema.md](./ir-schema.md) §14). The list is additive: a future id kind that takes a `<prefix>:` of its own extends it in the same PR that introduces the prefix.

Prefix collisions do not count — `slicer` is a legal token. Only the whole token is reserved.

## 3. Same-path, different-language files

A component may legitimately contain files with the same path stem in different languages: a codegen output `apps/api/proto.ts` alongside a generator source `apps/api/proto.py`, or a Node worker `queue.ts` beside a Python worker `queue.py` under one component root. Their Symbols share `<file-path>#<qname>` but differ in `<language>`:

```
ts:apps/api/queue.ts#Worker
py:apps/api/queue.py#Worker
```

These are distinct Symbols. No implicit link is formed between them. If they represent the same conceptual worker (one migrated to the other), that fact is expressed by an explicit Dependency edge with `via: "compose"` (unchanged from today's schema); Aburi does not infer it.

Rule L-4 (component languages): `components[].languages` is already `required: true` in [ir-schema.md](./ir-schema.md) §4. When it contains two or more tokens, the component's `roots[]` MAY hold files owned by any of them. Nothing about the component record changes; the array simply enumerates which language plugins participated.

Rule L-5 (unowned files): a file whose extension is not claimed by any registered language plugin (`.proto`, `.md`, `.sql`, `.yaml`, ...) is skipped during extraction. It is never given a Symbol ID under a synthetic language token. Downstream tools that need to reference such a file (e.g. a build config that consumes a `.proto`) do so via a bare path string in `dependencies[]`, not a Symbol ID. Nothing emits such an endpoint today, and the `DependencyEndpoint` type is correspondingly `SymbolId | ComponentId` ([ir-schema.md](./ir-schema.md) §3.5); the first producer of a path-shaped endpoint extends that union in the same PR, so the type keeps naming exactly what the array can hold.

## 4. Cross-language dependency edges

An edge whose `from` and `to` differ in the `<language>:` prefix is a **cross-language edge**. Section 5 explains why such an edge is never `via: "call"`. This section defines the three shapes it may take instead.

### 4.1 Detection signals

Cross-language edges are always inferred from string-level or import-graph signals — never from AST-level call resolution. The four supported signals are:

| Signal | Producer side | Consumer side | Emitted `via` |
| --- | --- | --- | --- |
| HTTP path literal | `fetch("/orders")`, `axios.post("/orders")` in TS | `@app.post("/orders")` (FastAPI), `mux.HandleFunc("/orders", ...)` (Go) | `http` |
| Event topic string | `queue.publish("order.paid", ...)` in TS | `@consumer("order.paid")` in Python, `NATS.subscribe("order.paid")` in Go | `event` |
| gRPC service + method | `client.OrderService.Create(...)` in any language | `service OrderService { rpc Create(...) }` in a `.proto`, implemented in the target language | `http` (grouped with HTTP per §4.2) |
| Shell exec of a script | `execFile("scripts/backfill.py")` in TS | The invoked file's top-level Symbol | `compose` |

The signals above are the union of what today's `@aburi/effects-*` plugins already extract; this document does not add a new extractor category. It only says: **when both ends of one of these signals are discovered in different languages, an edge is emitted**.

### 4.2 Representation in `dependencies[]`

Cross-language edges MUST use `via` values already in the [ir-schema.md](./ir-schema.md) §11 enum (`import | call | inherit | implement | compose | http | event | sql`). No new enum value is introduced.

- `via: "call"` is **forbidden** for cross-language edges (see §5).
- `via: "http"` covers direct HTTP calls, REST clients, and gRPC (grouped under `http` for consistency with the existing effect-plugin vocabulary; a future refinement MAY split gRPC out under a distinct effect id, but the `via` enum stays the same).
- `via: "event"` covers pub/sub topics.
- `via: "sql"` covers shared database references (a Python worker writing rows that a TS reader reads).
- `via: "compose"` covers script-invocation and any other whole-program composition signal.

Endpoint kinds are unchanged from today: at least one side is a Symbol ID; the other side MAY be a bare string (route path, topic name, table name). The bare-string side means "some endpoint exists here but no Symbol resolves to it in this scan". If a later scan discovers the matching Symbol in the other language, the edge upgrades to Symbol-to-Symbol without changing shape.

### 4.3 Directionality

The caller side always emits the edge with `direction: "outbound"`. The receiver side never infers a reciprocal `direction: "inbound"` edge; that would double-count the same relationship. Slice View and Markdown projection already treat these edges as directed from the caller's perspective and this rule preserves that.

### 4.4 Confidence and downstream weighting

Cross-language edges carry lower semantic confidence than an intra-language `via: "call"` — the match is string-level, not AST-level. Two downstream rules follow:

- Cross-language edges do participate in Slice View's WCC clustering (see §8) exactly like any other Dependency edge — [slice-view.md](./slice-view.md) §14.13 already commits to that behavior — but they do not by themselves count as a "changed logic" delta on the endpoint Symbols, because the change is on the edge, not on the Symbol body. Rendering conventions for cross-language edges are captured in §8.
- Effect propagation stops at the language boundary (see §6).

## 5. Cross-language calls

A `via: "call"` edge whose `from` and `to` differ in the `<language>:` prefix is **forbidden**. This is a hard invariant, not a heuristic threshold:

1. `via: "call"` in [ir-schema.md](./ir-schema.md) §11 means "AST-level callee-of relationship". No untyped-tier resolver can produce this across languages — a TS `fetch()` is not calling a Python function in any AST sense; the call reaches an HTTP endpoint.
2. [call-resolution.md](./call-resolution.md) §7.3 already emits `null` for any candidate whose only match crosses language boundaries. This document reinforces that rule and adds: when the resolver produces `null`, the pipeline invokes the cross-language recognizer (§4.1); if a signal matches, an edge is emitted under `via: "http" | "event" | "sql" | "compose"` instead.
3. Rejecting `via: "call"` cross-language keeps the intra-language call graph clean: every symbol in `Symbol.calls[].resolved` has the same language as the enclosing Symbol.

Rule L-6: emission of a cross-language `via: "call"` edge is an extraction error. The scan aborts with a diagnostic naming the two Symbol IDs.

## 6. Effect propagation across languages

[effect-propagation.md](./effect-propagation.md) §3 defers this to the present document (see also §11.4 PR11, which describes the current pre-defer behavior). The rule is:

Rule L-7 (unidirectional propagation): propagation walks the intra-language call graph only. A cross-language edge from §4 carries the **caller side's own effects** into the caller's `effects[]` (via the normal producer-side effect extractor); it does **not** inject the receiver's effects back into the caller.

Concretely, a TS handler that does `fetch("/pay", ...)` picks up `network.http` (the effect the effect-plugin attaches to `fetch`); it does **not** inherit whatever `db.query` calls the Python `/pay` endpoint makes internally. Rationale:

- The receiver's effect set is discovered in a separate pass, on the receiver side.
- Injecting it back through a cross-language edge would double-count (both sides own their share) and would explode effect sets in hub components that talk to many downstream services.
- Determinism: injection would require a resolved topology at effect-propagation time; the untyped tier cannot guarantee such a topology exists.

If a future consumer needs the aggregated cross-service effect set, it is derived from the receiver-side propagation results at read time, not baked into `effects[]`.

## 7. Fingerprint stability

### 7.1 No cross-language rename tracking

A Symbol whose file moves from `foo/bar.ts` to `foo/bar.py` — or whose language changes for any other reason — surfaces as a **remove** of the TS Symbol plus an **add** of the Python Symbol. It is never marked as `renamed`, `movedFile`, or `changed`.

### 7.2 Justification

[fingerprint.md](./fingerprint.md) §3.1 already excludes `language` from the api fingerprint input (test A13). The exclusion holds because within one Symbol ID, `language` is invariant — a Symbol's language never changes across scans. Introducing a cross-language rename heuristic would require matching Symbols with different IDs by prose signals (name similarity, shape similarity), and every such heuristic:

- Is non-deterministic under corner cases (two Python Symbols with the same name as a removed TS Symbol).
- Violates the byte-identical output invariant that [call-resolution.md](./call-resolution.md) CR24 and this document's sibling [performance.md](./performance.md) §7 both require.
- Adds a surprising diff category that PR reviewers would need to learn.

The simple add+remove behavior is the correct one: it reflects that the two Symbols are physically distinct, and the PR description tells the human reviewer that the rewrite is a migration.

## 8. Slice View composition

[slice-view.md](./slice-view.md) §14.13 defers cross-language slice composition to the present document with a specific commitment: once cross-language edges exist, "Slice View will then automatically produce cross-language clusters via the same WCC rule with no code change." This document honours that commitment.

Rule L-8 (unified WCC clustering, no bespoke rule): cross-language edges from §4 participate in Slice View's Weakly-Connected-Components clustering exactly as intra-language edges do. There is no per-language partitioning, no special disjoint-slice mode, and no additional connectivity heuristic. A slice may contain Symbols from more than one language when cross-language edges tie them together; a slice contains one language only when the WCC subgraph happens to be single-language.

Rendering conventions in `diff.md`:

- The slice header of a multi-language slice tags the languages present in it (e.g. `## slice: billing-order-flow (ts, py)`), so a reviewer sees the mixed shape at a glance.
- Within a multi-language slice, Symbol entries are grouped by `<language>` in the same order as the workspace's `languages[]` array ([ir-schema.md](./ir-schema.md) §2). Grouping is a rendering choice; the slice's WCC identity is unchanged.
- Each cross-language edge is rendered with a `↔ <lang>` glyph on the edge label so the language boundary is visible without loading the endpoints.
- `diff.md` MAY include an optional final `## Cross-language references` summary block that indexes all cross-language edges added or removed in the PR. This block is a review aid; it never replaces the WCC-based slice listing above it.

Rationale:

- [slice-view.md](./slice-view.md) §14.13 pre-committed to "same WCC rule, no code change". Introducing a per-language partition here would either force a slice-view rewrite or leave two spec docs in direct conflict.
- The WCC rule already handles the disjoint case: when no cross-language edge exists, the graph naturally partitions by language and each slice is single-language. No special mode is needed.
- Reviewers who work primarily in one language can still filter the mixed slice via the per-language grouping inside it; the `↔ <lang>` glyphs make the crossings scannable.

## 9. Public API globs across languages

`components[].publicApi` MAY contain glob patterns or Symbol IDs, as defined by [ir-schema.md](./ir-schema.md) §4. This document does not change that rule. Under multi-language components, both entry forms coexist:

```jsonc
{
  "id": "billing",
  "languages": ["ts", "py"],
  "publicApi": [
    "apps/billing/src/routes/**",              // plain glob — canonical form per ir-schema §4
    "apps/billing_worker/**/*.py",             // plain glob — resolves against the workspace root
    "ts:packages/billing-domain/src/index.ts#Invoice",  // Symbol ID — carries the language prefix (ir-schema §3)
    "py:apps/billing_worker/src/main.py#run"
  ]
}
```

Rule L-9 (interpretation, not a new constraint):

- **Glob entries** resolve against workspace-relative file paths and are language-agnostic. A glob may legitimately match files owned by more than one language plugin; each match is then owned by whichever language plugin claims the file. This is unchanged from single-language use.
- **Symbol ID entries** always carry a `<language>:` prefix per [ir-schema.md](./ir-schema.md) §3. Under multi-language components the prefix distinguishes which language's Symbol is being exported.

Rationale: `ir-schema.md` §4 explicitly documents the glob form without a language prefix as canonical (`"apps/billing/src/routes/**"`). This document does not tighten that surface.

## 10. Configuration surface

Multi-language monorepos require exactly two new optional config knobs. Everything else derives from the per-plugin configuration that already exists.

```jsonc
{
  "crossLanguage": {
    "enabled": true,
    "httpMatch": {
      "headerFingerprint": false
    }
  }
}
```

- `crossLanguage.enabled` (default `true`): when `false`, the cross-language recognizer (§4.1) is skipped and no cross-language edges are emitted. Useful for large monorepos where only intra-language analysis is wanted (e.g. a monorepo containing three independent services).
- `crossLanguage.httpMatch.headerFingerprint` (default `false`): opt-in for OpenAPI-schema-based HTTP matching. When both a producer and consumer expose a matching OpenAPI schema, the fingerprint of the schema is used to raise confidence on the edge. Implementation of this knob is deferred to a follow-up PR; the config key is reserved here so the surface is stable when it lands.

Rule L-10 (config surface locality): no per-language section of the config controls cross-language behavior. Cross-language settings live at the top level so that adding a new language plugin does not require touching cross-language config.

## 11. Verifiable Properties

| ID | Input | Expected |
| --- | --- | --- |
| ML1 | Two plugins both declare `languageId: "py"` | Startup aborts with manifest-conflict diagnostic naming both plugins |
| ML2 | Plugin declares `language: "TS"` (uppercase) | Manifest rejected with "language token must match `[a-z][a-z0-9]*`" |
| ML3 | Files `foo/bar.ts` and `foo/bar.py` both define a symbol `Baz` | Two Symbols emitted: `ts:foo/bar.ts#Baz` and `py:foo/bar.py#Baz`, both present in `symbols[]` |
| ML4 | Component with `languages: ["ts", "py"]`, roots contain both languages | Component record emitted with `languages: ["ts", "py"]`; both language plugins participate in extraction |
| ML5 | TS `fetch("/orders")` and Python `@app.post("/orders")` in the same scan | Dependency edge emitted `{from: <ts-caller-id>, to: <py-handler-id>, via: "http", direction: "outbound"}` |
| ML6 | TS `fetch("/unknown-path")` with no matching Python handler | Dependency edge emitted with `to: "/unknown-path"` (bare string), `via: "http"`, no error |
| ML7 | Cross-language edge produced with `via: "call"` (by a buggy plugin) | Extraction error, scan aborts, diagnostic names both endpoints |
| ML8 | TS caller does `fetch("/pay")` where Python `/pay` handler internally does `db.query` | Caller's `effects[]` contains `network.http`; does NOT contain `db.query` |
| ML9 | Symbol `ts:foo/bar.ts#Baz` removed; symbol `py:foo/bar.py#Baz` added in same PR | Diff surfaces one remove + one add; no `renamed` marker; no `movedFile` marker |
| ML10 | PR touches Symbols in both TS and Python with a cross-language edge between them | Symbols land in ONE WCC-based slice; slice header tags `(ts, py)` per Rule L-8 |
| ML11 | PR touches TS and Python Symbols but no cross-language edge between them | WCC partitions naturally by language; two single-language slices emitted; no bespoke rule needed |
| ML12 | Cross-language edge added in PR | Edge participates in WCC clustering; the endpoint Symbols themselves do not gain a "changed logic" delta just from the edge (§4.4) |
| ML13 | `crossLanguage.enabled: false` and both ends of an HTTP signal exist | No cross-language edge emitted; per-language analysis unchanged |
| ML14 | `components[].publicApi` contains `"apps/billing/src/routes/**"` (glob, no prefix) — the canonical form from [ir-schema.md](./ir-schema.md) §4 | Accepted; each matched file is owned by whichever language plugin claims it |
| ML15 | `components[].publicApi` contains `"apps/billing/src/index.ts#Invoice"` (Symbol ID without `<language>:` prefix) | Rejected — Symbol IDs MUST carry the language prefix per [ir-schema.md](./ir-schema.md) §3 (unchanged from single-language) |
| ML16 | `makeSymbolId({ language: "slice", … })` | Rejected with `invalid-language-id`; the message names the reservation rather than the pattern (Rule L-11) |
| ML17 | `makeSymbolId({ language: "slicer", … })` | Accepted — only the whole token is reserved, not the prefix (Rule L-11) |
| ML18 | An IR read from disk contains `symbols[].id` of `"slice:src/a.ts#foo"` | `checkIRIntegrity` reports invariant #16; the run aborts rather than deriving `slice:slice:src/a.ts#foo` in Slice View |

## 12. Design Decisions

### 12.1 Why keep the `<language>:` prefix instead of adding a separate `namespace` field

The prefix is already the collision boundary in [ir-schema.md](./ir-schema.md) §3. Adding a parallel `namespace` field would duplicate the information, force every consumer to consult both fields, and open the door to schema drift (namespace and prefix out of sync). Since the prefix already works cross-language, the correct move is to document that it does and move on.

### 12.2 Why forbid cross-language `via: "call"`

`call` is defined semantically as an AST callee-of relationship. No untyped-tier analysis can prove that relationship across a language boundary — the actual mechanism is HTTP, an event bus, a shared database, or a shell exec, and each has a more precise `via` value. Allowing `call` cross-language would let two plugins encode the same relationship two different ways (one as `call`, the other as `http`) and destroy diff comparability.

### 12.3 Why exclude cross-language rename tracking

Cross-language rename detection requires a heuristic that matches Symbol IDs that share nothing but a suffix. Every candidate heuristic (name equality, shape similarity, adjacent-in-imports) breaks on realistic corner cases and introduces non-determinism. The alternative — reporting a remove + add — is honest about the fact that two physically distinct Symbols exist, and PR reviewers already accept this framing in monolingual codebases (e.g. deleting a class in one file and adding a new one in another).

### 12.4 Why unified WCC clustering instead of disjoint per-language slices

[slice-view.md](./slice-view.md) §14.13 pre-committed to "same WCC rule, no code change" once cross-language edges exist. This document honours that commitment. Introducing a bespoke per-language partitioning rule would either force a slice-view rewrite or leave two design docs in direct conflict. The WCC rule also degrades gracefully — when no cross-language edge exists the WCC naturally partitions by language, so there is no cost to reviewers of single-language PRs. Multi-language slices are labelled and grouped for scannability without changing their identity.

### 12.5 Why unidirectional effect propagation across languages

Bidirectional propagation would require an oracle that already knows the receiver's full effect closure at caller-side propagation time. That oracle does not exist in the untyped tier and would need to be built as a second pass. Even with the pass, the aggregated set would double-count (both sides own their effects) and would explode in hub services. Keeping propagation intra-language means each Symbol's `effects[]` describes what that Symbol does — a stronger, more compositional guarantee than "what its downstream services do".

### 12.6 Why the config surface is only two knobs

Every other cross-language behavior is either a hard invariant (no `via: "call"`, no rename tracking, disjoint slices) that MUST NOT vary by project, or a per-plugin concern (which HTTP client to recognize) that the plugin already owns. Leaving only the top-level enable flag and the OpenAPI opt-in keeps multi-language configuration from becoming a matrix of per-language cross-language settings.
