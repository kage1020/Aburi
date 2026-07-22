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

Rule L-1 (language token ownership): each `<language>` token is exclusively owned by exactly one language plugin. The token is declared in the plugin's manifest (short-form id: `ts`, `tsx`, `js`, `py`, `go`, `rs`, `scala`, ...). Two plugins declaring the same token is a startup error, resolved the same way [extension-vocab.md](./extension-vocab.md) §5.3 resolves sub-namespace collisions: the run aborts with a manifest-conflict diagnostic pointing at both plugins.

Rule L-2 (well-known tokens): the following short-form tokens are centrally reserved to their conventional languages and MAY NOT be re-owned: `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `rs`, `java`, `kt`, `scala`, `hs`, `rb`, `php`, `cs`, `swift`. This list is additive; a new mainstream language may extend it in a follow-up PR.

Rule L-3 (case sensitivity): language tokens are lowercase ASCII, `[a-z][a-z0-9]*`. `TS`, `TypeScript`, `ts_next` are not valid tokens.

## 3. Same-path, different-language files

A component may legitimately contain files with the same path stem in different languages: a codegen output `apps/api/proto.ts` alongside a generator source `apps/api/proto.py`, or a Node worker `queue.ts` beside a Python worker `queue.py` under one component root. Their Symbols share `<file-path>#<qname>` but differ in `<language>`:

```
ts:apps/api/queue.ts#Worker
py:apps/api/queue.py#Worker
```

These are distinct Symbols. No implicit link is formed between them. If they represent the same conceptual worker (one migrated to the other), that fact is expressed by an explicit Dependency edge with `via: "compose"` (unchanged from today's schema); Aburi does not infer it.

Rule L-4 (component languages): `components[].languages` is already `required: true` in [ir-schema.md](./ir-schema.md) §4. When it contains two or more tokens, the component's `roots[]` MAY hold files owned by any of them. Nothing about the component record changes; the array simply enumerates which language plugins participated.

Rule L-5 (unowned files): a file whose extension is not claimed by any registered language plugin (`.proto`, `.md`, `.sql`, `.yaml`, ...) is skipped during extraction. It is never given a Symbol ID under a synthetic language token. Downstream tools that need to reference such a file (e.g. a build config that consumes a `.proto`) do so via a bare path string in `dependencies[]`, not a Symbol ID.

## 4. Cross-language dependency edges

An edge whose `from` and `to` differ in the `<language>:` prefix is a **cross-language edge**. Section 5 explains why such an edge is never `via: "call"`. This section defines the three shapes it may take instead.

### 4.1 Detection signals

Cross-language edges are always inferred from string-level or import-graph signals — never from AST-level call resolution. The four supported signals are:

| Signal | Producer side | Consumer side | Emitted `via` |
| --- | --- | --- | --- |
| HTTP path literal | `fetch("/orders")`, `axios.post("/orders")` in TS | `@app.post("/orders")` (FastAPI), `mux.HandleFunc("/orders", ...)` (Go) | `http` |
| Event topic string | `queue.publish("order.paid", ...)` in TS | `@consumer("order.paid")` in Python, `NATS.subscribe("order.paid")` in Go | `event` |
| gRPC service + method | `client.OrderService.Create(...)` in any language | `service OrderService { rpc Create(...) }` in a `.proto`, implemented in the target language | `event` (see 4.2 note) |
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

- Cross-language edges MUST NOT contribute to Slice View's "changed logic" count. They surface in the `## Cross-language references` section of `diff.md` (see §8) but do not inflate the primary logic delta metric that slice-view.md §5 defines.
- Effect propagation stops at the language boundary (see §6).

## 5. Cross-language calls

A `via: "call"` edge whose `from` and `to` differ in the `<language>:` prefix is **forbidden**. This is a hard invariant, not a heuristic threshold:

1. `via: "call"` in [ir-schema.md](./ir-schema.md) §11 means "AST-level callee-of relationship". No untyped-tier resolver can produce this across languages — a TS `fetch()` is not calling a Python function in any AST sense; the call reaches an HTTP endpoint.
2. [call-resolution.md](./call-resolution.md) §7.3 already emits `null` for any candidate whose only match crosses language boundaries. This document reinforces that rule and adds: when the resolver produces `null`, the pipeline invokes the cross-language recognizer (§4.1); if a signal matches, an edge is emitted under `via: "http" | "event" | "sql" | "compose"` instead.
3. Rejecting `via: "call"` cross-language keeps the intra-language call graph clean: every symbol in `Symbol.calls[].resolved` has the same language as the enclosing Symbol.

Rule L-6: emission of a cross-language `via: "call"` edge is an extraction error. The scan aborts with a diagnostic naming the two Symbol IDs.

## 6. Effect propagation across languages

[effect-propagation.md](./effect-propagation.md) §11.4 defers this to the present document. The rule is:

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

[slice-view.md](./slice-view.md) §14.13 defers this to the present document. The rule is:

Rule L-8 (disjoint per-language slices): a PR that touches Symbols in multiple languages produces one Slice View section per language, in the same `diff.md`, headed by a divider:

```
## ts
<intra-ts slices, exactly as slice-view.md §5 defines>

## py
<intra-py slices>

## Cross-language references
<summary table of cross-language edges added/removed in this PR>
```

Rationale:

- A single merged slice would need a cluster algorithm that spans language-specific graph structures — the two intra-language graphs are computed independently and have no shared vertex.
- Reviewers navigate per-language sections faster than one merged section; the mental model matches how PRs are usually authored (frontend change + backend change in the same PR).
- The final `## Cross-language references` block gives reviewers a compact index of the edges that cross the boundary — the review signal most likely to require both-side attention.

Cross-language edges MUST appear in the `## Cross-language references` block; they MUST NOT appear inside a per-language slice's edge list. This preserves the invariant that a per-language slice can be read without loading the other language's IR.

## 9. Public API globs across languages

`components[].publicApi` MAY contain glob patterns or Symbol IDs. When a component has `languages: ["ts", "py"]`, its `publicApi[]` MAY mix entries owned by both languages:

```jsonc
{
  "id": "billing",
  "languages": ["ts", "py"],
  "publicApi": [
    "ts:apps/billing/**#*",
    "py:apps/billing_worker/**#*"
  ]
}
```

Each entry's `<language>:` prefix routes glob expansion to the owning language plugin. There is no way to write a language-agnostic public-API entry; the prefix is mandatory. Rationale: a plugin knows how to resolve `#*` against its own file conventions; a language-agnostic entry would leak plugin internals into the config schema.

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

Rule L-9: no per-language section of the config controls cross-language behavior. Cross-language settings live at the top level so that adding a new language plugin does not require touching cross-language config.

## 11. Verifiable Properties

| ID | Input | Expected |
| --- | --- | --- |
| ML1 | Two plugins both declare `language: "py"` in their manifests | Startup aborts with manifest-conflict diagnostic naming both plugins |
| ML2 | Plugin declares `language: "TS"` (uppercase) | Manifest rejected with "language token must match `[a-z][a-z0-9]*`" |
| ML3 | Files `foo/bar.ts` and `foo/bar.py` both define a symbol `Baz` | Two Symbols emitted: `ts:foo/bar.ts#Baz` and `py:foo/bar.py#Baz`, both present in `symbols[]` |
| ML4 | Component with `languages: ["ts", "py"]`, roots contain both languages | Component record emitted with `languages: ["ts", "py"]`; both language plugins participate in extraction |
| ML5 | TS `fetch("/orders")` and Python `@app.post("/orders")` in the same scan | Dependency edge emitted `{from: <ts-caller-id>, to: <py-handler-id>, via: "http", direction: "outbound"}` |
| ML6 | TS `fetch("/unknown-path")` with no matching Python handler | Dependency edge emitted with `to: "/unknown-path"` (bare string), `via: "http"`, no error |
| ML7 | Cross-language edge produced with `via: "call"` (by a buggy plugin) | Extraction error, scan aborts, diagnostic names both endpoints |
| ML8 | TS caller does `fetch("/pay")` where Python `/pay` handler internally does `db.query` | Caller's `effects[]` contains `network.http`; does NOT contain `db.query` |
| ML9 | Symbol `ts:foo/bar.ts#Baz` removed; symbol `py:foo/bar.py#Baz` added in same PR | Diff surfaces one remove + one add; no `renamed` marker; no `movedFile` marker |
| ML10 | PR touches symbols in both TS and Python | `diff.md` has `## ts` and `## py` slice sections plus `## Cross-language references` summary |
| ML11 | Cross-language edge added in PR | Edge appears under `## Cross-language references`, NOT inside any per-language slice's edge list |
| ML12 | Cross-language edge added in PR | Slice View "changed logic" count on either language slice is unaffected by the edge |
| ML13 | `crossLanguage.enabled: false` and both ends of an HTTP signal exist | No cross-language edge emitted; per-language analysis unchanged |
| ML14 | `components[].publicApi` contains `"apps/billing/**#*"` (no language prefix) | Config rejected with "public-API entries must carry a `<language>:` prefix" |

## 12. Design Decisions

### 12.1 Why keep the `<language>:` prefix instead of adding a separate `namespace` field

The prefix is already the collision boundary in [ir-schema.md](./ir-schema.md) §3. Adding a parallel `namespace` field would duplicate the information, force every consumer to consult both fields, and open the door to schema drift (namespace and prefix out of sync). Since the prefix already works cross-language, the correct move is to document that it does and move on.

### 12.2 Why forbid cross-language `via: "call"`

`call` is defined semantically as an AST callee-of relationship. No untyped-tier analysis can prove that relationship across a language boundary — the actual mechanism is HTTP, an event bus, a shared database, or a shell exec, and each has a more precise `via` value. Allowing `call` cross-language would let two plugins encode the same relationship two different ways (one as `call`, the other as `http`) and destroy diff comparability.

### 12.3 Why exclude cross-language rename tracking

Cross-language rename detection requires a heuristic that matches Symbol IDs that share nothing but a suffix. Every candidate heuristic (name equality, shape similarity, adjacent-in-imports) breaks on realistic corner cases and introduces non-determinism. The alternative — reporting a remove + add — is honest about the fact that two physically distinct Symbols exist, and PR reviewers already accept this framing in monolingual codebases (e.g. deleting a class in one file and adding a new one in another).

### 12.4 Why disjoint slices instead of merged

The intra-language call graphs used to build slices have no shared vertex. Merging them would require inventing pseudo-edges between per-language nodes (typically at HTTP/event boundaries), which is exactly the information the `## Cross-language references` block already conveys — with the added benefit that reviewers see it as a summary table rather than a cluster with mixed-language nodes. Disjoint slices also make per-language re-scan cheap: changing only Python does not require re-clustering TS.

### 12.5 Why unidirectional effect propagation across languages

Bidirectional propagation would require an oracle that already knows the receiver's full effect closure at caller-side propagation time. That oracle does not exist in the untyped tier and would need to be built as a second pass. Even with the pass, the aggregated set would double-count (both sides own their effects) and would explode in hub services. Keeping propagation intra-language means each Symbol's `effects[]` describes what that Symbol does — a stronger, more compositional guarantee than "what its downstream services do".

### 12.6 Why the config surface is only two knobs

Every other cross-language behavior is either a hard invariant (no `via: "call"`, no rename tracking, disjoint slices) that MUST NOT vary by project, or a per-plugin concern (which HTTP client to recognize) that the plugin already owns. Leaving only the top-level enable flag and the OpenAPI opt-in keeps multi-language configuration from becoming a matrix of per-language cross-language settings.
